/**
 * Meera — the Ops Lead.
 *
 * Two responsibilities:
 *  1. Pre-dispatch RTO risk on every undispatched order. (Event-driven,
 *     but in the v0 cron-only model she runs hourly and scores
 *     in-transit orders too.)
 *  2. Courier-pincode lane degradation monitor.
 *
 * For the adset-level proposal that intersects with Rishi's pause:
 * when a courier-pincode lane carries N+ orders attributed to a single
 * adset and that lane's RTO rate exceeds 40%, Meera proposes pausing
 * the *same adset* — for an ops reason, not a margin reason. This is
 * the engineered disagreement: same target_entity, different
 * action_type, different reasoning.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { AgentSpec, ProposalInput } from "./contract";

const RTO_RATE_THRESHOLD = 0.40;
const MIN_ORDERS_PER_LANE = 15;

export const meera: AgentSpec = {
  name: "Meera",
  role: "Ops Lead",
  trigger: "cron",
  schedule: "15 * * * *", // every hour, 15 min past
  tools: ["metrics", "rows"],
  systemPrompt:
    "You are Meera, the ops lead — pragmatic, fulfillment-obsessed, Hindi-English bilingual mindset. " +
    "You watch RTO patterns by pincode-courier-payment-method. Your job is to stop bad orders from going out " +
    "and to flag degrading lanes before the founder feels them. You think in WHY-this-RTOs.",
  authorityCapInr: 30_000,
  declaredFailureModes: [
    "Pre-dispatch RTO model uses historical pincode-courier-payment-method rates only — no customer signals",
    "30-day rolling window may mask seasonal lanes (e.g. monsoon)",
    "Courier lane degradation triggers without root-cause attribution",
    "Doesn't yet propose customer-side flagging (COD-restrict on repeat offenders)",
  ],

  async decide(ctx) {
    const since30d = new Date(ctx.now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ---- 1. Adset-level RTO concentration → potential disagreement with Rishi ----
    const adsetRows = (await db.execute(sql`
      SELECT
        a.id            AS adset_id,
        a.source_id     AS adset_source_id,
        a.name          AS adset_name,
        COUNT(DISTINCT o.id)::int AS orders,
        COUNT(DISTINCT o.id) FILTER (WHERE s.status = 'rto_delivered')::int AS rto_orders,
        COUNT(*) FILTER (WHERE o.payment_method = 'cod')::int AS cod_orders,
        ARRAY_AGG(DISTINCT s.pincode) FILTER (WHERE s.status = 'rto_delivered') AS rto_pincodes,
        ARRAY_AGG(DISTINCT s.courier) FILTER (WHERE s.status = 'rto_delivered') AS rto_couriers,
        ARRAY_AGG(DISTINCT o.id::text) FILTER (WHERE s.status = 'rto_delivered') AS rto_order_ids
      FROM ad_objects a
      JOIN ad_attributions att ON att.ad_object_id = a.id
      JOIN orders o ON o.id = att.order_id
      LEFT JOIN shipments s ON s.order_id = o.id
      WHERE a.merchant_id = ${ctx.merchant_id}
        AND a.level = 'adset'
        AND o.placed_at >= ${since30d.toISOString()}
      GROUP BY a.id, a.source_id, a.name
      HAVING COUNT(DISTINCT o.id) >= ${MIN_ORDERS_PER_LANE}
    `)) as unknown as Array<{
      adset_id: string;
      adset_source_id: string;
      adset_name: string;
      orders: number;
      rto_orders: number;
      cod_orders: number;
      rto_pincodes: string[] | null;
      rto_couriers: string[] | null;
      rto_order_ids: string[] | null;
    }>;

    const proposals: ProposalInput[] = [];
    const reasoning_log: Record<string, unknown> = { per_adset: [], degraded_lanes: [] };

    for (const r of adsetRows) {
      const rto_rate = r.orders > 0 ? r.rto_orders / r.orders : 0;
      (reasoning_log.per_adset as any[]).push({
        adset: r.adset_name,
        orders: r.orders,
        rto_orders: r.rto_orders,
        rto_rate: Number(rto_rate.toFixed(3)),
        cod_orders: r.cod_orders,
      });
      if (rto_rate < RTO_RATE_THRESHOLD) continue;
      // Trigger: pause this adset for an ops reason. Action is the same as Rishi's,
      // but the reasoning is operational (RTO) rather than financial (margin).
      proposals.push({
        action_type: "pause_ad_set",
        target_entity: "ad_object",
        target_entity_id: r.adset_source_id,
        payload: {
          adset_name: r.adset_name,
          orders_30d: r.orders,
          rto_orders_30d: r.rto_orders,
          rto_rate: Number(rto_rate.toFixed(3)),
          cod_share: r.cod_orders / Math.max(r.orders, 1),
          concentrated_pincodes: r.rto_pincodes?.slice(0, 5) ?? [],
          concentrated_couriers: r.rto_couriers ?? [],
          reason: "ops-side: adset drives orders concentrated in high-RTO lanes",
        },
        expected_savings_inr: Math.round(r.rto_orders * 1500), // approx avg order + ship cost waste
        prediction: {
          metric: "rto_loss_inr_per_30d",
          expected_change: Math.round(r.rto_orders * 1500),
          window_days: 30,
          direction: "decrease",
        },
        confidence: 0.72,
        caveats: [
          "Doesn't account for the customers this adset reaches who eventually convert via other channels",
          "Alternative: keep adset, swap courier on flagged pincodes",
        ],
        citation_row_ids: (r.rto_order_ids ?? []).slice(0, 50).map((id) => ({ table: "orders", id })),
      });
    }

    // ---- 2. Degraded courier-pincode lanes ----
    const laneRows = (await db.execute(sql`
      SELECT
        s.courier,
        s.pincode,
        COUNT(*)::int AS shipments,
        COUNT(*) FILTER (WHERE s.status = 'rto_delivered')::int AS rto,
        ARRAY_AGG(s.id::text ORDER BY s.fetched_at DESC) FILTER (WHERE s.status = 'rto_delivered') AS rto_ids
      FROM shipments s
      WHERE s.merchant_id = ${ctx.merchant_id}
        AND s.fetched_at >= ${since30d.toISOString()}
      GROUP BY s.courier, s.pincode
      HAVING COUNT(*) >= ${MIN_ORDERS_PER_LANE}
         AND (COUNT(*) FILTER (WHERE s.status = 'rto_delivered')::float / COUNT(*)) >= 0.30
      ORDER BY (COUNT(*) FILTER (WHERE s.status = 'rto_delivered')::float / COUNT(*)) DESC
      LIMIT 5
    `)) as unknown as Array<{
      courier: string;
      pincode: string;
      shipments: number;
      rto: number;
      rto_ids: string[] | null;
    }>;

    for (const lane of laneRows) {
      const rto_rate = lane.rto / lane.shipments;
      (reasoning_log.degraded_lanes as any[]).push({
        lane: `${lane.courier}::${lane.pincode}`,
        shipments: lane.shipments,
        rto: lane.rto,
        rto_rate: Number(rto_rate.toFixed(3)),
      });
      proposals.push({
        action_type: "swap_courier_on_lane",
        target_entity: "pincode_courier",
        target_entity_id: `${lane.courier}::${lane.pincode}`,
        payload: {
          courier: lane.courier,
          pincode: lane.pincode,
          rto_rate: Number(rto_rate.toFixed(3)),
          shipments_30d: lane.shipments,
          suggested_alternative: lane.courier === "Bluedart" ? "Delhivery" : "Bluedart",
        },
        expected_savings_inr: Math.round(lane.rto * 1500 * 0.5), // halve RTO with courier swap
        prediction: {
          metric: "rto_loss_inr_per_30d",
          expected_change: Math.round(lane.rto * 1500 * 0.5),
          window_days: 30,
          direction: "decrease",
        },
        confidence: 0.60,
        caveats: [
          "Assumes alternative courier performs ~baseline on this pincode",
          "Switching cost (negotiation, integration) not modeled",
        ],
        citation_row_ids: (lane.rto_ids ?? []).slice(0, 30).map((id) => ({ table: "shipments", id })),
      });
    }

    return { proposals, reasoning: reasoning_log };
  },
};
