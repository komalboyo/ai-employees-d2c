/**
 * Self-prediction replay grader.
 *
 * Every proposal carries a `prediction`. To grade it we'd need to
 * observe the next N days after the proposal — but in v0 we don't have
 * future data. So we replay: pretend the proposal was filed N days
 * before "now" and compare the prediction against the actual N-day
 * outcome that we *did* observe.
 *
 * The grader writes `actual_outcome` and `accuracy_score` (0..1) onto
 * each proposal. The trust scorecard reads these.
 *
 * Important honesty in the README: this is replay on synthetic, not
 * real causal grading. Real grading needs counterfactual evaluation —
 * which is the "another week" item.
 */

import { sql, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { proposals } from "@/db/schema";

export interface GradeReport {
  graded: number;
  skipped: number;
}

export async function gradeAll(merchant_id: string): Promise<GradeReport> {
  // Pull proposals that don't yet have an actual_outcome.
  const rows = (await db
    .select()
    .from(proposals)
    .where(
      sql`merchant_id = ${merchant_id} AND actual_outcome IS NULL`
    )) as unknown as Array<{
    id: string;
    action_type: string;
    target_entity: string;
    target_entity_id: string;
    prediction: any;
    payload: any;
    created_at: Date;
  }>;

  let graded = 0;
  let skipped = 0;
  for (const p of rows) {
    const result = await gradeOne(merchant_id, p);
    if (result === null) {
      skipped++;
      continue;
    }
    await db
      .update(proposals)
      .set({
        actual_outcome: result.outcome as never,
        accuracy_score: result.accuracy.toString(),
      })
      .where(eq(proposals.id, p.id));
    graded++;
  }
  return { graded, skipped };
}

async function gradeOne(
  merchant_id: string,
  p: { action_type: string; target_entity: string; target_entity_id: string; prediction: any; created_at: Date }
): Promise<{ outcome: Record<string, unknown>; accuracy: number } | null> {
  // Proposals are typically created at the same instant the grader runs,
  // so we cannot wait `window_days` to observe. Instead we replay as if
  // the proposal had been filed `window_days` ago — measuring the most
  // recent window in our data. This is replay-on-synthetic, not real
  // causal grading. README documents the caveat.
  const window = Math.min(p.prediction?.window_days ?? 30, 30);
  const horizon = new Date();
  const since = new Date(horizon.getTime() - window * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const untilIso = horizon.toISOString();

  // Backtest based on action_type.
  if (p.action_type === "pause_ad_set") {
    // If the founder had paused this adset at proposal-time, the projected
    // savings is `expected_savings_inr`. In replay, we measure what the
    // adset's net cost-vs-revenue would have been over the window — that's
    // the realized opportunity.
    const r = (await db.execute(sql`
      WITH spend AS (
        SELECT SUM(asd.spend::numeric) AS spend
        FROM ad_objects ad
        JOIN ad_objects adset ON adset.merchant_id = ad.merchant_id AND adset.source = ad.source
                              AND adset.source_id = ad.parent_source_id AND adset.level='adset'
        JOIN ad_spend_daily asd ON asd.ad_object_id = ad.id
        WHERE ad.merchant_id = ${merchant_id}
          AND ad.level='ad' AND adset.source_id = ${p.target_entity_id}
          AND asd.date >= to_char(${sinceIso}::timestamptz,'YYYY-MM-DD')
          AND asd.date <= to_char(${untilIso}::timestamptz,'YYYY-MM-DD')
      ), rev AS (
        SELECT COALESCE(SUM(o.subtotal::numeric) FILTER (WHERE s.status!='rto_delivered' OR s.status IS NULL),0) AS revenue,
               COALESCE(SUM(s.shipping_cost::numeric),0) AS shipping
        FROM ad_objects adset
        JOIN ad_attributions att ON att.ad_object_id = adset.id
        JOIN orders o ON o.id = att.order_id
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE adset.merchant_id = ${merchant_id} AND adset.source_id = ${p.target_entity_id}
          AND o.placed_at >= ${sinceIso} AND o.placed_at <= ${untilIso}
      )
      SELECT (SELECT spend FROM spend) AS spend,
             (SELECT revenue FROM rev) AS revenue,
             (SELECT shipping FROM rev) AS shipping
    `)) as unknown as Array<{ spend: string; revenue: string; shipping: string }>;
    const spend = Number(r[0]?.spend ?? 0);
    const revenue = Number(r[0]?.revenue ?? 0);
    const shipping = Number(r[0]?.shipping ?? 0);
    const cogs = revenue * 0.4;
    const realized = revenue - cogs - shipping - spend;
    // If realized < 0, pause was the right call — accuracy proportional to predicted magnitude.
    const predicted = Number(p.prediction?.expected_change ?? 0);
    const observed = Math.max(0, -realized); // savings from pausing
    const accuracy = predicted > 0 ? Math.min(1, observed / predicted) : 0;
    return {
      outcome: {
        method: "replay",
        window_days: window,
        observed_realized_margin_inr: Math.round(realized),
        observed_avoidable_loss_inr: Math.round(observed),
        predicted_savings_inr: Math.round(predicted),
      },
      accuracy: Number(accuracy.toFixed(3)),
    };
  }

  if (p.action_type === "reorder_inventory") {
    // Did the SKU actually stock out within the window? If yes, prediction was correct.
    const sku = p.target_entity_id;
    const r = (await db.execute(sql`
      SELECT COUNT(*)::int AS units_sold
      FROM order_lines
      WHERE merchant_id = ${merchant_id} AND sku = ${sku}
        AND fetched_at >= ${sinceIso} AND fetched_at <= ${untilIso}
    `)) as unknown as Array<{ units_sold: number }>;
    const sold = r[0]?.units_sold ?? 0;
    const startInv = (p as any).payload?.inventory ?? 0;
    const stockedOut = sold >= startInv;
    return {
      outcome: { method: "replay", window_days: window, units_sold_during_window: sold, stocked_out: stockedOut },
      accuracy: stockedOut ? 1.0 : 0.6,
    };
  }

  if (p.action_type === "cut_ad_spend") {
    // Replay: was the burn warning vindicated? Look at whether net margin
    // decreased over the window.
    const r = (await db.execute(sql`
      SELECT
        COALESCE(SUM(o.subtotal::numeric) FILTER (WHERE s.status!='rto_delivered' OR s.status IS NULL),0)::numeric AS revenue,
        (SELECT COALESCE(SUM(spend::numeric),0) FROM ad_spend_daily
          WHERE merchant_id = ${merchant_id}
            AND date >= to_char(${sinceIso}::timestamptz,'YYYY-MM-DD')
            AND date <= to_char(${untilIso}::timestamptz,'YYYY-MM-DD'))::numeric AS spend
      FROM orders o
      LEFT JOIN shipments s ON s.order_id = o.id
      WHERE o.merchant_id = ${merchant_id} AND o.placed_at >= ${sinceIso} AND o.placed_at <= ${untilIso}
    `)) as unknown as Array<{ revenue: string; spend: string }>;
    const revenue = Number(r[0]?.revenue ?? 0);
    const spend = Number(r[0]?.spend ?? 0);
    const cogs = revenue * 0.4;
    const realized_net = revenue - cogs - spend;
    return {
      outcome: { method: "replay", window_days: window, realized_net_inr: Math.round(realized_net) },
      accuracy: realized_net < 0 ? 0.85 : 0.5,
    };
  }

  // Default: can't grade.
  return null;
}
