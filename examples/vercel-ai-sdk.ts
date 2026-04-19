// examples/vercel-ai-sdk.ts — Vercel AI SDK generateText with Hashline audit logging.
// Demonstrates wiring onStepFinish to emit prompt, completion, tool_call, tool_result.
//
// Run: HASHLINE_API_KEY=al_test_... ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/vercel-ai-sdk.ts

import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { Client } from "../src/index.js";

const hashlineKey = process.env.HASHLINE_API_KEY;
const baseUrl = process.env.HASHLINE_BASE_URL ?? "https://api.hashline.dev/v1";

if (!hashlineKey) { console.error("HASHLINE_API_KEY required"); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY required"); process.exit(1); }

const hashline = new Client({ apiKey: hashlineKey, baseUrl });
const runId = `run_${Date.now().toString(36).toUpperCase().padEnd(26, "X")}`;
const agent = { type: "agent" as const, id: "vercel-ai-demo" };
const system = { type: "system" as const, id: "runner" };

async function main(): Promise<void> {
  console.log(`[example] run_id = ${runId}`);

  await hashline.event({ run_id: runId, type: "run_started", actor: system, payload: { agent: "vercel-ai-demo" } });
  console.log("sent: run_started");

  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5-20251001"),
    prompt: "What is 1234 + 5678? Use the add tool.",
    tools: {
      add: tool({
        description: "Add two numbers and return the sum.",
        parameters: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }) => a + b,
      }),
    },
    maxSteps: 5,
    onStepFinish: async ({ request, response, toolCalls, toolResults }) => {
      await hashline.event({ run_id: runId, type: "prompt", actor: agent, payload: { messages: request.messages } });
      console.log("sent: prompt");

      await hashline.event({ run_id: runId, type: "completion", actor: agent, payload: { messages: response.messages, finish_reason: response.finishReason } });
      console.log("sent: completion");

      for (const tc of toolCalls) {
        await hashline.event({ run_id: runId, type: "tool_call", actor: agent, payload: { name: tc.toolName, arguments: tc.args, call_id: tc.toolCallId } });
        console.log(`sent: tool_call (${tc.toolName})`);
      }

      for (const tr of toolResults) {
        await hashline.event({ run_id: runId, type: "tool_result", actor: agent, payload: { call_id: tr.toolCallId, result: tr.result, status: "ok" } });
        console.log("sent: tool_result");
      }
    },
  });

  console.log("final answer:", text);

  await hashline.event({ run_id: runId, type: "run_ended", actor: system, payload: { outcome: "success" } });
  console.log("sent: run_ended");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/runs/${runId}/verify`, { method: "POST", headers: { Authorization: `Bearer ${hashlineKey}` } });
  const verify = await res.json();
  console.log("verify:", JSON.stringify(verify));
}

main().catch((err: unknown) => { console.error("[example] failed:", err); process.exit(1); });