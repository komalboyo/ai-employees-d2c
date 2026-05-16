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
import { hireAgent } from "./hire";

/**
 * Autonomous-hire feature flag.
 *
 * Default OFF. Set AUTO_HIRE=1 to enable.
 *
 * When ON, the Chief of Staff is allowed to call hireAgent() herself
 * if a single target_entity has been flagged across N or more *runs* in
 * the recent window. Bounded by:
 *   - max 1 autonomous hire per Chief of Staff run
 *   - never re-hire on the same target (idempotent on agent name)
 *   - target must persist for AUTO_HIRE_MIN_RUNS runs (default 3)
 *
 * This is the zero-human-business path. The default is OFF because
 * autonomous spawning needs trust earned over time. See README §
 * "On `hire()` — founder-driven by default, autonomous as an opt-in".
 */
const AUTO_HIRE_ENABLED = process.env.AUTO_HIRE === "1";
const AUTO_HIRE_MIN_RUNS = Number(process.env.AUTO_HIRE_MIN_RUNS ?? 3);

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

    // Autonomous hire — feature-flagged. When enabled, the Chief of
    // Staff identifies persistently-flagged targets and spawns a
    // dedicated watcher. Strictly bounded: 1 hire per run, on a target
    // that has appeared in ≥ AUTO_HIRE_MIN_RUNS distinct runs.
    let autoHireProposal: ProposalInput | null = null;
    let autoHireReasoning: Record<string, unknown> | null = null;
    if (AUTO_HIRE_ENABLED) {
      const persistent = await findPersistentTargets(ctx.merchant_id, AUTO_HIRE_MIN_RUNS);
      autoHireReasoning = {
        enabled: true,
        threshold_runs: AUTO_HIRE_MIN_RUNS,
        candidate_targets: persistent.length,
        candidates: persistent.slice(0, 5).map((p) => ({
          target_entity: p.target_entity,
          target_entity_id: p.target_entity_id,
          distinct_runs: p.distinct_runs,
        })),
      };
      const candidate = await pickFirstUnwatched(ctx.merchant_id, persistent);
      if (candidate) {
        const hireName = `Watcher · ${candidate.target_entity}:${candidate.target_entity_id}`;
        const result = await hireAgent({
          merchant_id: ctx.merchant_id,
          name: hireName,
          role: `Persistent ${candidate.target_entity} monitor`,
          template: "monitor",
          params: watcherParamsFor(candidate),
          schedule: "0 */6 * * *",
          hired_by: "chief_of_staff",
          declared_failure_modes: [
            "Auto-hired watcher inherits the monitor template — no custom decision logic",
            "Spawn rule is deterministic; not based on incremental value, only on flagging persistence",
          ],
        });
        Object.assign(autoHireReasoning, { hired_agent_id: result.agent_id, hire_name: hireName });
        autoHireProposal = {
          action_type: "chief_of_staff_hired_watcher",
          target_entity: candidate.target_entity,
          target_entity_id: candidate.target_entity_id,
          payload: {
            hire_name: hireName,
            distinct_runs_flagged: candidate.distinct_runs,
            sample_proposal_ids: candidate.sample_proposal_ids,
            rationale: `${candidate.target_entity}:${candidate.target_entity_id} flagged across ${candidate.distinct_runs} runs; spawning a dedicated monitor.`,
          },
          expected_savings_inr: 0,
          prediction: {
            metric: "time_to_resolution",
            expected_change: 0,
            window_days: 7,
            direction: "decrease",
          },
          confidence: 0.55,
          caveats: [
            "AUTO_HIRE=1 mode — Chief of Staff acted without founder approval",
            "v0 bounds: 1 autonomous hire/run, threshold = " + AUTO_HIRE_MIN_RUNS + " runs",
          ],
          citation_row_ids: candidate.sample_proposal_ids.map((id) => ({ table: "proposals", id })),
        };
      }
    } else {
      autoHireReasoning = { enabled: false, note: "AUTO_HIRE=1 to allow Chief of Staff to spawn watchers herself" };
    }

    const brief: MorningBrief = {
      date: ctx.now.toISOString().slice(0, 10),
      merchant_id: ctx.merchant_id,
      agent_run_id: "", // filled by runner via reasoning_log
      ranked_proposals: ranked,
      disagreements,
    };

    // The Chief writes its own proposal(s): the brief + any autonomous hire.
    const proposals_out: ProposalInput[] = [];
    if (autoHireProposal) proposals_out.push(autoHireProposal);
    proposals_out.push({
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
    });

    return {
      proposals: proposals_out,
      reasoning: {
        proposals_in_batch: batch.length,
        disagreements: disagreements.length,
        top_priority_score: ranked[0]?.priority_score ?? 0,
        autonomous_hire: autoHireReasoning,
      },
    };
  },
};

/**
 * Find targets flagged across the most recent N agent runs.
 * "Distinct runs" is counted by the `agent_run_id` on proposals.
 */
async function findPersistentTargets(merchant_id: string, minRuns: number) {
  // Counts BOTH pending and superseded proposals — superseded is how
  // run-agents.ts marks the previous run's proposals (instead of
  // deleting them), so persistence history is preserved across runs.
  const rows = (await db.execute(sql`
    SELECT
      p.target_entity,
      p.target_entity_id,
      COUNT(DISTINCT p.agent_run_id)::int AS distinct_runs,
      ARRAY_AGG(p.id::text ORDER BY p.created_at DESC) AS sample_proposal_ids
    FROM proposals p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.merchant_id = ${merchant_id}
      AND a.name != 'Chief of Staff'
      AND p.target_entity NOT IN ('merchant', 'watch')
      AND p.status IN ('pending', 'superseded')
    GROUP BY p.target_entity, p.target_entity_id
    HAVING COUNT(DISTINCT p.agent_run_id) >= ${minRuns}
    ORDER BY COUNT(DISTINCT p.agent_run_id) DESC
  `)) as unknown as Array<{
    target_entity: string;
    target_entity_id: string;
    distinct_runs: number;
    sample_proposal_ids: string[];
  }>;
  return rows;
}

/**
 * Skip targets that already have a Chief-of-Staff-hired watcher.
 */
async function pickFirstUnwatched(
  merchant_id: string,
  candidates: Awaited<ReturnType<typeof findPersistentTargets>>
) {
  if (candidates.length === 0) return null;
  const existing = (await db.execute(sql`
    SELECT name FROM agents
    WHERE merchant_id = ${merchant_id} AND hired_by = 'chief_of_staff'
  `)) as unknown as Array<{ name: string }>;
  const existingNames = new Set(existing.map((e) => e.name));
  for (const c of candidates) {
    const watcherName = `Watcher · ${c.target_entity}:${c.target_entity_id}`;
    if (!existingNames.has(watcherName)) return c;
  }
  return null;
}

/**
 * Map a target type to the watcher's monitor-template params.
 */
function watcherParamsFor(c: { target_entity: string; target_entity_id: string }) {
  if (c.target_entity === "ad_object") {
    return {
      metric: "true_margin",
      adset_source_id: c.target_entity_id,
      threshold: 0,
      window_days: 7,
    };
  }
  if (c.target_entity === "pincode_courier") {
    const [courier, pincode] = c.target_entity_id.split("::");
    return {
      metric: "rto_rate",
      courier,
      pincode,
      threshold: 0.35,
      window_days: 7,
    };
  }
  if (c.target_entity === "sku") {
    return {
      metric: "days_to_stockout",
      sku: c.target_entity_id,
      threshold: 14,
      window_days: 7,
    };
  }
  return { metric: "generic", target: c.target_entity_id, threshold: 0, window_days: 7 };
}

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
