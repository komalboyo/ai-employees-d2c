/**
 * Aanya — the CFO.
 *
 * Projects 30-day net cash trajectory from orders × COGS × ad spend ×
 * shipping × refund/RTO loss. Flags if forecast runway shrinks vs prior
 * week. Ranks levers by ₹-impact per day of runway bought.
 *
 * In v0 we don't model real bank balance; runway is "days to net-zero
 * margin at current trajectory" — a proxy that's good enough to make
 * the action recommendation crisp without inventing a balance sheet.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { AgentSpec, ProposalInput } from "./contract";

export const aanya: AgentSpec = {
  name: "Aanya",
  role: "CFO",
  trigger: "cron",
  schedule: "0 7 * * *",
  tools: ["metrics", "compare"],
  systemPrompt:
    "You are Aanya, the CFO. You watch the line between revenue and outflow. " +
    "You convert noise into runway. You don't romanticize growth; you ask whether " +
    "the founder can survive the next 60 days.",
  authorityCapInr: 100_000,
  declaredFailureModes: [
    "Runway proxy = days-of-positive-net-margin at current trajectory, NOT real bank balance",
    "Refunds + RTO are netted via shipment.status; partial refunds outside Shopify orders are missed",
    "Doesn't yet model recurring SaaS / payroll / fixed costs outside revenue ops",
  ],

  async decide(ctx) {
    const since30d = new Date(ctx.now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const since60d = new Date(ctx.now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const summary = (await db.execute(sql`
      WITH window_30 AS (
        SELECT
          COALESCE(SUM(o.subtotal::numeric) FILTER (WHERE s.status != 'rto_delivered' OR s.status IS NULL), 0)::numeric AS revenue_net,
          COALESCE(SUM(o.subtotal::numeric * 0.4), 0)::numeric AS cogs_proxy,
          COALESCE(SUM(s.shipping_cost::numeric), 0)::numeric AS shipping,
          (SELECT COALESCE(SUM(spend::numeric), 0)
             FROM ad_spend_daily
            WHERE merchant_id = ${ctx.merchant_id}
              AND date >= to_char(${since30d.toISOString()}::timestamptz, 'YYYY-MM-DD')) AS ad_spend,
          ARRAY_AGG(DISTINCT o.id::text) FILTER (WHERE s.status = 'rto_delivered') AS rto_order_ids,
          ARRAY_AGG(DISTINCT o.id::text) AS all_order_ids
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.merchant_id = ${ctx.merchant_id}
          AND o.placed_at >= ${since30d.toISOString()}
      ),
      window_prev AS (
        SELECT
          COALESCE(SUM(o.subtotal::numeric) FILTER (WHERE s.status != 'rto_delivered' OR s.status IS NULL), 0)::numeric AS revenue_net,
          (SELECT COALESCE(SUM(spend::numeric), 0)
             FROM ad_spend_daily
            WHERE merchant_id = ${ctx.merchant_id}
              AND date >= to_char(${since60d.toISOString()}::timestamptz, 'YYYY-MM-DD')
              AND date < to_char(${since30d.toISOString()}::timestamptz, 'YYYY-MM-DD')) AS ad_spend
        FROM orders o
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE o.merchant_id = ${ctx.merchant_id}
          AND o.placed_at >= ${since60d.toISOString()}
          AND o.placed_at < ${since30d.toISOString()}
      )
      SELECT
        (SELECT revenue_net FROM window_30) AS revenue_30,
        (SELECT cogs_proxy FROM window_30) AS cogs_30,
        (SELECT shipping FROM window_30) AS shipping_30,
        (SELECT ad_spend FROM window_30) AS ad_spend_30,
        (SELECT revenue_net FROM window_prev) AS revenue_prev,
        (SELECT ad_spend FROM window_prev) AS ad_spend_prev,
        (SELECT all_order_ids FROM window_30) AS order_ids,
        (SELECT rto_order_ids FROM window_30) AS rto_order_ids
    `)) as unknown as Array<{
      revenue_30: string;
      cogs_30: string;
      shipping_30: string;
      ad_spend_30: string;
      revenue_prev: string;
      ad_spend_prev: string;
      order_ids: string[] | null;
      rto_order_ids: string[] | null;
    }>;

    const [s] = summary;
    const revenue_30 = Number(s.revenue_30);
    const cogs_30 = Number(s.cogs_30);
    const shipping_30 = Number(s.shipping_30);
    const ad_spend_30 = Number(s.ad_spend_30);
    const net_30 = revenue_30 - cogs_30 - shipping_30 - ad_spend_30;
    const revenue_prev = Number(s.revenue_prev);
    const ad_spend_prev = Number(s.ad_spend_prev);

    const burn_rate_change_pct =
      ad_spend_prev > 0 ? ((ad_spend_30 - ad_spend_prev) / ad_spend_prev) * 100 : 0;
    const revenue_change_pct =
      revenue_prev > 0 ? ((revenue_30 - revenue_prev) / revenue_prev) * 100 : 0;

    const reasoning_log = {
      window_days: 30,
      revenue_net_30: Math.round(revenue_30),
      cogs_30: Math.round(cogs_30),
      shipping_30: Math.round(shipping_30),
      ad_spend_30: Math.round(ad_spend_30),
      net_30: Math.round(net_30),
      revenue_change_pct: Number(revenue_change_pct.toFixed(1)),
      burn_rate_change_pct: Number(burn_rate_change_pct.toFixed(1)),
    };

    const proposals: ProposalInput[] = [];

    // Aanya's view of "wasted spend": ad spend going to adsets that *other
    // agents* have flagged for pause this morning. This makes her CFO take
    // composable — she cites Rishi/Meera's work instead of duplicating it.
    const pauseProposals = (ctx.recent_proposals ?? []).filter(
      (p) => p.action_type === "pause_ad_set"
    );
    let wasted_ad_spend_30 = 0;
    const pause_references: { proposal_id: string; relationship: "depends_on" }[] = [];
    if (pauseProposals.length > 0) {
      const flaggedAdsetIds = [...new Set(pauseProposals.map((p) => p.target_entity_id))];
      const idsSql = sql.join(
        flaggedAdsetIds.map((id) => sql`${id}`),
        sql`, `
      );
      const w = (await db.execute(sql`
        SELECT COALESCE(SUM(asd.spend::numeric), 0)::numeric AS wasted
        FROM ad_objects ad
        JOIN ad_objects adset
          ON adset.merchant_id = ad.merchant_id
         AND adset.source = ad.source
         AND adset.source_id = ad.parent_source_id
         AND adset.level = 'adset'
        JOIN ad_spend_daily asd ON asd.ad_object_id = ad.id
        WHERE ad.merchant_id = ${ctx.merchant_id}
          AND ad.level = 'ad'
          AND asd.date >= to_char(${since30d.toISOString()}::timestamptz, 'YYYY-MM-DD')
          AND adset.source_id IN (${idsSql})
      `)) as unknown as Array<{ wasted: string }>;
      wasted_ad_spend_30 = Number(w[0]?.wasted ?? 0);
      for (const p of pauseProposals) {
        pause_references.push({ proposal_id: p.id, relationship: "depends_on" });
      }
    }

    // Trigger conditions (any of):
    //   (a) net margin negative
    //   (b) ad-burn outpaces revenue WoW by >15pp
    //   (c) ad spend > 35% of net revenue
    //   (d) ≥15% of ad spend is going to adsets the team flagged for pause
    const spend_to_revenue_pct = revenue_30 > 0 ? (ad_spend_30 / revenue_30) * 100 : 0;
    const wasted_share = ad_spend_30 > 0 ? wasted_ad_spend_30 / ad_spend_30 : 0;
    const wasted_share_pct = wasted_share * 100;
    Object.assign(reasoning_log, {
      wasted_ad_spend_30: Math.round(wasted_ad_spend_30),
      wasted_share_pct: Number(wasted_share_pct.toFixed(1)),
      pauses_referenced: pause_references.length,
    });
    if (
      net_30 < 0 ||
      burn_rate_change_pct - revenue_change_pct > 15 ||
      spend_to_revenue_pct > 35 ||
      wasted_share > 0.15
    ) {
      // If the team has flagged specific adsets for pause, Aanya's lever
      // is "cut those", quantified — not a blunt 25% cut.
      const suggestedCut =
        wasted_ad_spend_30 > 0
          ? Math.round(wasted_ad_spend_30)
          : Math.round(ad_spend_30 * 0.25);
      proposals.push({
        action_type: "cut_ad_spend",
        target_entity: "merchant",
        target_entity_id: ctx.merchant_id,
        payload: {
          window_days: 30,
          revenue_net_30: Math.round(revenue_30),
          ad_spend_30: Math.round(ad_spend_30),
          net_30: Math.round(net_30),
          wasted_ad_spend_30: Math.round(wasted_ad_spend_30),
          wasted_share_pct: Number(wasted_share_pct.toFixed(1)),
          suggested_cut_inr: suggestedCut,
          suggested_cut_pct:
            ad_spend_30 > 0
              ? Math.round((suggestedCut / ad_spend_30) * 100)
              : 0,
          ad_spend_change_pct: Number(burn_rate_change_pct.toFixed(1)),
          revenue_change_pct: Number(revenue_change_pct.toFixed(1)),
          references_team_pauses: pause_references.length > 0,
        },
        references: pause_references,
        expected_savings_inr: suggestedCut,
        prediction: {
          metric: "monthly_burn_inr",
          expected_change: suggestedCut,
          window_days: 30,
          direction: "decrease",
        },
        confidence: 0.66,
        caveats: [
          "Cutting spend reduces revenue too — net impact depends on which adsets you cut (see Rishi's flags)",
          "Runway is a margin proxy, not real bank balance",
          "COGS is a 40% proxy unless you've uploaded the CSV",
        ],
        citation_row_ids: (s.order_ids ?? []).slice(0, 40).map((id) => ({ table: "orders", id })),
      });
    }

    return { proposals, reasoning: reasoning_log };
  },
};
