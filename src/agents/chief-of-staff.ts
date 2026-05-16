/**
 * Chief of Staff.
 *
 * Not a specialist. The synthesizer + manager. Reads proposals from the
 * four specialists, detects same-target disagreements, ranks by
 * `expected_savings_inr * confidence`, and writes a single "morning
 * brief" proposal that the founder sees first.
 *
 * Disagreement detection is a pure SQL join — same (merchant_id,
 * target_entity, target_entity_id), different (agent_id, action_type)
 * within the same morning batch.
 */

import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, agentRuns, proposals } from "@/db/schema";
import type { AgentSpec, ProposalInput } from "./contract";

export interface MorningBrief {
  date: string;
  merchant_id: string;
  agent_run_id: string;
  ranked_proposals: BriefItem[];
  disagreements: Disagreement[];
}

export interface BriefItem {
  proposal_id: string;
  agent_name: string;
  agent_role: string;
  action_type: string;
  target_entity: string;
  target_entity_id: string;
  expected_savings_inr: number;
  confidence: number;
  priority_score: number;
  narrative: string;
  caveats: string[];
  citation_row_ids: { table: string; id: string }[];
  references: { proposal_id: string; relationship: string }[];
  in_disagreement_with?: string[]; // proposal_ids
}

export interface Disagreement {
  target_entity: string;
  target_entity_id: string;
  proposals: { proposal_id: string; agent: string; action_type: string }[];
  summary: string;
}

export const chiefOfStaff: AgentSpec = {
  name: "Chief of Staff",
  role: "Synthesizer",
  trigger: "cron",
  schedule: "0 8 * * *",
  tools: ["proposals", "rows"],
  systemPrompt:
    "You are the Chief of Staff to the founder. You synthesize the team's morning proposals. " +
    "You don't analyze data yourself — you read what Aanya, Rishi, Meera, and Karan have already filed " +
    "and decide what the founder reads first. You name disagreements out loud. You speak briefly.",
  authorityCapInr: null,
  declaredFailureModes: [
    "Ranking algorithm is fixed (savings × confidence); doesn't adapt to founder feedback yet",
    "Disagreement detection only fires on identical target_entity_id — semantically related conflicts (different lanes, same root cause) are missed",
    "If a specialist agent fails, the brief silently omits its slice",
  ],

  async decide(ctx) {
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    // Pull this morning's batch of pending proposals from all other agents.
    const batch = (await db.execute(sql`
      SELECT
        p.id AS proposal_id,
        p.action_type,
        p.target_entity,
        p.target_entity_id,
        p.expected_savings_inr::numeric AS expected_savings_inr,
        p.confidence::numeric AS confidence,
        p.payload,
        p.caveats,
        p.citation_row_ids,
        p.references,
        a.name AS agent_name,
        a.role AS agent_role
      FROM proposals p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.merchant_id = ${ctx.merchant_id}
        AND p.created_at >= ${since.toISOString()}
        AND p.status = 'pending'
        AND a.name != 'Chief of Staff'
      ORDER BY p.created_at DESC
    `)) as unknown as Array<{
      proposal_id: string;
      action_type: string;
      target_entity: string;
      target_entity_id: string;
      expected_savings_inr: string;
      confidence: string;
      payload: any;
      caveats: string[];
      citation_row_ids: any;
      references: any;
      agent_name: string;
      agent_role: string;
    }>;

    // Disagreement detection.
    const byTarget = new Map<string, typeof batch>();
    for (const p of batch) {
      const k = `${p.target_entity}::${p.target_entity_id}`;
      const arr = byTarget.get(k) ?? [];
      arr.push(p);
      byTarget.set(k, arr);
    }
    const disagreements: Disagreement[] = [];
    const inDisagreementMap = new Map<string, string[]>();
    for (const [k, group] of byTarget) {
      if (group.length < 2) continue;
      const distinctAgents = new Set(group.map((p) => p.agent_name));
      if (distinctAgents.size < 2) continue;
      const [tEntity, tId] = k.split("::");
      const summary = `${group.length} agents flagged ${tEntity} ${tId}: ${group
        .map((p) => `${p.agent_name} → ${p.action_type}`)
        .join(", ")}`;
      disagreements.push({
        target_entity: tEntity,
        target_entity_id: tId,
        proposals: group.map((p) => ({
          proposal_id: p.proposal_id,
          agent: p.agent_name,
          action_type: p.action_type,
        })),
        summary,
      });
      for (const p of group) {
        const others = group.filter((x) => x.proposal_id !== p.proposal_id).map((x) => x.proposal_id);
        inDisagreementMap.set(p.proposal_id, others);
      }
    }

    // Rank.
    const ranked: BriefItem[] = batch
      .map((p) => {
        const savings = Number(p.expected_savings_inr);
        const conf = Number(p.confidence);
        return {
          proposal_id: p.proposal_id,
          agent_name: p.agent_name,
          agent_role: p.agent_role,
          action_type: p.action_type,
          target_entity: p.target_entity,
          target_entity_id: p.target_entity_id,
          expected_savings_inr: savings,
          confidence: conf,
          priority_score: Math.round(savings * conf),
          narrative: p.payload?.narrative ?? "",
          caveats: p.caveats ?? [],
          citation_row_ids: p.citation_row_ids ?? [],
          references: p.references ?? [],
          in_disagreement_with: inDisagreementMap.get(p.proposal_id),
        };
      })
      .sort((a, b) => b.priority_score - a.priority_score);

    const brief: MorningBrief = {
      date: ctx.now.toISOString().slice(0, 10),
      merchant_id: ctx.merchant_id,
      agent_run_id: "", // filled by runner via reasoning_log
      ranked_proposals: ranked,
      disagreements,
    };

    // The Chief writes its own proposal: a meta-proposal whose payload IS the brief.
    const proposals_out: ProposalInput[] = [
      {
        action_type: "publish_morning_brief",
        target_entity: "merchant",
        target_entity_id: ctx.merchant_id,
        payload: { brief: brief as unknown as Record<string, unknown> },
        expected_savings_inr: ranked.reduce((s, p) => s + p.expected_savings_inr, 0),
        prediction: {
          metric: "founder_attention_seconds_to_decision",
          expected_change: 0,
          window_days: 1,
          direction: "decrease",
        },
        confidence: 1.0,
        caveats: ["Brief is a synthesis, not analysis — citations live in upstream proposals"],
        citation_row_ids: [],
      },
    ];

    return {
      proposals: proposals_out,
      reasoning: {
        proposals_in_batch: batch.length,
        disagreements: disagreements.length,
        top_priority_score: ranked[0]?.priority_score ?? 0,
      },
    };
  },
};

/**
 * Convenience: read the most recent morning brief from the DB.
 */
export async function getLatestBrief(merchant_id: string): Promise<MorningBrief | null> {
  const [row] = await db
    .select({
      payload: proposals.payload,
      created_at: proposals.created_at,
    })
    .from(proposals)
    .where(
      sql`merchant_id = ${merchant_id} AND action_type = 'publish_morning_brief'`
    )
    .orderBy(desc(proposals.created_at))
    .limit(1);
  if (!row) return null;
  const brief = (row.payload as { brief: MorningBrief }).brief;
  return brief;
}
