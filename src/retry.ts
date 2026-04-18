// src/retry.ts — retry policy shared by all Client HTTP calls.

/** Parameters for {@link computeBackoffMs}. */
export type BackoffParams = {
  /** Zero-based attempt index: 0 for the first retry, 1 for the second, ... */
  attempt: number;
  /** Base delay applied to attempt 0, in ms. */
  baseMs: number;
  /** Upper bound on the backoff delay, in ms. */
  maxMs: number;
  /** Optional random source in [0, 1). Defaults to Math.random. Injected in tests. */
  random?: () => number;
};

/**
 * Exponential backoff with full jitter (AWS Architecture Blog, "Exponential
 * Backoff And Jitter"). Returns a delay in [0, min(maxMs, baseMs * 2^attempt)).
 * Full jitter is the boring, well-documented default — it produces a wider
 * spread than "equal jitter" and avoids thundering-herd retries at cold-start.
 */
export function computeBackoffMs(p: BackoffParams): number {
  const random = p.random ?? Math.random;
  const cap = Math.min(p.maxMs, p.baseMs * 2 ** p.attempt);
  return Math.floor(random() * cap);
}

/**
 * Parse a server-supplied `Retry-After` header. Supports both the delta-seconds
 * form (RFC 7231 §7.1.3) and the HTTP-date form. Returns ms, or `null` if the
 * header is absent or malformed.
 */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - now);
  }

  return null;
}

/** Returns true when the HTTP status should trigger a retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Sleep helper that cooperates with an optional AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
