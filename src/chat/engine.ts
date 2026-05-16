/**
 * Chat engine.
 *
 * One-shot: take the conversation history, run the Anthropic tool-use
 * loop, validate citations, retry up to twice on validation failure,
 * persist the conversation, return the final assistant message + the
 * verified citations.
 */

import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { merchants, agents, chatSessions, chatMessages } from "@/db/schema";
import { TOOLS, toolByName, anthropicToolDefs } from "./tools";
import { systemPrompt } from "./system-prompt";
import { validate, type ValidationResult } from "./validator";

export interface ChatTurnInput {
  merchant_id: string;
  session_id?: string;
  user_message: string;
}

export interface ChatTurnOutput {
  session_id: string;
  assistant_message: string;
  citations: { table: string; id: string }[];
  violations: string[];
  tool_calls: Array<{ name: string; input: unknown; output: unknown }>;
  fallback_used: boolean;
}

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MAX_LOOP_ITERATIONS = 8;
const MAX_VALIDATION_RETRIES = 2;

function hasRealAnthropicKey(): boolean {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) return false;
  // The .env.example ships with `sk-ant-...` literal — detect placeholders.
  if (k.length < 20) return false;
  if (/^sk-ant-\.\.\.$/.test(k)) return false;
  return true;
}

export async function chatTurn(input: ChatTurnInput): Promise<ChatTurnOutput> {
  if (!hasRealAnthropicKey()) {
    // Offline mode for the reviewer who hasn't configured a key.
    return offlineFallback(input);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Session bootstrap.
  const session_id = await ensureSession(input.merchant_id, input.session_id);
  const [m] = await db.select().from(merchants).where(sql`id = ${input.merchant_id}`).limit(1);
  const team = await db
    .select({ name: agents.name, role: agents.role })
    .from(agents)
    .where(sql`merchant_id = ${input.merchant_id} AND status = 'active'`);

  const sys = systemPrompt({ merchant_name: m?.name ?? "this brand", agent_team: team });
  const history = await loadHistory(session_id);

  // Persist user turn.
  await db.insert(chatMessages).values({
    merchant_id: input.merchant_id,
    session_id,
    role: "user",
    content: { text: input.user_message } as never,
  });

  // Build messages for Anthropic.
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: input.user_message },
  ];

  const tool_calls: ChatTurnOutput["tool_calls"] = [];
  let validation: ValidationResult = { ok: false, text: "", verified_citations: [], violations: [] };
  let final_text = "";
  let retries = 0;

  while (retries <= MAX_VALIDATION_RETRIES) {
    // Inner tool-use loop.
    let iter = 0;
    while (iter < MAX_LOOP_ITERATIONS) {
      iter++;
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: sys,
        tools: anthropicToolDefs() as never,
        messages,
      });

      const assistantContent = resp.content;
      messages.push({ role: "assistant", content: assistantContent as never });

      const toolUses = assistantContent.filter((c) => c.type === "tool_use") as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: unknown;
      }>;
      if (toolUses.length === 0) {
        // Final text.
        final_text = assistantContent
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n")
          .trim();
        break;
      }

      // Execute each requested tool.
      const tool_results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const tool = toolByName(tu.name);
        let output: unknown;
        try {
          if (!tool) throw new Error(`unknown tool: ${tu.name}`);
          // Validate input via zod.
          const parsed = tool.input_schema.parse(tu.input);
          const result = await tool.handler(input.merchant_id, parsed);
          output = result;
        } catch (e: unknown) {
          output = { error: e instanceof Error ? e.message : String(e) };
        }
        tool_calls.push({ name: tu.name, input: tu.input, output });
        tool_results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(output),
        });
      }
      messages.push({ role: "user", content: tool_results });
    }

    // Validate.
    validation = await validate(input.merchant_id, final_text);
    if (validation.ok) break;

    // Build retry user-message asking model to fix citations.
    retries++;
    if (retries > MAX_VALIDATION_RETRIES) break;
    messages.push({
      role: "user",
      content: `Your previous answer failed the citation contract:\n- ${validation.violations.join(
        "\n- "
      )}\n\nRewrite the answer. Every numerical claim must be followed by [cite:table:id,...]. If you don't have row_ids to cite, call a tool to get them, or say "I can't ground that".`,
    });
  }

  // Persist assistant turn.
  await db.insert(chatMessages).values({
    merchant_id: input.merchant_id,
    session_id,
    role: "assistant",
    content: { text: final_text } as never,
    tool_calls: tool_calls as never,
    citations: validation.verified_citations as never,
    citation_violations: validation.violations as never,
  });

  return {
    session_id,
    assistant_message: final_text,
    citations: validation.verified_citations,
    violations: validation.violations,
    tool_calls,
    fallback_used: false,
  };
}

async function ensureSession(merchant_id: string, existing?: string): Promise<string> {
  if (existing) return existing;
  const [s] = await db
    .insert(chatSessions)
    .values({ merchant_id })
    .returning();
  return s.id;
}

async function loadHistory(session_id: string): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(sql`session_id = ${session_id}`)
    .orderBy(chatMessages.created_at);
  const out: Anthropic.MessageParam[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      out.push({ role: "user", content: (r.content as { text: string }).text });
    } else if (r.role === "assistant") {
      out.push({ role: "assistant", content: (r.content as { text: string }).text });
    }
  }
  return out;
}

/**
 * Offline fallback: when ANTHROPIC_API_KEY is not set, we still answer
 * via a deterministic mini-router so the reviewer can demo the citation
 * contract without burning tokens.
 */
async function offlineFallback(input: ChatTurnInput): Promise<ChatTurnOutput> {
  const session_id = await ensureSession(input.merchant_id, input.session_id);
  await db.insert(chatMessages).values({
    merchant_id: input.merchant_id,
    session_id,
    role: "user",
    content: { text: input.user_message } as never,
  });

  // Trivial keyword router → metrics tool.
  const q = input.user_message.toLowerCase();
  let toolName = "proposals_list";
  let toolInput: any = {};
  if (q.includes("rto") || q.includes("return")) {
    toolName = "metrics";
    toolInput = { entity: "rto", group_by: q.includes("pin") ? "pincode" : "courier" };
  } else if (q.includes("spend") || q.includes("budget") || q.includes("burn")) {
    toolName = "metrics";
    toolInput = { entity: "ad_spend" };
  } else if (q.includes("margin") || q.includes("profit")) {
    toolName = "metrics";
    toolInput = { entity: "true_margin_per_adset" };
  }
  const tool = toolByName(toolName)!;
  const result = await tool.handler(input.merchant_id, toolInput);
  const text = `(offline fallback — ANTHROPIC_API_KEY not set) Result from ${toolName}: ${JSON.stringify(
    result.data
  )} ${result.citations.length > 0 ? `[cite:${result.citations[0].table}:${result.citations.map((c) => c.id).join(",")}]` : ""}`;

  await db.insert(chatMessages).values({
    merchant_id: input.merchant_id,
    session_id,
    role: "assistant",
    content: { text } as never,
    tool_calls: [{ name: toolName, input: toolInput, output: result.data }] as never,
    citations: result.citations as never,
  });

  return {
    session_id,
    assistant_message: text,
    citations: result.citations,
    violations: [],
    tool_calls: [{ name: toolName, input: toolInput, output: result.data }],
    fallback_used: true,
  };
}
