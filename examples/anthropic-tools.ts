// examples/anthropic-tools.ts — Anthropic SDK tool-use loop with Hashline audit logging.
// Demonstrates: run_started, prompt, completion, tool_call, tool_result, run_ended.
//
// Run: HASHLINE_API_KEY=al_test_... ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/anthropic-tools.ts

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "../src/index.js";

const hashlineKey = process.env.HASHLINE_API_KEY;
const baseUrl = process.env.HASHLINE_BASE_URL ?? "https://api.hashline.dev/v1";

if (!hashlineKey) { console.error("HASHLINE_API_KEY required"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

const hashline = new Client({ apiKey: hashlineKey, baseUrl });
const anthropic = new Anthropic();
const runId = `run_${Date.now().toString(36).toUpperCase().padEnd(26, "X")}`;
const agent = { type: "agent" as const, id: "anthropic-demo" };
const system = { type: "system" as const, id: "runner" };
const MODEL = "claude-haiku-4-5-20251001";

const tools: Anthropic.Tool[] = [{
  name: "add",
  description: "Add two numbers and return the sum.",
  input_schema: {
    type: "object" as const,
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
}];

async function main(): Promise<void> {
  console.log(`[example] run_id = ${runId}`);

  await hashline.event({ run_id: runId, type: "run_started", actor: system, payload: { agent: "anthropic-demo" } });
  console.log("sent: run_started");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What is 1234 + 5678? Use the add tool." }];

  await hashline.event({ run_id: runId, type: "prompt", actor: agent, payload: { model: MODEL, messages } });
  console.log("sent: prompt");

  while (true) {
    const response = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, tools, messages });

    await hashline.event({ run_id: runId, type: "completion", actor: agent, payload: { model: response.model, content: response.content, stop_reason: response.stop_reason } });
    console.log("sent: completion");

    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      await hashline.event({ run_id: runId, type: "tool_call", actor: agent, payload: { name: block.name, arguments: block.input, call_id: block.id } });
      console.log(`sent: tool_call (${block.name})`);

      const { a, b } = block.input as { a: number; b: number };
      const result = a + b;
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: String(result) });

      await hashline.event({ run_id: runId, type: "tool_result", actor: agent, payload: { call_id: block.id, result, status: "ok" } });
      console.log("sent: tool_result");
    }
    messages.push({ role: "user", content: toolResults });
  }

  await hashline.event({ run_id: runId, type: "run_ended", actor: system, payload: { outcome: "success" } });
  console.log("sent: run_ended");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/runs/${runId}/verify`, { method: "POST", headers: { Authorization: `Bearer ${hashlineKey}` } });
  const verify = await res.json();
  console.log("verify:", JSON.stringify(verify));
}

main().catch((err: unknown) => { console.error("[example] failed:", err); process.exit(1); });