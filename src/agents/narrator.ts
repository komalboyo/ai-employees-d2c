/**
 * Agent narrator.
 *
 * Turns a structured ProposalInput into the human-readable copy that
 * shows up in the morning brief and the chat layer. Two modes:
 *
 *  1. Deterministic template (default, no LLM). Cheap, predictable,
 *     evaluable. Always available.
 *  2. LLM-written narrative (when ANTHROPIC_API_KEY is set). Adds
 *     personality consistent with the agent's role.
 *
 * The DECISION is never delegated to the LLM. Only the explanation is.
 */

import type { AgentSpec, ProposalInput } from "./contract";

export async function narrate(spec: AgentSpec, p: ProposalInput): Promise<ProposalInput> {
  if (p.narrative) return p; // already narrated upstream
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const narrative = await narrateWithLLM(spec, p);
      return { ...p, narrative };
    } catch {
      // fall through to template
    }
  }
  return { ...p, narrative: templateNarrative(spec, p) };
}

function templateNarrative(spec: AgentSpec, p: ProposalInput): string {
  const amount = p.expected_savings_inr.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const conf = (p.confidence * 100).toFixed(0);
  const cav = p.caveats.length > 0 ? ` Caveats: ${p.caveats.join("; ")}.` : "";
  return `${spec.name} (${spec.role}): proposed ${p.action_type} on ${p.target_entity}:${p.target_entity_id}. Expected ₹-impact: ₹${amount} over ${p.prediction.window_days}d (${p.prediction.direction} ${p.prediction.metric}). Confidence ${conf}%.${cav}`;
}

async function narrateWithLLM(spec: AgentSpec, p: ProposalInput): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 220,
    system: `${spec.systemPrompt}\n\nWrite a 2-3 sentence proposal in your voice as ${spec.name}, the ${spec.role}. Lead with the action and ₹-impact. Include the most important caveat. Do NOT invent any numbers — only restate what's in the input. Refer to the founder as "you".`,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          action_type: p.action_type,
          target: `${p.target_entity}:${p.target_entity_id}`,
          expected_savings_inr: p.expected_savings_inr,
          prediction: p.prediction,
          confidence: p.confidence,
          caveats: p.caveats,
          payload: p.payload,
        }),
      },
    ],
  });
  const text = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("")
    .trim();
  return text || templateNarrative(spec, p);
}
