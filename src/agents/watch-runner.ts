/**
 * Runs founder-hired agents (decision_template = watch | monitor | daily_report).
 *
 * v0 supports three bounded templates instead of arbitrary code:
 *
 *   watch(condition_sql, action_template)
 *     SQL query is run. If it returns ≥1 row, a proposal fires.
 *   monitor(metric, threshold, window_days)
 *     Computes a metric over the window; fires if threshold is crossed.
 *   daily_report(filter, columns)
 *     Generates a summary proposal. Always fires.
 *
 * The condition_sql in `watch` is run with merchant_id appended via a WHERE
 * predicate that we inject — the founder never gets to write merchant_id.
 * For v0 we trust the founder's SQL within their own merchant scope; v1
 * would replace this with a structured query builder.
 */

import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, watches } from "@/db/schema";
import { runAgent } from "./runner";
import type { AgentSpec, ProposalInput } from "./contract";

export async function runWatches(merchant_id: string): Promise<void> {
  const founderAgents = await db
    .select()
    .from(agents)
    .where(
      sql`merchant_id = ${merchant_id} AND hired_by = 'founder' AND status = 'active'`
    );

  for (const a of founderAgents) {
    if (a.decision_template === "watch") {
      const [w] = await db
        .select()
        .from(watches)
        .where(eq(watches.agent_id, a.id))
        .limit(1);
      if (!w) continue;
      await runOne(merchant_id, a, watchSpec(a, w));
    } else if (a.decision_template === "monitor") {
      await runOne(merchant_id, a, monitorSpec(a));
    } else if (a.decision_template === "daily_report") {
      await runOne(merchant_id, a, dailyReportSpec(a));
    }
  }
}

async function runOne(merchant_id: string, agent: any, spec: AgentSpec): Promise<void> {
  await runAgent(spec, { merchant_id, no_narrate: true });
}

function watchSpec(agent: any, w: any): AgentSpec {
  return {
    name: agent.name,
    role: agent.role,
    trigger: "event",
    schedule: agent.schedule ?? "0 * * * *",
    tools: ["metrics", "rows"] as const,
    systemPrompt: agent.system_prompt ?? "",
    authorityCapInr: agent.authority_cap_inr ? Number(agent.authority_cap_inr) : 5000,
    declaredFailureModes: [
      "Watch SQL is founder-supplied — no semantic validation in v0",
      "Fires once per run; doesn't dedupe across runs",
    ] as const,
    async decide(ctx) {
      // The watch's SQL gets a merchant_id binding injected automatically.
      // We wrap the founder-supplied SQL so it must select id (UUID) rows.
      // For safety, we cap LIMIT and add the merchant_id filter as an outer scope.
      const inner = `(${w.condition_sql})`;
      const rows = (await db.execute(
        sql.raw(`SELECT id FROM ${inner} AS _watch WHERE merchant_id = '${ctx.merchant_id}' LIMIT 25`)
      )) as unknown as Array<{ id: string }>;
      if (rows.length === 0) {
        return { proposals: [], reasoning: { fired: false, matches: 0 } };
      }
      const proposal: ProposalInput = {
        action_type: w.action_template ?? "alert",
        target_entity: "watch",
        target_entity_id: w.id,
        payload: {
          watch_name: w.name,
          matched_rows: rows.length,
          first_row_ids: rows.slice(0, 5).map((r) => r.id),
        },
        expected_savings_inr: 0,
        prediction: {
          metric: "watch_matches",
          expected_change: rows.length,
          window_days: 1,
          direction: "decrease",
        },
        confidence: 0.6,
        caveats: ["Watch SQL is founder-defined; semantics not validated"],
        citation_row_ids: rows.slice(0, 10).map((r) => ({ table: "watch_match", id: r.id })),
      };
      return { proposals: [proposal], reasoning: { fired: true, matches: rows.length } };
    },
  };
}

function monitorSpec(agent: any): AgentSpec {
  const params = (agent.decision_params ?? {}) as {
    metric?: string;
    threshold?: number;
    window_days?: number;
    pincode?: string;
    courier?: string;
  };
  return {
    name: agent.name,
    role: agent.role,
    trigger: "cron",
    schedule: agent.schedule ?? "0 7 * * *",
    tools: ["metrics"],
    systemPrompt: agent.system_prompt ?? "",
    authorityCapInr: 5000,
    declaredFailureModes: [
      "Monitor metric set is bounded — see system prompt",
      "No anomaly model; pure threshold trigger",
    ],
    async decide(ctx) {
      const window_days = params.window_days ?? 7;
      const since = new Date(ctx.now.getTime() - window_days * 24 * 60 * 60 * 1000);
      if (params.metric === "rto_rate" && (params.pincode || params.courier)) {
        const r = (await db.execute(sql`
          SELECT
            COUNT(*)::int AS shipments,
            COUNT(*) FILTER (WHERE status='rto_delivered')::int AS rto,
            ROUND(COUNT(*) FILTER (WHERE status='rto_delivered')::numeric / NULLIF(COUNT(*),0),3)::float AS rate,
            ARRAY_AGG(id::text) FILTER (WHERE status='rto_delivered') AS ids
          FROM shipments
          WHERE merchant_id = ${ctx.merchant_id}
            AND fetched_at >= ${since.toISOString()}
            ${params.pincode ? sql`AND pincode = ${params.pincode}` : sql``}
            ${params.courier ? sql`AND courier = ${params.courier}` : sql``}
        `)) as unknown as Array<{ shipments: number; rto: number; rate: number | null; ids: string[] | null }>;
        const rate = r[0].rate ?? 0;
        const threshold = params.threshold ?? 0.5;
        const proposals: ProposalInput[] = [];
        if (rate >= threshold) {
          proposals.push({
            action_type: "alert_threshold_crossed",
            target_entity: "pincode_courier",
            target_entity_id: `${params.courier ?? "*"}::${params.pincode ?? "*"}`,
            payload: { metric: "rto_rate", value: rate, threshold, shipments: r[0].shipments },
            expected_savings_inr: r[0].rto * 1500,
            prediction: {
              metric: "rto_rate",
              expected_change: 0,
              window_days,
              direction: "decrease",
            },
            confidence: 0.7,
            caveats: ["Founder-defined threshold — calibration up to you"],
            citation_row_ids: (r[0].ids ?? []).slice(0, 20).map((id) => ({ table: "shipments", id })),
          });
        }
        return { proposals, reasoning: { rate, threshold, fired: rate >= threshold } };
      }
      return { proposals: [], reasoning: { skipped: true, reason: "metric not supported in v0" } };
    },
  };
}

function dailyReportSpec(agent: any): AgentSpec {
  return {
    name: agent.name,
    role: agent.role,
    trigger: "cron",
    schedule: agent.schedule ?? "0 7 * * *",
    tools: ["metrics"],
    systemPrompt: agent.system_prompt ?? "",
    authorityCapInr: null,
    declaredFailureModes: ["Daily report has no anomaly detection — it just summarizes"],
    async decide(ctx) {
      return {
        proposals: [],
        reasoning: { note: "daily_report template is a v1 build — stub for v0" },
      };
    },
  };
}
