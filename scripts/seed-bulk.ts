/**
 * Bulk seeder for scale benchmarks.
 *
 * Generates N synthetic merchants with realistic order/spend/shipment
 * volumes and writes DIRECTLY to Postgres (skipping the
 * fixture→connector→orchestrator path). This is intentional: the
 * connector path is exercised end-to-end by the demo merchant; for 1k
 * synthetic merchants we measure the storage + agent layer at scale.
 *
 * Usage: SEED_MERCHANTS=1000 SEED_DAYS=7 npm run seed:bulk
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { pg, db } from "@/db/client";
import { merchants } from "@/db/schema";
import { rng } from "@/seed/rng";
import { ADSETS, PINCODES, COURIERS, PRODUCTS } from "@/seed/business";

interface BulkOpts {
  merchants: number;
  days: number;
  seed: number;
}

async function main() {
  const opts: BulkOpts = {
    merchants: Number(process.env.SEED_MERCHANTS ?? 100),
    days: Number(process.env.SEED_DAYS ?? 7),
    seed: Number(process.env.SEED_RNG ?? 42),
  };
  console.log(`[seed:bulk] ${opts.merchants} merchants × ${opts.days} days (rng=${opts.seed})`);
  const t0 = Date.now();

  // Clean prior synthetic merchants.
  await db.execute(sql`DELETE FROM merchants WHERE name LIKE 'Synth-%'`);

  // Bulk insert merchants.
  console.log("[seed:bulk] creating merchants...");
  const merchantIds: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < opts.merchants; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH, opts.merchants); j++) {
      batch.push({ name: `Synth-${j.toString().padStart(5, "0")}`, currency: "INR", timezone: "Asia/Kolkata" });
    }
    const inserted = await db.insert(merchants).values(batch).returning({ id: merchants.id });
    for (const r of inserted) merchantIds.push(r.id);
  }
  console.log(`[seed:bulk]   ${merchantIds.length} merchants in ${ms(t0)}`);

  // Phase 2: per-merchant bulk writes. We do them in a transaction-batched
  // way to stay under PG parameter limits, but with concurrent merchants.
  const tBulk = Date.now();
  let totalOrders = 0, totalShipments = 0, totalAdSpend = 0, totalAttrib = 0;

  const CONCURRENT = 12;
  for (let i = 0; i < merchantIds.length; i += CONCURRENT) {
    const batch = merchantIds.slice(i, i + CONCURRENT);
    const results = await Promise.all(batch.map((mid, k) => writeMerchantData(mid, opts, opts.seed + i + k)));
    for (const r of results) {
      totalOrders += r.orders;
      totalShipments += r.shipments;
      totalAdSpend += r.ad_spend;
      totalAttrib += r.attrib;
    }
    if ((i + CONCURRENT) % 100 === 0) {
      console.log(`[seed:bulk]   ${Math.min(i + CONCURRENT, merchantIds.length)}/${merchantIds.length} done`);
    }
  }

  const elapsed = Date.now() - tBulk;
  console.log(`\n[seed:bulk] complete in ${ms(t0)}`);
  console.table({
    merchants: merchantIds.length,
    orders: totalOrders,
    shipments: totalShipments,
    ad_spend_daily: totalAdSpend,
    ad_attributions: totalAttrib,
    bulk_data_ms: elapsed,
    per_merchant_ms: Math.round(elapsed / merchantIds.length),
  });

  await pg.end();
}

async function writeMerchantData(
  merchant_id: string,
  opts: BulkOpts,
  seed: number
): Promise<{ orders: number; shipments: number; ad_spend: number; attrib: number }> {
  const r = rng(seed);
  const now = new Date();
  const days = opts.days;

  // One raw_payload row covers all writes for this merchant (fast, lossy
  // for provenance granularity but acceptable for benchmark data).
  const rawId = (await pg.unsafe(
    `INSERT INTO raw_payloads (merchant_id, source, resource, content_hash, payload, fetched_at)
     VALUES ($1, 'shopify', 'bulk', $2, $3, now())
     RETURNING id`,
    [merchant_id, `bulk-${merchant_id}-${seed}`, JSON.stringify({ synthetic: true })] as never[]
  )) as unknown as Array<{ id: string }>;
  const raw_payload_id = rawId[0].id;

  // Products
  const productIds: string[] = [];
  const productRows = PRODUCTS.map((p, idx) => [
    merchant_id, p.sku, p.title, p.category, p.price, null, p.start_inventory,
    "shopify", `s-${idx}`, raw_payload_id, now,
  ]);
  const productResp = (await pg.unsafe(
    `INSERT INTO products (merchant_id, sku, title, category, price, cogs_per_unit, inventory, source, source_id, raw_payload_id, fetched_at)
     VALUES ${productRows.map((_, i) => `($${i * 11 + 1},$${i * 11 + 2},$${i * 11 + 3},$${i * 11 + 4},$${i * 11 + 5},$${i * 11 + 6},$${i * 11 + 7},$${i * 11 + 8},$${i * 11 + 9},$${i * 11 + 10},$${i * 11 + 11})`).join(",")}
     RETURNING id`,
    paramize(productRows.flat()) as never[]
  )) as unknown as Array<{ id: string }>;
  for (const p of productResp) productIds.push(p.id);

  // ad_objects (1 ad per adset = 4 ad rows + 4 adset rows + 2 campaign rows)
  const adObjectRows: any[] = [];
  const campaignIds = [...new Set(ADSETS.map((a) => a.campaign.id))];
  for (const cid of campaignIds) {
    adObjectRows.push([merchant_id, "campaign", `Campaign ${cid}`, null, "ACTIVE", "meta", cid, raw_payload_id, now]);
  }
  for (const a of ADSETS) {
    adObjectRows.push([merchant_id, "adset", a.adset.name, a.campaign.id, "ACTIVE", "meta", a.adset.id, raw_payload_id, now]);
    adObjectRows.push([merchant_id, "ad", `${a.adset.name} Ad`, a.adset.id, "ACTIVE", "meta", `ad_${a.adset.id}`, raw_payload_id, now]);
  }
  const adInserted = (await pg.unsafe(
    `INSERT INTO ad_objects (merchant_id, level, name, parent_source_id, status, source, source_id, raw_payload_id, fetched_at)
     VALUES ${adObjectRows.map((_, i) => `($${i*9+1},$${i*9+2},$${i*9+3},$${i*9+4},$${i*9+5},$${i*9+6},$${i*9+7},$${i*9+8},$${i*9+9})`).join(",")}
     RETURNING id, level, source_id`,
    paramize(adObjectRows.flat()) as never[]
  )) as unknown as Array<{ id: string; level: string; source_id: string }>;
  const adObjectMap = new Map(adInserted.map((a) => [`${a.level}::${a.source_id}`, a.id]));

  // ad_spend_daily (1 row per ad × day)
  const adSpendRows: any[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const dayStr = new Date(now.getTime() - d * 86400000).toISOString().slice(0, 10);
    for (const a of ADSETS) {
      const noise = 0.85 + r.next() * 0.3;
      const spend = a.daily_spend * noise;
      const impr = Math.round(spend / 0.4);
      const clicks = Math.round(impr * a.click_through_rate);
      const adId = adObjectMap.get(`ad::ad_${a.adset.id}`)!;
      adSpendRows.push([
        merchant_id, adId, dayStr, spend.toFixed(2), impr, clicks,
        "meta", `s-${adId}-${dayStr}`, raw_payload_id, now,
      ]);
    }
  }
  if (adSpendRows.length > 0) {
    await pg.unsafe(
      `INSERT INTO ad_spend_daily (merchant_id, ad_object_id, date, spend, impressions, clicks, source, source_id, raw_payload_id, fetched_at)
       VALUES ${adSpendRows.map((_, i) => `($${i*10+1},$${i*10+2},$${i*10+3},$${i*10+4},$${i*10+5},$${i*10+6},$${i*10+7},$${i*10+8},$${i*10+9},$${i*10+10})`).join(",")}`,
      paramize(adSpendRows.flat()) as never[]
    );
  }

  // Orders + order_lines + shipments + attributions
  const orderRows: any[] = [];
  const lineRows: any[] = [];
  const shipRows: any[] = [];
  const attribRows: any[] = [];
  let orderSeq = 0, lineSeq = 0, shipSeq = 0, attribSeq = 0;

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86400000);
    for (const a of ADSETS) {
      const impr = Math.round(a.daily_spend / 0.4);
      const clicks = Math.round(impr * a.click_through_rate);
      const ordersToday = Math.round(clicks * a.conversion_rate);
      for (let i = 0; i < ordersToday; i++) {
        const sku = r.pick(a.preferred_skus);
        const sIdx = PRODUCTS.findIndex((p) => p.sku === sku);
        if (sIdx === -1) continue;
        const product = PRODUCTS[sIdx];
        const pincode = a.preferred_pincodes ? r.pick(a.preferred_pincodes) : r.pick(PINCODES.map((p) => p.pin));
        const pin = PINCODES.find((p) => p.pin === pincode)!;
        const isCod = r.next() < a.payment_cod_share;
        const qty = 1;
        const subtotal = product.price * qty;
        const shipping = isCod ? 80 : 0;
        const total = subtotal + shipping;

        const placedAt = new Date(day.getTime() + r.int(0, 86400000));
        const orderSrcId = `o-${orderSeq++}`;
        orderRows.push([
          merchant_id, String(orderSeq + 100000), placedAt, null, `c${r.int(1000,9999)}@x`, isCod ? "cod" : "prepaid",
          subtotal.toFixed(2), shipping.toFixed(2), "0.00", total.toFixed(2),
          "meta", "paid_social", a.campaign.id, a.adset.id, pin.pin, pin.city, pin.state,
          "shopify", orderSrcId, raw_payload_id, now,
        ]);
        lineRows.push([
          merchant_id, orderSrcId /* parent ref placeholder */, productIds[sIdx],
          sku, product.title, qty, product.price.toFixed(2), subtotal.toFixed(2),
          "shopify", `l-${lineSeq++}`, raw_payload_id, now,
        ]);

        const courier = a.preferred_courier ?? r.pick(COURIERS);
        const codMult = isCod ? pin.cod_mult : 1.0;
        const lane = `${courier}::${pin.pin}`;
        const laneMult = (a as any).preferred_courier && pin.base_rto > 0.15 ? 1.9 : 1.0;
        const rtoProb = Math.min(0.95, pin.base_rto * codMult * laneMult);
        const willRto = r.next() < rtoProb;
        let status = "delivered";
        if (willRto) status = "rto_delivered";
        shipRows.push([
          merchant_id, orderSrcId, String(7000000 + shipSeq), courier, pin.pin, status,
          isCod ? "95.00" : "65.00", willRto ? r.int(1,3) : 0,
          new Date(placedAt.getTime() + 86400000), willRto ? null : new Date(placedAt.getTime() + 5*86400000), willRto ? new Date(placedAt.getTime() + 8*86400000) : null,
          "shiprocket", `sh-${shipSeq++}`, raw_payload_id, now,
        ]);

        const adsetId = adObjectMap.get(`adset::${a.adset.id}`)!;
        attribRows.push([
          merchant_id, orderSrcId, adsetId, "utm_content", "0.85",
          "shopify", `at-${attribSeq++}`, raw_payload_id, now,
        ]);
      }
    }
  }

  // Insert orders, then resolve FKs for lines/shipments/attributions.
  if (orderRows.length === 0) {
    return { orders: 0, shipments: 0, ad_spend: adSpendRows.length, attrib: 0 };
  }

  const orderIns = (await pg.unsafe(
    `INSERT INTO orders (merchant_id, order_number, placed_at, customer_id, customer_email, payment_method, subtotal, shipping_charged, discount, total, utm_source, utm_medium, utm_campaign, utm_content, ship_pincode, ship_city, ship_state, source, source_id, raw_payload_id, fetched_at)
     VALUES ${orderRows.map((_, i) => `(${range(i, 21)})`).join(",")}
     RETURNING id, source_id`,
    paramize(orderRows.flat()) as never[]
  )) as unknown as Array<{ id: string; source_id: string }>;
  const orderMap = new Map(orderIns.map((o) => [o.source_id, o.id]));

  // Replace placeholders with real ids in lineRows, shipRows, attribRows.
  for (const l of lineRows) l[1] = orderMap.get(l[1]) ?? null;
  for (const s of shipRows) s[1] = orderMap.get(s[1]) ?? null;
  for (const at of attribRows) at[1] = orderMap.get(at[1]) ?? null;

  await pg.unsafe(
    `INSERT INTO order_lines (merchant_id, order_id, product_id, sku, title, quantity, price_per_unit, line_total, source, source_id, raw_payload_id, fetched_at)
     VALUES ${lineRows.map((_, i) => `(${range(i, 12)})`).join(",")}`,
    paramize(lineRows.flat()) as never[]
  );
  await pg.unsafe(
    `INSERT INTO shipments (merchant_id, order_id, awb, courier, pincode, status, shipping_cost, ndr_count, dispatched_at, delivered_at, rto_at, source, source_id, raw_payload_id, fetched_at)
     VALUES ${shipRows.map((_, i) => `(${range(i, 15)})`).join(",")}`,
    paramize(shipRows.flat()) as never[]
  );
  await pg.unsafe(
    `INSERT INTO ad_attributions (merchant_id, order_id, ad_object_id, match_method, confidence, source, source_id, raw_payload_id, fetched_at)
     VALUES ${attribRows.map((_, i) => `(${range(i, 9)})`).join(",")}`,
    paramize(attribRows.flat()) as never[]
  );

  return {
    orders: orderRows.length,
    shipments: shipRows.length,
    ad_spend: adSpendRows.length,
    attrib: attribRows.length,
  };
}

function range(rowIdx: number, cols: number): string {
  const parts: string[] = [];
  for (let c = 0; c < cols; c++) parts.push(`$${rowIdx * cols + c + 1}`);
  return parts.join(",");
}

function asParam(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}
function paramize(arr: unknown[]): unknown[] {
  return arr.map(asParam);
}

function ms(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
