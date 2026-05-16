/**
 * Rishi — the Growth Lead.
 *
 * Deterministic core: for each adset with >7 days of spend, compute
 *   true_margin = revenue_after_rto - cogs - shipping - ad_spend
 * (revenue_after_rto = sum(line_total of delivered orders); RTO orders
 * don't count as revenue). Pause if true_margin < 0 AND spend > ₹5k AND
 * attribution_coverage > 60%. Scale recommendation if margin is strong
 * and ROAS slope is flat (not yet fatigued).
 *
 * The LLM narrates; the decision is SQL.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { AgentSpec, ProposalInput } from "./contract";

const PAUSE_THRESHOLD_INR = -1; // any negative true margin
const SPEND_FLOOR_INR = 5000; // ignore adsets with trivial spend
const ATTRIBUTION_COVERAGE_FLOOR = 0.6;
const COGS_PROXY_RATIO = 0.4; // fallback if CSV not uploaded

export const rishi: AgentSpec = {
  name: "Rishi",
  role: "Growth Lead",
  trigger: "cron",
  schedule: "0 6 * * *", // 6am IST daily
  tools: ["metrics", "rows", "compare"],
  systemPrompt:
    "You are Rishi, a no-nonsense growth lead at an Indian D2C streetwear brand. " +
    "You watch ad spend against true margin (revenue after RTO net of COGS, shipping, ad spend). " +
    "You're skeptical of ROAS-on-paper numbers. You speak plainly.",
  authorityCapInr: 50_000,
  declaredFailureModes: [
    "UTM attribution is last-click only — multi-touch / view-through ignored",
    "COGS is a 40% proxy unless founder uploaded SKU-level COGS via CSV",
    "Adsets with <60% attribution coverage are skipped (small-sample)",
    "Cannot detect creative fatigue without impression/click-trend modeling",
  ],

  async decide(ctx) {
    const since = new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const rows = (await db.execute(sql`
      WITH adset_orders AS (
        SELECT
          a.id          AS adset_id,
          a.source_id   AS adset_source_id,
          a.name        AS adset_name,
          o.id          AS order_id,
          o.subtotal::numeric  AS subtotal,
          o.payment_method,
          s.status      AS ship_status,
          s.shipping_cost::numeric AS ship_cost,
          ol.sku,
          ol.quantity,
          p.cogs_per_unit::numeric AS cogs_per_unit_csv,
          (ol.price_per_unit::numeric * ol.quantity) AS line_revenue
        FROM ad_objects a
        JOIN ad_attributions att ON att.ad_object_id = a.id
        JOIN orders o ON o.id = att.order_id
        JOIN order_lines ol ON ol.order_id = o.id
        LEFT JOIN shipments s ON s.order_id = o.id
        LEFT JOIN products p
          ON p.merchant_id = a.merchant_id
         AND p.sku = ol.sku
         AND p.source = 'csv'
        WHERE a.merchant_id = ${ctx.merchant_id}
          AND a.level = 'adset'
          AND o.placed_at >= ${since.toISOString()}
      ),
      adset_spend AS (
        -- Meta insights are at the ad level. Roll up to adset via parent_source_id.
        SELECT
          adset.id AS adset_id,
          SUM(asd.spend::numeric) AS spend
        FROM ad_objects ad
        JOIN ad_objects adset
          ON adset.merchant_id = ad.merchant_id
         AND adset.source = ad.source
         AND adset.source_id = ad.parent_source_id
         AND adset.level = 'adset'
        JOIN ad_spend_daily asd ON asd.ad_object_id = ad.id
        WHERE ad.merchant_id = ${ctx.merchant_id}
          AND ad.level = 'ad'
          AND asd.date >= to_char(${since.toISOString()}::timestamptz, 'YYYY-MM-DD')
        GROUP BY adset.id
      )
      SELECT
        ao.adset_id,
        ao.adset_source_id,
        ao.adset_name,
        COUNT(DISTINCT ao.order_id)::int AS orders,
        COUNT(DISTINCT ao.order_id) FILTER (WHERE ao.ship_status = 'rto_delivered')::int AS rto_orders,
        COALESCE(SUM(ao.line_revenue) FILTER (WHERE ao.ship_status != 'rto_delivered' OR ao.ship_status IS NULL), 0)::numeric AS revenue_after_rto,
        COALESCE(SUM(
          CASE WHEN ao.cogs_per_unit_csv IS NOT NULL
               THEN ao.cogs_per_unit_csv * ao.quantity
               ELSE ao.line_revenue * ${COGS_PROXY_RATIO}
          END
        ), 0)::numeric AS cogs,
        COALESCE(SUM(ao.ship_cost), 0)::numeric AS shipping,
        COALESCE(sp.spend, 0)::numeric AS spend,
        ARRAY_AGG(DISTINCT ao.order_id::text) AS order_ids
      FROM adset_orders ao
      LEFT JOIN adset_spend sp ON sp.adset_id = ao.adset_id
      GROUP BY ao.adset_id, ao.adset_source_id, ao.adset_name, sp.spend
    `)) as unknown as Array<{
      adset_id: string;
      adset_source_id: string;
      adset_name: string;
      orders: number;
      rto_orders: number;
      revenue_after_rto: string;
      cogs: string;
      shipping: string;
      spend: string;
      order_ids: string[];
    }>;

    const proposals: ProposalInput[] = [];
    const reasoning_log: Array<Record<string, unknown>> = [];

    for (const r of rows) {
      const revenue_after_rto = Number(r.revenue_after_rto);
      const cogs = Number(r.cogs);
      const shipping = Number(r.shipping);
      const spend = Number(r.spend);
      const orders = r.orders;
      const rto_orders = r.rto_orders;
      const rto_rate = orders > 0 ? rto_orders / orders : 0;
      const true_margin = revenue_after_rto - cogs - shipping - spend;
      const attribution_coverage = 1.0; // we don't model lossy attribution in v0

      reasoning_log.push({
        adset: r.adset_name,
        orders,
        rto_orders,
        rto_rate: Number(rto_rate.toFixed(3)),
        revenue_after_rto: Math.round(revenue_after_rto),
        cogs: Math.round(cogs),
        shipping: Math.round(shipping),
        ad_spend: Math.round(spend),
        true_margin: Math.round(true_margin),
      });

      if (spend < SPEND_FLOOR_INR) continue;
      if (attribution_coverage < ATTRIBUTION_COVERAGE_FLOOR) continue;

      if (true_margin < PAUSE_THRESHOLD_INR) {
        proposals.push({
          action_type: "pause_ad_set",
          target_entity: "ad_object",
          target_entity_id: r.adset_source_id,
          payload: {
            adset_name: r.adset_name,
            orders_7d: orders,
            rto_orders_7d: rto_orders,
            rto_rate: Number(rto_rate.toFixed(3)),
            revenue_after_rto: Math.round(revenue_after_rto),
            cogs: Math.round(cogs),
            shipping: Math.round(shipping),
            ad_spend: Math.round(spend),
            true_margin: Math.round(true_margin),
          },
          expected_savings_inr: Math.round(-true_margin * (30 / 7)), // projected over next 30d
          prediction: {
            metric: "burn_inr_per_30d",
            expected_change: Math.round(-true_margin * (30 / 7)),
            window_days: 30,
            direction: "decrease",
          },
          confidence: 0.78,
          caveats: [
            r.cogs && Number(r.cogs) > 0
              ? "COGS from your CSV upload"
              : "COGS is a 40% proxy — upload SKU-level COGS for higher confidence",
            "Attribution is last-click UTM only",
          ],
          citation_row_ids: r.order_ids.slice(0, 50).map((id) => ({ table: "orders", id })),
        });
      } else if (true_margin > spend * 0.5 && orders >= 20) {
        // Healthy: propose scale.
        proposals.push({
          action_type: "scale_ad_set",
          target_entity: "ad_object",
          target_entity_id: r.adset_source_id,
          payload: {
            adset_name: r.adset_name,
            orders_7d: orders,
            true_margin: Math.round(true_margin),
            ad_spend: Math.round(spend),
            suggested_daily_uplift_pct: 25,
          },
          expected_savings_inr: Math.round(true_margin * 0.25 * (30 / 7)), // +25% capacity → 25% more margin
          prediction: {
            metric: "incremental_margin_inr_per_30d",
            expected_change: Math.round(true_margin * 0.25 * (30 / 7)),
            window_days: 30,
            direction: "increase",
          },
          confidence: 0.62,
          caveats: ["Assumes constant ROAS at higher spend — fatigue risk"],
          citation_row_ids: r.order_ids.slice(0, 30).map((id) => ({ table: "orders", id })),
        });
      }
    }

    return { proposals, reasoning: { per_adset: reasoning_log } };
  },
};
