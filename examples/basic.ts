// examples/basic.ts — end-to-end example for the Hashline SDK.
//
// What it does:
//   1. Creates a Client pointed at a local dev Worker (spec milestone 3+).
//   2. Emits a `run_started`, a `tool_call`/`tool_result` pair, and a `run_ended`
//      — both via single event() calls and one batch().
//   3. Calls POST /v1/runs/:id/verify and asserts the chain is valid.
//
// Prerequisites:
//   - Hashline dev Worker running locally (e.g. `npm run dev` in the server
//     repo), exposing http://localhost:8787/v1.
//   - An API key with `events:write` + `runs:read` scopes.
//
// Usage:
//   HASHLINE_API_KEY=al_test_... HASHLINE_BASE_URL=http://localhost:8787/v1 \
//     npx tsx examples/basic.ts
//
// Exits 0 on success, 1 on any failure.

import { Client } from "../src/index.js";

const baseUrl = process.env.HASHLINE_BASE_URL ?? "http://localhost:8787/v1";
const apiKey = process.env.HASHLINE_API_KEY;

if (!apiKey) {
  console.error("HASHLINE_API_KEY env var is required");
  process.exit(1);
}

const runId = `run_${Date.now().toString(36).toUpperCase().padEnd(26, "X")}`;

const client = new Client({ apiKey, baseUrl });

async function main(): Promise<void> {
  console.log(`[example] run_id = ${runId}`);
  console.log(`[example] baseUrl = ${baseUrl}`);

  const started = await client.event({
    run_id: runId,
    type: "run_started",
    actor: { type: "system", id: "example-runner" },
    payload: { agent: "example-agent", version: "0.1.0" },
  });
  console.log(`[example] seq=${started?.seq} run_started hash=${started?.hash}`);

  const callId = `call_${Date.now()}`;
  const batchAck = await client.batch(runId, [
    {
      type: "tool_call",
      actor: { type: "agent", id: "example-agent" },
      payload: { name: "web_search", arguments: { q: "hashline" }, call_id: callId },
    },
    {
      type: "tool_result",
      actor: { type: "agent", id: "example-agent" },
      payload: { call_id: callId, status: "ok", result: { hits: 3 }, duration_ms: 42 },
    },
  ]);
  console.log(
    `[example] batch ack: ${batchAck?.events.length} events, last hash=${
      batchAck?.events[batchAck.events.length - 1]?.hash
    }`,
  );

  const ended = await client.event({
    run_id: runId,
    type: "run_ended",
    actor: { type: "system", id: "example-runner" },
    payload: { outcome: "success" },
  });
  console.log(`[example] seq=${ended?.seq} run_ended hash=${ended?.hash}`);

  const verifyUrl = `${baseUrl.replace(/\/$/, "")}/runs/${runId}/verify`;
  const verifyRes = await fetch(verifyUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!verifyRes.ok) {
    throw new Error(`verify failed: HTTP ${verifyRes.status}`);
  }
  const verify = (await verifyRes.json()) as {
    valid: boolean;
    events_verified?: number;
    break_at_seq?: number;
    reason?: string;
  };
  console.log(`[example] verify: ${JSON.stringify(verify)}`);
  if (!verify.valid) {
    throw new Error(
      `chain invalid: break_at_seq=${verify.break_at_seq} reason=${verify.reason}`,
    );
  }
  console.log("[example] OK — chain is valid.");
}

main().catch((err: unknown) => {
  console.error("[example] failed:", err);
  process.exit(1);
});
