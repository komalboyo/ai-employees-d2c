/**
 * Demo seed: generate Kindred Apparel fixtures + sync them through the
 * Connector abstraction into Postgres. This is the canonical end-to-end
 * exercise of the data plane.
 *
 * Usage: npm run seed
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { merchants } from "@/db/schema";
import { makeConnector } from "@/connectors";
import { syncOne } from "@/connectors/orchestrator";
import { generateFixtures } from "@/seed/generate-fixtures";
import { KINDRED_SLUG, PINCODES } from "@/seed/business";
import path from "node:path";

async function main() {
  const days = Number(process.env.SEED_DAYS ?? 30);
  const seed = Number(process.env.SEED_RNG ?? 42);

  console.log(`[seed] generating ${days}d of fixtures (rng=${seed})...`);
  await generateFixtures({ days, seed });

  console.log("[seed] creating merchant...");
  await db.execute(sql`DELETE FROM merchants WHERE name = 'Kindred Apparel'`);
  const [m] = await db
    .insert(merchants)
    .values({
      name: "Kindred Apparel",
      currency: "INR",
      timezone: "Asia/Kolkata",
    })
    .returning();
  console.log(`[seed] merchant_id=${m.id}`);

  const merchant_id = m.id;
  const fixture_slug = KINDRED_SLUG;

  // Shopify
  {
    const conn = makeConnector("shopify");
    const ctx = await conn.auth({
      merchant_id,
      raw: { mode: "fixture", fixture_slug },
    });
    for (const res of conn.resources) {
      const rep = await syncOne(conn, ctx, res);
      console.log(`[shopify:${res}] pages=${rep.pages} rows=${rep.rows_written} ${rep.duration_ms}ms`);
    }
  }

  // Meta
  {
    const conn = makeConnector("meta");
    const ctx = await conn.auth({
      merchant_id,
      raw: { mode: "fixture", fixture_slug },
    });
    for (const res of conn.resources) {
      const rep = await syncOne(conn, ctx, res);
      console.log(`[meta:${res}] pages=${rep.pages} rows=${rep.rows_written} ${rep.duration_ms}ms`);
    }
  }

  // Shiprocket
  {
    const conn = makeConnector("shiprocket");
    const ctx = await conn.auth({
      merchant_id,
      raw: { mode: "fixture", fixture_slug },
    });
    for (const res of conn.resources) {
      const rep = await syncOne(conn, ctx, res);
      console.log(`[shiprocket:${res}] pages=${rep.pages} rows=${rep.rows_written} ${rep.duration_ms}ms`);
    }
  }

  // CSV — COGS upload
  {
    const conn = makeConnector("csv");
    const ctx = await conn.auth({
      merchant_id,
      raw: {
        file_path: path.join("fixtures", KINDRED_SLUG, "csv/product_costs.csv"),
        resource: "product_costs",
      },
    });
    const rep = await syncOne(conn, ctx, "product_costs");
    console.log(`[csv:product_costs] pages=${rep.pages} rows=${rep.rows_written} ${rep.duration_ms}ms`);
  }

  // Compute UTM-based ad_attributions in SQL (joins shopify orders ↔ meta ad_objects via utm_content)
  console.log("[seed] computing ad_attributions...");
  await db.execute(sql`
    INSERT INTO ad_attributions (merchant_id, order_id, ad_object_id, match_method, confidence, source, source_id, raw_payload_id, fetched_at)
    SELECT
      o.merchant_id,
      o.id AS order_id,
      a.id AS ad_object_id,
      'utm_content' AS match_method,
      0.85 AS confidence,
      'shopify' AS source,
      'attr_' || o.id || '_' || a.id AS source_id,
      o.raw_payload_id,
      now() AS fetched_at
    FROM orders o
    JOIN ad_objects a
      ON a.merchant_id = o.merchant_id
     AND a.level = 'adset'
     AND lower(replace(a.name, ' ', '_')) = o.utm_content
    WHERE o.merchant_id = ${merchant_id}
    ON CONFLICT (merchant_id, source, source_id) DO NOTHING
  `);

  // Summary
  const [counts] = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM products WHERE merchant_id = ${merchant_id})::int AS products,
      (SELECT COUNT(*) FROM orders WHERE merchant_id = ${merchant_id})::int AS orders,
      (SELECT COUNT(*) FROM order_lines WHERE merchant_id = ${merchant_id})::int AS order_lines,
      (SELECT COUNT(*) FROM ad_objects WHERE merchant_id = ${merchant_id})::int AS ad_objects,
      (SELECT COUNT(*) FROM ad_spend_daily WHERE merchant_id = ${merchant_id})::int AS ad_spend_daily,
      (SELECT COUNT(*) FROM shipments WHERE merchant_id = ${merchant_id})::int AS shipments,
      (SELECT COUNT(*) FROM ad_attributions WHERE merchant_id = ${merchant_id})::int AS ad_attributions,
      (SELECT COUNT(*) FROM raw_payloads WHERE merchant_id = ${merchant_id})::int AS raw_payloads
  `);
  console.log("\n[seed] summary:");
  console.table(counts);

  await pg.end();
  console.log("[seed] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
