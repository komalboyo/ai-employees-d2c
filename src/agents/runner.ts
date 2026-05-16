/**
 * Agent runner.
 *
 * Single entry-point that:
 *   1. Opens an `agent_runs` row.
 *   2. Calls `spec.decide(ctx)`.
 *   3. (Optionally) asks an LLM to write narrative copy on each proposal.
 *   4. Writes proposals into the DB (which makes them subject to the
 *      same `target_entity` disagreement-detection index as everyone
 *      else's).
 *   5. Closes the `agent_runs` row with the structured reasoning log.
 *
 * If ANTHROPIC_API_KEY is unset, narrative falls back to a deterministic
 * template — agents stay useful without LLM credentials.
 */

import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, agentRuns, proposals } from "@/db/schema";
import type { AgentSpec, AgentRunContext, ProposalInput, PriorProposal } from "./contract";
import { narrate } from "./narrator";

export interface RunOptions {
  merchant_id: string;
  now?: Date;
  /** Skip the LLM narrator (faster, deterministic). */
  no_narrate?: boolean;
}

export interface RunResult {
  agent_run_id: string;
  proposals_written: number;
  agent_name: string;
}

export async function runAgent(spec: AgentSpec, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? new Date();
  const merchant_id = opts.merchant_id;

  // Find or register the agent row.
  let agent = await db
    .select()
    .from(agents)
    .where(sql`merchant_id = ${merchant_id} AND name = ${spec.name}`)
    .limit(1)
    .then((r) => r[0]);

  if (!agent) {
    [agent] = await db
      .insert(agents)
      .values({
        merchant_id,
        name: spec.name,
        role: spec.role,
        trigger: spec.trigger,
        schedule: spec.schedule,
        decision_template: spec.name.toLowerCase().replace(/\s+/g, "_"),
        decision_params: {},
        tools: spec.tools as never,
        system_prompt: spec.systemPrompt,
        authority_cap_inr: spec.authorityCapInr?.toString(),
        hired_by: "system",
        declared_failure_modes: spec.declaredFailureModes as never,
      })
      .returning();
  }

  // Open the run.
  const [run] = await db
    .insert(agentRuns)
    .values({ merchant_id, agent_id: agent.id, status: "running" })
    .returning();

  let decision;
  try {
    // Load recent proposals from other agents — used for cross-references.
    const recent = await db
      .select({
        id: proposals.id,
        agent_id: proposals.agent_id,
        action_type: proposals.action_type,
        target_entity: proposals.target_entity,
        target_entity_id: proposals.target_entity_id,
        expected_savings_inr: proposals.expected_savings_inr,
        created_at: proposals.created_at,
      })
      .from(proposals)
      .where(sql`${proposals.merchant_id} = ${merchant_id} AND ${proposals.created_at} > now() - interval '7 days'`)
      .orderBy(desc(proposals.created_at))
      .limit(50);

    // Decorate with agent names.
    const recentWithNames: PriorProposal[] = [];
    for (const p of recent) {
      const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, p.agent_id)).limit(1);
      recentWithNames.push({
        id: p.id,
        agent_name: a?.name ?? "unknown",
        action_type: p.action_type,
        target_entity: p.target_entity,
        target_entity_id: p.target_entity_id,
        expected_savings_inr: Number(p.expected_savings_inr),
        created_at: p.created_at,
      });
    }

    const ctx: AgentRunContext = { merchant_id, now, recent_proposals: recentWithNames };
    decision = await spec.decide(ctx);

    // Narrate proposals (deterministic template by default; LLM if env key set).
    const narrated = opts.no_narrate ? decision.proposals : await Promise.all(decision.proposals.map((p) => narrate(spec, p)));

    // Write proposals.
    for (const p of narrated) {
      await writeProposal(merchant_id, agent.id, run.id, p);
    }

    await db
      .update(agentRuns)
      .set({
        status: "ok",
        finished_at: new Date(),
        reasoning_log: decision.reasoning as never,
      })
      .where(eq(agentRuns.id, run.id));

    return { agent_run_id: run.id, proposals_written: narrated.length, agent_name: spec.name };
  } catch (e: unknown) {
    await db
      .update(agentRuns)
      .set({
        status: "error",
        finished_at: new Date(),
        error: e instanceof Error ? e.message : String(e),
      })
      .where(eq(agentRuns.id, run.id));
    throw e;
  }
}

async function writeProposal(
  merchant_id: string,
  agent_id: string,
  agent_run_id: string,
  p: ProposalInput
): Promise<void> {
  await db.insert(proposals).values({
    merchant_id,
    agent_id,
    agent_run_id,
    action_type: p.action_type,
    target_entity: p.target_entity,
    target_entity_id: p.target_entity_id,
    payload: { ...p.payload, narrative: p.narrative } as never,
    expected_savings_inr: p.expected_savings_inr.toString(),
    prediction: p.prediction as never,
    confidence: p.confidence.toString(),
    caveats: p.caveats as never,
    citation_row_ids: p.citation_row_ids as never,
    references: (p.references ?? []) as never,
  });
}
