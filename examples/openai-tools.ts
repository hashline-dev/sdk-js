// examples/openai-tools.ts — OpenAI SDK tool-use loop with Hashline audit logging.
// Demonstrates: run_started, prompt, completion, tool_call, tool_result, run_ended.
//
// Run: HASHLINE_API_KEY=al_test_... OPENAI_API_KEY=sk-... npx tsx examples/openai-tools.ts

import OpenAI from "openai";
import { Client } from "../src/index.js";

const hashlineKey = process.env.HASHLINE_API_KEY;
const baseUrl = process.env.HASHLINE_BASE_URL ?? "https://api.hashline.dev/v1";

if (!hashlineKey) { console.error("HASHLINE_API_KEY required"); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

const hashline = new Client({ apiKey: hashlineKey, baseUrl });
const openai = new OpenAI();
const runId = `run_${Date.now().toString(36).toUpperCase().padEnd(26, "X")}`;
const agent = { type: "agent" as const, id: "openai-demo" };
const system = { type: "system" as const, id: "runner" };
const MODEL = "gpt-4o-mini";

const tools: OpenAI.Chat.ChatCompletionTool[] = [{
  type: "function",
  function: {
    name: "add",
    description: "Add two numbers and return the sum.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
}];

async function main(): Promise<void> {
  console.log(`[example] run_id = ${runId}`);

  await hashline.event({ run_id: runId, type: "run_started", actor: system, payload: { agent: "openai-demo" } });
  console.log("sent: run_started");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: "What is 1234 + 5678? Use the add function." }];

  await hashline.event({ run_id: runId, type: "prompt", actor: agent, payload: { model: MODEL, messages } });
  console.log("sent: prompt");

  while (true) {
    const response = await openai.chat.completions.create({ model: MODEL, tools, messages });
    const msg = response.choices[0]!.message;

    await hashline.event({ run_id: runId, type: "completion", actor: agent, payload: { model: response.model, message: msg, finish_reason: response.choices[0]!.finish_reason } });
    console.log("sent: completion");

    if (!msg.tool_calls?.length) break;

    messages.push(msg);

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as { a: number; b: number };
      await hashline.event({ run_id: runId, type: "tool_call", actor: agent, payload: { name: tc.function.name, arguments: args, call_id: tc.id } });
      console.log(`sent: tool_call (${tc.function.name})`);

      const result = args.a + args.b;
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result) });

      await hashline.event({ run_id: runId, type: "tool_result", actor: agent, payload: { call_id: tc.id, result, status: "ok" } });
      console.log("sent: tool_result");
    }
  }

  await hashline.event({ run_id: runId, type: "run_ended", actor: system, payload: { outcome: "success" } });
  console.log("sent: run_ended");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/runs/${runId}/verify`, { method: "POST", headers: { Authorization: `Bearer ${hashlineKey}` } });
  const verify = await res.json();
  console.log("verify:", JSON.stringify(verify));
}

main().catch((err: unknown) => { console.error("[example] failed:", err); process.exit(1); });