import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { merchants } from "@/db/schema";
import { getLatestBrief } from "@/agents/chief-of-staff";

export const dynamic = "force-dynamic";

export async function GET() {
  const [m] = await db
    .select()
    .from(merchants)
    .where(sql`name = 'Kindred Apparel'`)
    .limit(1);
  if (!m) return NextResponse.json({ error: "no merchant" }, { status: 404 });
  const brief = await getLatestBrief(m.id);
  return NextResponse.json({ merchant: m, brief });
}
