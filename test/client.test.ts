// test/client.test.ts — unit tests for the Hashline SDK Client.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  Client,
  MAX_BATCH_SIZE,
  NetworkError,
  ValidationError,
} from "../src/index.js";
import type { EventInput } from "../src/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

const RUN_ID = "run_01HXYZ123ABC456DEF789GH";
const EVT_ID = "evt_01HXYZAAAABBBBCCCCDDDDEE";

function makeEvent(overrides: Partial<EventInput> = {}): EventInput {
  return {
    run_id: RUN_ID,
    type: "tool_call",
    actor: { type: "agent", id: "agent_test" },
    payload: { name: "search", arguments: {}, call_id: "c1" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeClient(opts: {
  fetch: typeof fetch;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  enabled?: boolean;
}): Client {
  return new Client({
    apiKey: "al_test_abcdef",
    baseUrl: "https://api.example.test/v1",
    fetch: opts.fetch,
    maxRetries: opts.maxRetries ?? 2,
    baseRetryDelayMs: opts.baseRetryDelayMs ?? 1,
    maxRetryDelayMs: 5,
    random: () => 0,
    enabled: opts.enabled ?? true,
  });
}

describe("Client construction", () => {
  it("throws when enabled but apiKey missing", () => {
    expect(() => new Client({})).toThrow(ValidationError);
  });

  it("allows no apiKey when disabled", () => {
    expect(() => new Client({ enabled: false })).not.toThrow();
  });
});

describe("Client.event happy path", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("POSTs to /events with bearer auth + JSON body", async () => {
    const ack = { id: EVT_ID, run_id: RUN_ID, seq: 0, hash: "sha256:abc" };
    fetchMock.mockResolvedValueOnce(jsonResponse(ack));
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.event(makeEvent());

    expect(result).toEqual(ack);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/events");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer al_test_abcdef");
    expect(headers["Content-Type"]).toContain("application/json");
    expect(headers["User-Agent"]).toContain("hashline-sdk-js/");
    const body = JSON.parse(init.body as string);
    expect(body.run_id).toBe(RUN_ID);
    expect(body.type).toBe("tool_call");
  });

  it("returns null when disabled and makes no network call", async () => {
    const client = new Client({ enabled: false, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.event(makeEvent());
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Client.event validation", () => {
  const noopFetch = vi.fn();

  it("rejects missing run_id", async () => {
    const c = makeClient({ fetch: noopFetch as unknown as typeof fetch });
    await expect(c.event({ ...makeEvent(), run_id: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(noopFetch).not.toHaveBeenCalled();
  });

  it("rejects missing actor", async () => {
    const c = makeClient({ fetch: noopFetch as unknown as typeof fetch });
    await expect(
      c.event({
        run_id: RUN_ID,
        type: "annotation",
        payload: {},
        // @ts-expect-error — testing runtime guard
        actor: undefined,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects missing payload key entirely", async () => {
    const c = makeClient({ fetch: noopFetch as unknown as typeof fetch });
    await expect(
      // @ts-expect-error — testing runtime guard
      c.event({ run_id: RUN_ID, type: "annotation", actor: { type: "agent", id: "x" } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Client retry behavior", () => {
  it("retries on 503 and then succeeds", async () => {
    const ack = { id: EVT_ID, run_id: RUN_ID, seq: 0, hash: "sha256:abc" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(ack));

    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch, maxRetries: 2 });
    const result = await client.event(makeEvent());
    expect(result).toEqual(ack);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 honoring Retry-After", async () => {
    const ack = { id: EVT_ID, run_id: RUN_ID, seq: 0, hash: "sha256:abc" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(jsonResponse(ack));

    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch, maxRetries: 1 });
    const result = await client.event(makeEvent());
    expect(result).toEqual(ack);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 400", async () => {
    const problem = {
      type: "about:blank",
      title: "invalid_event",
      status: 400,
      detail: "payload.call_id missing",
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(problem), {
        status: 400,
        headers: {
          "content-type": "application/problem+json",
          "x-request-id": "req_123",
        },
      }),
    );
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const err = await client.event(makeEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(400);
    expect((err as APIError).retryable).toBe(false);
    expect((err as APIError).requestId).toBe("req_123");
    expect((err as APIError).problem?.title).toBe("invalid_event");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404 (tenant isolation returns 404 per spec §9.3)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch });
    const err = await client.event(makeEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws APIError on persistent 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch, maxRetries: 2 });
    const err = await client.event(makeEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("retries on network error then throws NetworkError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch, maxRetries: 1 });
    const err = await client.event(makeEvent()).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 + 1 retry
  });
});

describe("Client.batch", () => {
  it("pins run_id on every batch item and POSTs to /events/batch", async () => {
    const ack = {
      run_id: RUN_ID,
      events: [
        { id: "evt_1", run_id: RUN_ID, seq: 0, hash: "sha256:a" },
        { id: "evt_2", run_id: RUN_ID, seq: 1, hash: "sha256:b" },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(ack));
    const client = makeClient({ fetch: fetchMock as unknown as typeof fetch });

    const result = await client.batch(RUN_ID, [
      { type: "prompt", actor: { type: "agent", id: "a" }, payload: { model: "m", content: "hi" } },
      { type: "completion", actor: { type: "agent", id: "a" }, payload: { model: "m", content: "hey" } },
    ]);

    expect(result).toEqual(ack);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/events/batch");
    const body = JSON.parse(init.body as string);
    expect(body.run_id).toBe(RUN_ID);
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e: { run_id: string }) => e.run_id === RUN_ID)).toBe(true);
  });

  it("rejects empty batch", async () => {
    const c = makeClient({ fetch: vi.fn() as unknown as typeof fetch });
    await expect(c.batch(RUN_ID, [])).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects batch over MAX_BATCH_SIZE", async () => {
    const c = makeClient({ fetch: vi.fn() as unknown as typeof fetch });
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({
      type: "annotation" as const,
      actor: { type: "agent" as const, id: "a" },
      payload: { key: "k", value: 1 },
    }));
    await expect(c.batch(RUN_ID, events)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects batch item whose run_id disagrees with batch runId", async () => {
    const c = makeClient({ fetch: vi.fn() as unknown as typeof fetch });
    await expect(
      c.batch(RUN_ID, [
        {
          // @ts-expect-error — testing runtime guard
          run_id: "run_other",
          type: "annotation",
          actor: { type: "agent", id: "a" },
          payload: {},
        },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns null when disabled", async () => {
    const fetchMock = vi.fn();
    const c = new Client({ enabled: false, fetch: fetchMock as unknown as typeof fetch });
    const result = await c.batch(RUN_ID, [
      { type: "annotation", actor: { type: "agent", id: "a" }, payload: {} },
    ]);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
