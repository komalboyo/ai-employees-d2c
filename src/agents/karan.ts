/**
 * Karan — the Supply Lead.
 *
 * For each SKU: stockout_date = inventory / daily_velocity.
 * Flag if stockout < 2 × lead_time. Suggest reorder quantity =
 * (lead_time + buffer) × velocity, rounded.
 *
 * Cross-agent reference: if one of Rishi's pending pauses targets an
 * adset that drives velocity for a flagged SKU, Karan's proposal
 * references it ("If Rishi's pause goes through, reorder drops from X
 * to Y"). This shows the AI team working as a team.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { AgentSpec, ProposalInput } from "./contract";

const VELOCITY_WINDOW_DAYS = 14;
const DEFAULT_LEAD_TIME_DAYS = 21;
const SAFETY_BUFFER_DAYS = 7;

export const karan: AgentSpec = {
  name: "Karan",
  role: "Supply Lead",
  trigger: "cron",
  schedule: "30 6 * * *",
  tools: ["metrics", "rows"],
  systemPrompt:
    "You are Karan, the supply lead. You forecast stockouts and pile-ups. " +
    "You watch velocity, ad pacing, and lead times together — never in isolation. " +
    "You speak in dates: 'stocks out by the 23rd, reorder by tomorrow'.",
  authorityCapInr: 200_000,
  declaredFailureModes: [
    "Lead time is a constant (21 days) until founder uploads per-SKU lead times",
    "Velocity model is a flat 14-day rolling average — no seasonality or trend",
    "Reorder quantity ignores supplier MOQ, supplier capacity, and cash constraints",
    "Doesn't predict velocity drop if a referenced ad campaign is paused — caveat included instead",
  ],

  async decide(ctx) {
    const since = new Date(ctx.now.getTime() - VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const rows = (await db.execute(sql`
      WITH velocity AS (
        SELECT
          ol.sku,
          SUM(ol.quantity)::numeric / ${VELOCITY_WINDOW_DAYS}::numeric AS daily_velocity,
          COUNT(DISTINCT ol.order_id)::int AS orders_in_window,
          ARRAY_AGG(DISTINCT ol.order_id::text) AS order_ids
        FROM order_lines ol
        WHERE ol.merchant_id = ${ctx.merchant_id}
          AND ol.fetched_at >= ${since.toISOString()}
        GROUP BY ol.sku
      ),
      attribution_share AS (
        SELECT
          ol.sku,
          ao.source_id AS adset_source_id,
          ao.name AS adset_name,
          COUNT(DISTINCT ol.order_id)::int AS attributed_orders
        FROM order_lines ol
        JOIN ad_attributions att ON att.order_id = ol.order_id
        JOIN ad_objects ao ON ao.id = att.ad_object_id AND ao.level = 'adset'
        WHERE ol.merchant_id = ${ctx.merchant_id}
          AND ol.fetched_at >= ${since.toISOString()}
        GROUP BY ol.sku, ao.source_id, ao.name
      ),
      shopify_inv AS (
        SELECT sku, inventory FROM products
        WHERE merchant_id = ${ctx.merchant_id} AND source = 'shopify'
      )
      SELECT
        v.sku,
        v.daily_velocity::float AS daily_velocity,
        si.inventory,
        v.orders_in_window,
        v.order_ids,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'adset_source_id', a.adset_source_id,
            'adset_name', a.adset_name,
            'share', a.attributed_orders::float / v.orders_in_window
          ))
           FROM attribution_share a
           WHERE a.sku = v.sku),
          '[]'::json
        ) AS attribution
      FROM velocity v
      LEFT JOIN shopify_inv si ON si.sku = v.sku
      WHERE si.inventory IS NOT NULL AND v.daily_velocity > 0
    `)) as unknown as Array<{
      sku: string;
      daily_velocity: number;
      inventory: number;
      orders_in_window: number;
      order_ids: string[];
      attribution: Array<{ adset_source_id: string; adset_name: string; share: number }>;
    }>;

    const proposals: ProposalInput[] = [];
    const reasoning_log: any[] = [];

    // Find Rishi's pending pause adsets (for cross-reference).
    const pending = (ctx.recent_proposals ?? [])
      .filter((p) => p.action_type === "pause_ad_set")
      .map((p) => ({ id: p.id, adset_source_id: p.target_entity_id, agent: p.agent_name }));

    for (const r of rows) {
      const days_to_stockout = r.daily_velocity > 0 ? r.inventory / r.daily_velocity : Infinity;
      const lead_time = DEFAULT_LEAD_TIME_DAYS;

      reasoning_log.push({
        sku: r.sku,
        velocity_per_day: Number(r.daily_velocity.toFixed(2)),
        inventory: r.inventory,
        days_to_stockout: Number(days_to_stockout.toFixed(1)),
        lead_time,
      });

      // Only flag genuinely urgent reorders — stockout within lead time.
      if (days_to_stockout >= lead_time) continue;

      const base_reorder_qty = Math.ceil(r.daily_velocity * (lead_time + SAFETY_BUFFER_DAYS));

      // Check whether any pending Rishi-pause targets an adset that drives this SKU.
      const overlapping = r.attribution.filter((a) =>
        pending.some((p) => p.adset_source_id === a.adset_source_id)
      );
      const overlapping_share = overlapping.reduce((s, a) => s + a.share, 0);
      const conditional_qty = Math.ceil(base_reorder_qty * (1 - overlapping_share));

      const references = pending
        .filter((p) =>
          r.attribution.some(
            (a) => a.adset_source_id === p.adset_source_id && a.share >= 0.1
          )
        )
        .map((p) => ({
          proposal_id: p.id,
          relationship: "depends_on" as const,
        }));

      proposals.push({
        action_type: "reorder_inventory",
        target_entity: "sku",
        target_entity_id: r.sku,
        payload: {
          sku: r.sku,
          daily_velocity: Number(r.daily_velocity.toFixed(2)),
          inventory: r.inventory,
          days_to_stockout: Number(days_to_stockout.toFixed(1)),
          lead_time_days: lead_time,
          recommended_qty: base_reorder_qty,
          conditional_qty,
          conditional_note:
            overlapping_share > 0
              ? `If pending pause(s) on ${overlapping.map((a) => a.adset_name).join(", ")} go through, velocity is expected to drop ~${(overlapping_share * 100).toFixed(0)}% — adjust order to ${conditional_qty}.`
              : null,
          dominant_adsets: r.attribution
            .sort((a, b) => b.share - a.share)
            .slice(0, 3)
            .map((a) => ({ adset: a.adset_name, share_of_orders: Number(a.share.toFixed(2)) })),
        },
        expected_savings_inr: Math.round(base_reorder_qty * 1500 * 0.3), // proxy for stockout loss avoided
        prediction: {
          metric: "stockout_loss_inr",
          expected_change: Math.round(base_reorder_qty * 1500 * 0.3),
          window_days: lead_time,
          direction: "decrease",
        },
        confidence: 0.74,
        caveats: [
          "Lead time = 21d default until you upload per-SKU lead times",
          "Velocity is a flat 14d average — no trend or seasonality",
          ...(overlapping_share > 0
            ? [`Velocity partly driven by adsets at risk of pause — recommended qty is conditional`]
            : []),
        ],
        citation_row_ids: r.order_ids.slice(0, 30).map((id) => ({ table: "orders", id })),
        references,
      });
    }

    return { proposals, reasoning: { per_sku: reasoning_log } };
  },
};
