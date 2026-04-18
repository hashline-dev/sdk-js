# Milestone 9 — TypeScript SDK v0.1

**Status:** complete.
**Spec reference:** `spec.md` §8 Milestone 9, §5 (API), §6 (auth/isolation), §9 (testing).

## What was built

A standalone TypeScript SDK package (`@hashline/sdk`) that wraps the Hashline
audit ledger v1 HTTP API. It implements the minimum required by Milestone 9 —
`Client`, `client.event(...)`, `client.batch(...)`, auto-retry on 5xx, no-op
when telemetry is disabled — plus the pieces any real SDK needs to be usable:
timeouts, typed errors, input validation, `Retry-After`, and an AbortSignal
path.

### Repo layout decision

`spec.md` §7 shows the SDK nested under `sdk/typescript/`. This repo
(`hashline-sdk-js`) is a dedicated SDK repo, so the SDK source lives at the
repo root rather than under `sdk/typescript/` — standard for single-package npm
repos and keeps import paths clean (`@hashline/sdk`, not
`@hashline/sdk/sdk/typescript`). If/when the server and SDK consolidate, the
source can be moved under `sdk/typescript/` without code changes.

### Files produced

```
package.json                 # npm manifest, ESM, Node ≥ 18
tsconfig.json                # strict: true, exactOptionalPropertyTypes, etc.
tsconfig.build.json          # emits dist/
vitest.config.ts
.gitignore
README.md                    # user-facing SDK docs
src/
├── index.ts                 # public barrel
├── client.ts                # Client class — event(), batch(), retry pipeline
├── errors.ts                # HashlineError / APIError / ValidationError / NetworkError
├── retry.ts                 # computeBackoffMs, parseRetryAfterMs, isRetryableStatus, sleep
└── types.ts                 # EventType, Actor, EventInput, EventAck, BatchAck, ProblemJson
test/
├── client.test.ts           # 18 tests — happy path, validation, retries, batch, no-op
└── retry.test.ts            # 10 tests — backoff math, retry-after parsing, status classification
examples/
└── basic.ts                 # e2e example against local dev worker + verify
```

## Behavior highlights

- **`client.event(input)`** — POSTs to `/v1/events` with Bearer auth; returns
  `{id, run_id, seq, hash}` per spec §5.2. When `enabled: false`, returns
  `null` and skips fetch entirely.
- **`client.batch(runId, events)`** — POSTs to `/v1/events/batch`, pins
  `run_id` on each item, validates ≤ `MAX_BATCH_SIZE` (500), rejects items
  whose `run_id` disagrees with the batch `runId`.
- **Retry policy:**
  - Retried: `408`, `429`, `5xx`, transport failures (TypeError / DNS / TCP /
    TLS / fetch rejection).
  - Not retried: `4xx` other than 408/429 (including `404`, which per spec §9.3
    is how tenant-isolation failures surface).
  - Backoff: exponential with full jitter (AWS pattern) capped at
    `maxRetryDelayMs`. `Retry-After` header overrides the computed backoff
    (both delta-seconds and HTTP-date forms).
  - `AbortSignal` short-circuits retries; abort produces `NetworkError`, not
    an infinite wait.
- **Validation** is synchronous and throws `ValidationError` before any
  network I/O, so bad callsites fail loudly in tests instead of silently
  sending garbage.
- **Error typing:** `APIError` carries `status`, `requestId` (from
  `X-Request-Id`), and the parsed RFC 7807 `problem` body.
- **Timeouts** cover the entire attempt budget (all retries), enforced via an
  internal `AbortController` composed with any caller-supplied signal.

## Deferred / explicit non-goals

The following were considered and intentionally left for later milestones:

1. **Queue / buffering.** v0.1 sends synchronously. A fire-and-forget queue
   with drain/flush semantics is a natural v0.2 — requires thinking about
   backpressure and graceful shutdown, out of scope here.
2. **OpenAPI-generated types.** Spec §9.1 says the OpenAPI document is the
   source of truth for contract tests; v0.1 types are hand-written against
   spec §3. When `openapi.yaml` lands we should regenerate.
3. **Browser build / bundling.** Spec §11 mandates CORS-disabled ingestion;
   the SDK is server-only. No browser target was produced.
4. **Additional endpoints.** Milestone 9's exit criteria require only
   `event`/`batch`. Query/verify/export wrappers (`/v1/runs/:id`,
   `/v1/runs/:id/verify`, `/v1/runs/:id/export`) are deferred to a future
   milestone; the example uses raw `fetch` to call verify, which is fine for
   now.
5. **Tracing / self-telemetry.** Open question #5 in the spec ("should the SDK
   emit self-health events?"). Declined for v1 per the spec.
6. **Auto-generated `client_event_id`.** The spec allows callers to provide
   one for idempotency; v0.1 passes through what the caller supplies and does
   not auto-generate one. Can be added without an API change.
7. **Structured logging hooks.** No `onRetry` / `onRequest` callbacks. Easy
   to add if users ask.

## Verification

### `npm run typecheck`
```
> @hashline/sdk@0.1.0 typecheck
> tsc --noEmit
(no output, exit 0)
```

### `npm test`
```
 RUN  v1.6.1 /Users/nikola/Develop/hashline-sdk-js
 ✓ test/retry.test.ts  (10 tests)
 ✓ test/client.test.ts (18 tests)

 Test Files  2 passed (2)
      Tests  28 passed (28)
```

### `npm run build`
Emits `dist/` (d.ts + js + sourcemaps). No errors.

### Test coverage summary

- **retry.test.ts (10 tests)**
  - `computeBackoffMs`: zero when `random=0`, caps at `maxMs`, exponential
    scaling across attempts.
  - `parseRetryAfterMs`: missing header → null, delta-seconds, HTTP-date,
    past date clamped to 0, garbage → null.
  - `isRetryableStatus`: 408/429/5xx true; 2xx/3xx/400/401/404 false.
- **client.test.ts (18 tests)**
  - Construction guards: throws without apiKey when enabled; allows no apiKey
    when disabled.
  - Happy path: correct URL, headers, bearer token, JSON body.
  - No-op: `enabled: false` → null, zero fetch calls (event AND batch).
  - Validation: missing `run_id`, missing `actor`, missing `payload`, empty
    batch, oversize batch, batch item with conflicting `run_id`.
  - Retry: 503 → 503 → 200 succeeds; 429 with `Retry-After: 0` recovers on
    next attempt; persistent 503 exhausts retries and throws `APIError`;
    network error exhausts retries and throws `NetworkError`.
  - Non-retryable: 400 throws immediately with problem+json parsed and
    `requestId` captured; 404 throws immediately (tenant-isolation case per
    spec §9.3).
  - Batch: pins `run_id` on every item, posts to `/events/batch`.

## How to verify the exit criterion

> **Milestone 9 exit:** example runs against local dev worker and produces a
> verifiable run.

The example is `examples/basic.ts`. Against a running dev Worker:

```bash
# (in the server repo)
wrangler dev   # exposes http://localhost:8787

# (in this repo)
HASHLINE_API_KEY=al_test_<key> \
HASHLINE_BASE_URL=http://localhost:8787/v1 \
  npx tsx examples/basic.ts
```

Expected output (shape):
```
[example] run_id = run_...
[example] baseUrl = http://localhost:8787/v1
[example] seq=0 run_started hash=sha256:...
[example] batch ack: 2 events, last hash=sha256:...
[example] seq=3 run_ended hash=sha256:...
[example] verify: {"valid":true,"events_verified":4}
[example] OK — chain is valid.
```

The example was not executed as part of this milestone because the server
Worker (milestones 0–8) lives in a separate repo and is not running in this
environment. Running it is a local step the operator performs after standing
up the dev Worker. The SDK side is fully exercised by the unit tests, which
mock `fetch` against the exact wire shapes specified in §5.2.

## Files changed

All files in this milestone are new:

- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`,
  `.gitignore`, `README.md`, `MILESTONE_9_NOTES.md`
- `src/index.ts`, `src/client.ts`, `src/errors.ts`, `src/retry.ts`,
  `src/types.ts`
- `test/client.test.ts`, `test/retry.test.ts`
- `examples/basic.ts`
