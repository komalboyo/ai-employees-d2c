import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rawPayloads, merchants } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "orders",
  "order_lines",
  "shipments",
  "ad_objects",
  "ad_spend_daily",
  "ad_attributions",
  "products",
  "proposals",
  "agent_runs",
  "agents",
]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const table = url.searchParams.get("table") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!ALLOWED.has(table) || !id) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const [m] = await db
    .select()
    .from(merchants)
    .where(sql`name = 'Kindred Apparel'`)
    .limit(1);
  if (!m) return NextResponse.json({ error: "no merchant" }, { status: 404 });

  const rows = (await db.execute(
    sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${id} AND merchant_id = ${m.id}`
  )) as unknown as Array<{ raw_payload_id?: string }>;
  if (rows.length === 0) {
    return NextResponse.json({ error: "row not found" }, { status: 404 });
  }
  let raw = null;
  if (rows[0].raw_payload_id) {
    const [rp] = await db
      .select()
      .from(rawPayloads)
      .where(eq(rawPayloads.id, rows[0].raw_payload_id))
      .limit(1);
    raw = rp ?? null;
  }
  return NextResponse.json({ table, id, row: rows[0], raw_payload: raw });
}
