// src/client.ts — Hashline SDK Client. Ingests events into the audit ledger.

import { APIError, NetworkError, ValidationError } from "./errors.js";
import {
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
  sleep,
} from "./retry.js";
import type {
  BatchAck,
  BatchEventInput,
  EventAck,
  EventInput,
  ProblemJson,
} from "./types.js";

/** Max events allowed in a single batch call (spec §5.2). */
export const MAX_BATCH_SIZE = 500;

/** Default base URL for the hosted Hashline API. */
const DEFAULT_BASE_URL = "https://api.hashline.dev/v1";

/** Configuration for {@link Client}. */
export type ClientOptions = {
  /** API key with `events:write` scope. Required unless `enabled` is false. */
  apiKey?: string;
  /** Base URL, including the `/v1` prefix. Defaults to the hosted API. */
  baseUrl?: string;
  /**
   * Master telemetry switch. When `false`, every method is a silent no-op
   * returning `null` — intended for tests, local dev, and opt-out. Defaults
   * to `true`, or `false` when the env var `HASHLINE_DISABLED` is truthy.
   */
  enabled?: boolean;
  /** Override fetch for tests or alternate runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Max retry attempts after the initial try. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Default 250. */
  baseRetryDelayMs?: number;
  /** Cap on backoff delay, in ms. Default 10000. */
  maxRetryDelayMs?: number;
  /** Per-request timeout in ms (includes retries). Default 30000. */
  timeoutMs?: number;
  /** Custom User-Agent suffix, appended after the SDK identifier. */
  userAgent?: string;
  /** Injected clock for retry-after parsing. Tests only. */
  now?: () => number;
  /** Injected RNG for backoff jitter. Tests only. */
  random?: () => number;
};

/** Resolved, non-optional config used internally. */
type ResolvedOptions = {
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  fetch: typeof fetch;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  now: () => number;
  random: () => number;
};

const SDK_VERSION = "0.1.0";

/**
 * Client for the Hashline audit ledger.
 *
 * Construction does not make any network calls. Both {@link Client.event} and
 * {@link Client.batch} are safe to call concurrently; ordering within a run is
 * determined server-side by the Run Durable Object, not by call order here.
 *
 * When `enabled` is false, every method is a no-op returning `null`. This
 * allows callers to wire telemetry unconditionally and toggle it off in tests
 * or via an env flag without branching at every callsite.
 */
export class Client {
  private readonly opts: ResolvedOptions;

  constructor(options: ClientOptions = {}) {
    const envDisabled = readEnvFlag("HASHLINE_DISABLED");
    const enabled = options.enabled ?? !envDisabled;

    if (enabled && !options.apiKey) {
      throw new ValidationError(
        "Client requires `apiKey` when `enabled` is true",
      );
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (enabled && typeof fetchImpl !== "function") {
      throw new ValidationError(
        "No `fetch` implementation found. Pass `fetch` in options or run on Node >= 18.",
      );
    }

    this.opts = {
      apiKey: options.apiKey ?? "",
      baseUrl: trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL),
      enabled,
      fetch: fetchImpl ?? (globalThis.fetch as typeof fetch),
      maxRetries: options.maxRetries ?? 3,
      baseRetryDelayMs: options.baseRetryDelayMs ?? 250,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 10_000,
      timeoutMs: options.timeoutMs ?? 30_000,
      userAgent: buildUserAgent(options.userAgent),
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
    };
  }

  /** Whether telemetry is enabled for this Client instance. */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * Append a single event to a run. When telemetry is disabled, returns `null`
   * without performing any network I/O.
   *
   * @param input event envelope (see {@link EventInput})
   * @param signal optional AbortSignal; aborts both network and retry waits
   * @returns server acknowledgement, or `null` when disabled
   * @throws {@link ValidationError} for bad input; {@link APIError} for non-retryable HTTP errors
   *   or retries exhausted; {@link NetworkError} when the transport fails.
   */
  async event(
    input: EventInput,
    signal?: AbortSignal,
  ): Promise<EventAck | null> {
    if (!this.opts.enabled) return null;
    validateEventInput(input);
    return this.request<EventAck>("POST", "/events", input, signal);
  }

  /**
   * Append up to {@link MAX_BATCH_SIZE} events to a single run atomically.
   * All events MUST belong to `runId` — see spec §5.2.
   *
   * Events are appended in array order; the server assigns `seq` in that order.
   *
   * @returns `{run_id, events}` acknowledgement, or `null` when disabled
   */
  async batch(
    runId: string,
    events: BatchEventInput[],
    signal?: AbortSignal,
  ): Promise<BatchAck | null> {
    if (!this.opts.enabled) return null;
    validateBatch(runId, events);
    const body = {
      run_id: runId,
      events: events.map((e) => ({ ...e, run_id: runId })),
    };
    return this.request<BatchAck>("POST", "/events/batch", body, signal);
  }

  /**
   * Core request pipeline: serialises, sends, retries on 408/429/5xx + network
   * errors with exponential backoff + full jitter, honours `Retry-After`, and
   * propagates non-2xx responses as {@link APIError}.
   */
  private async request<T>(
    method: "POST" | "GET",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": this.opts.userAgent,
    };
    const payload: string | null =
      body === undefined ? null : JSON.stringify(body);

    // Single composite timeout covering all attempts. If the caller supplied
    // a signal, we compose it with our timeout signal.
    const controller = new AbortController();
    const timeoutTimer = setTimeout(
      () => controller.abort(new Error("request timeout")),
      this.opts.timeoutMs,
    );
    const onExternalAbort = () =>
      controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
        try {
          const response = await this.opts.fetch(url, {
            method,
            headers,
            body: payload,
            signal: controller.signal,
          });

          if (response.ok) {
            return (await response.json()) as T;
          }

          const apiErr = await buildApiError(response);
          if (!apiErr.retryable || attempt === this.opts.maxRetries) {
            throw apiErr;
          }
          lastError = apiErr;
          const retryAfter = parseRetryAfterMs(
            response.headers.get("retry-after"),
            this.opts.now(),
          );
          await sleep(this.nextDelay(attempt, retryAfter), controller.signal);
          continue;
        } catch (err) {
          if (err instanceof APIError) throw err;
          // AbortError — bubble up immediately; do not retry.
          if (isAbortError(err)) {
            throw new NetworkError(
              (err as Error).message || "request aborted",
              err,
            );
          }
          lastError = err;
          if (attempt === this.opts.maxRetries) {
            throw new NetworkError(
              `network request failed: ${errorMessage(err)}`,
              err,
            );
          }
          await sleep(this.nextDelay(attempt, null), controller.signal);
        }
      }
      // Unreachable: loop either returns or throws.
      throw new NetworkError(
        `retry loop exhausted: ${errorMessage(lastError)}`,
        lastError,
      );
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private nextDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null) {
      return Math.min(retryAfterMs, this.opts.maxRetryDelayMs);
    }
    return computeBackoffMs({
      attempt,
      baseMs: this.opts.baseRetryDelayMs,
      maxMs: this.opts.maxRetryDelayMs,
      random: this.opts.random,
    });
  }
}

function validateEventInput(input: EventInput): void {
  if (!input || typeof input !== "object") {
    throw new ValidationError("event input must be an object");
  }
  if (!input.run_id || typeof input.run_id !== "string") {
    throw new ValidationError("event.run_id is required and must be a string");
  }
  if (!input.type || typeof input.type !== "string") {
    throw new ValidationError("event.type is required and must be a string");
  }
  if (!input.actor || typeof input.actor !== "object") {
    throw new ValidationError("event.actor is required");
  }
  if (!input.actor.id || typeof input.actor.id !== "string") {
    throw new ValidationError("event.actor.id is required");
  }
  if (!input.actor.type || typeof input.actor.type !== "string") {
    throw new ValidationError("event.actor.type is required");
  }
  if (!("payload" in input)) {
    throw new ValidationError("event.payload is required (may be null)");
  }
}

function validateBatch(runId: string, events: BatchEventInput[]): void {
  if (!runId || typeof runId !== "string") {
    throw new ValidationError("batch requires a runId string");
  }
  if (!Array.isArray(events)) {
    throw new ValidationError("batch events must be an array");
  }
  if (events.length === 0) {
    throw new ValidationError("batch must contain at least one event");
  }
  if (events.length > MAX_BATCH_SIZE) {
    throw new ValidationError(
      `batch size ${events.length} exceeds max of ${MAX_BATCH_SIZE}`,
    );
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) {
      throw new ValidationError(`batch event at index ${i} is missing`);
    }
    // Ensure callers don't try to smuggle a different run_id into a batch item.
    if (
      "run_id" in e &&
      (e as Partial<EventInput>).run_id !== undefined &&
      (e as Partial<EventInput>).run_id !== runId
    ) {
      throw new ValidationError(
        `batch event at index ${i} has run_id that differs from batch runId`,
      );
    }
    validateEventInput({ ...e, run_id: runId } as EventInput);
  }
}

async function buildApiError(response: Response): Promise<APIError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let problem: ProblemJson | undefined;
  let message = `HTTP ${response.status} ${response.statusText}`.trim();
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as ProblemJson;
        if (parsed && typeof parsed === "object") {
          problem = parsed;
          if (parsed.title) message = parsed.title;
          if (parsed.detail) message = `${message}: ${parsed.detail}`;
        } else {
          message = `${message}: ${text}`;
        }
      } catch {
        message = `${message}: ${text}`;
      }
    }
  } catch {
    // Body read failure — keep the status-line message.
  }
  return new APIError({
    status: response.status,
    message,
    requestId,
    problem,
    retryable: isRetryableStatus(response.status),
  });
}

function buildUserAgent(suffix?: string): string {
  const base = `hashline-sdk-js/${SDK_VERSION}`;
  return suffix ? `${base} ${suffix}` : base;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function readEnvFlag(name: string): boolean {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
  const value = env?.[name];
  if (!value) return false;
  const normalised = value.toLowerCase();
  return normalised === "1" || normalised === "true" || normalised === "yes";
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
