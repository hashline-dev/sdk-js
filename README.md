# @hashline/sdk

TypeScript SDK for the [Hashline](../spec.md) agent audit ledger — append-only,
hash-chained, tamper-evident logging for AI agent workloads.

> **Status:** v0.1

## Install

```bash
npm install @hashline/sdk
```

## Quick start

```ts
import { Client } from "@hashline/sdk";

const client = new Client({
  apiKey: process.env.HASHLINE_API_KEY,
});

// Single event — the run is auto-created on first ingest.
await client.event({
  run_id: "run_01HXYZ...",
  type: "tool_call",
  actor: { type: "agent", id: "agent_search" },
  payload: { name: "web_search", arguments: { q: "..." }, call_id: "c1" },
});

// Batch (up to 500 events, same run, atomic).
await client.batch("run_01HXYZ...", [
  { type: "prompt",     actor: { type: "agent", id: "a" }, payload: { model: "m", content: "..." } },
  { type: "completion", actor: { type: "agent", id: "a" }, payload: { model: "m", content: "..." } },
]);
```

## Behavior

- **Auto-retry** on `408`, `429`, and `5xx` with exponential backoff + full
  jitter. `Retry-After` is honored when the server sends it. Network errors
  (DNS/TCP/TLS/abort) are also retried.
- **No-op mode.** Construct with `{ enabled: false }` (or set the env var
  `HASHLINE_DISABLED=1`) and every method returns `null` without any network
  I/O. Useful for local dev, CI, and opt-out flags.
- **Validation.** Obvious wire-format mistakes (missing `run_id`, missing
  `actor`, batch > 500, conflicting `run_id` inside a batch) throw
  `ValidationError` before any request is sent.
- **Typed errors.** Non-2xx responses throw `APIError` with `status`,
  `requestId`, and the parsed RFC 7807 `problem` body. Transport failures throw
  `NetworkError`.
- **Tenant isolation.** Per spec §9.3, cross-tenant access returns `404` — the
  SDK propagates this as a non-retryable `APIError` with `status: 404`.

## Security notes

- The SDK does NOT scrub PII or secrets from payloads. Scrub upstream.
- API keys must never be used from browsers; this SDK is for backend/server use.
- Keys are Bearer-auth over TLS; rotate via the dashboard / control plane.

## Examples

| File | SDK | What it shows |
|------|-----|---------------|
| [`examples/basic.ts`](examples/basic.ts) | Raw fetch | Manual event + batch call, then verify |
| [`examples/anthropic-tools.ts`](examples/anthropic-tools.ts) | `@anthropic-ai/sdk` | Tool-use loop; each step logged to Hashline |
| [`examples/vercel-ai-sdk.ts`](examples/vercel-ai-sdk.ts) | `ai` (Vercel) | `generateText` with `onStepFinish` wired to Hashline |
| [`examples/openai-tools.ts`](examples/openai-tools.ts) | `openai` | Tool-use loop; same pattern as the Anthropic example |

All examples require `HASHLINE_API_KEY` and the relevant provider key, then:

```bash
npx tsx examples/anthropic-tools.ts   # HASHLINE_API_KEY + ANTHROPIC_API_KEY
npx tsx examples/vercel-ai-sdk.ts     # HASHLINE_API_KEY + ANTHROPIC_API_KEY
npx tsx examples/openai-tools.ts      # HASHLINE_API_KEY + OPENAI_API_KEY
```

It emits a small agent run (`run_started` → `tool_call`/`tool_result` batch →
`run_ended`) and then calls `POST /v1/runs/:id/verify`, asserting the chain
reports `valid: true`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

Apache-2.0.
