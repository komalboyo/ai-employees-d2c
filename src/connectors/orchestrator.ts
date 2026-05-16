/**
 * Connector orchestrator.
 *
 * Provenance contract:
 *   1. Fetch a page from the connector.
 *   2. Write the raw payload to `raw_payloads` (returns raw_payload_id).
 *   3. Normalize the page into universal rows.
 *   4. Resolve provenance + FK refs on every row.
 *   5. Upsert rows in dependency order (parents before children).
 *   6. Advance the per-merchant per-resource cursor.
 *
 * Connectors stay DB-naive. They emit rows with two kinds of placeholders:
 *   - `RAW_PAYLOAD_ID_PLACEHOLDER` for the page's raw_payload_id
 *   - `$ref: { table, source, source_id }` for FK to a parent universal row
 * The orchestrator resolves both before insert.
 */

import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { rawPayloads, syncState } from "@/db/schema";
import {
  type Connector,
  type AuthContext,
  type RawPage,
  type NormalizedRow,
  type UniversalTable,
  RAW_PAYLOAD_ID_PLACEHOLDER,
} from "./types";

const TABLE_ORDER: UniversalTable[] = [
  "products",
  "orders",
  "order_lines",
  "ad_objects",
  "ad_spend_daily",
  "shipments",
  "ad_attributions",
];

function sha256(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Coerce JS values into shapes postgres-js can bind via `unsafe`. */
function serialize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    // Plain objects → JSON for jsonb columns.
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  return v;
}

export interface SyncReport {
  source: string;
  resource: string;
  pages: number;
  rows_written: number;
  duration_ms: number;
}

export async function syncOne(
  connector: Connector,
  ctx: AuthContext,
  resource: string
): Promise<SyncReport> {
  const start = Date.now();
  let pages = 0;
  let rows_written = 0;

  const [state] = await db
    .select()
    .from(syncState)
    .where(
      sql`merchant_id = ${ctx.merchant_id} AND source = ${connector.source} AND resource = ${resource}`
    )
    .limit(1);
  let cursor = state?.cursor ?? null;

  for await (const page of connector.fetch(ctx, resource as never, cursor)) {
    pages += 1;
    rows_written += await persistPage(connector, ctx, page);
    cursor = page.next_cursor;
    await upsertCursor(ctx.merchant_id, connector.source, resource, cursor);
    if (cursor === null) break;
  }

  return {
    source: connector.source,
    resource,
    pages,
    rows_written,
    duration_ms: Date.now() - start,
  };
}

async function persistPage(
  connector: Connector,
  ctx: AuthContext,
  page: RawPage
): Promise<number> {
  const fetched_at = new Date();
  const content_hash = sha256(page.payload);

  const [raw] = await db
    .insert(rawPayloads)
    .values({
      merchant_id: ctx.merchant_id,
      source: connector.source,
      resource: page.resource,
      content_hash,
      payload: page.payload as never,
      fetched_at,
    })
    .onConflictDoUpdate({
      target: [rawPayloads.merchant_id, rawPayloads.content_hash],
      set: { fetched_at },
    })
    .returning();

  const rows = connector.normalize(page.resource as never, page);
  if (rows.length === 0) return 0;

  // Group by table.
  const byTable = bucketByTable(rows);

  // Track new and existing universal ids by (table, source, source_id) so
  // later tables can resolve $ref placeholders.
  const idIndex = new Map<string, string>();

  let written = 0;
  for (const table of TABLE_ORDER) {
    const batch = byTable.get(table);
    if (!batch || batch.length === 0) continue;

    // Resolve any $refs to tables OUTSIDE this page (e.g. shiprocket
    // shipments referencing shopify orders) via a single batched DB lookup.
    await prefetchRefs(ctx.merchant_id, batch, idIndex);

    const stamped = batch.map((r) =>
      stamp(r, raw.id, ctx.merchant_id, fetched_at, idIndex)
    );
    const inserted = await upsertBatch(table, stamped);
    for (const row of inserted) {
      idIndex.set(refKey(table, row.source, row.source_id), row.id);
    }
    written += inserted.length;
  }
  return written;
}

/**
 * Walk all $refs in a batch, group by (table, source), batch-query the
 * DB for ids we don't already have in-memory, populate idIndex. This
 * keeps cross-connector FK resolution to one query per ref-table per
 * page, not one per row.
 */
async function prefetchRefs(
  merchant_id: string,
  rows: NormalizedRow[],
  idIndex: Map<string, string>
): Promise<void> {
  const needed = new Map<string, Set<string>>(); // key=table::source, value=set of source_ids
  for (const r of rows) {
    for (const v of Object.values(r.data)) {
      if (typeof v === "object" && v !== null && "$ref" in v) {
        const ref = (v as { $ref: { table: string; source: string; source_id: string } }).$ref;
        if (idIndex.has(refKey(ref.table, ref.source, ref.source_id))) continue;
        const k = `${ref.table}::${ref.source}`;
        const set = needed.get(k) ?? new Set();
        set.add(ref.source_id);
        needed.set(k, set);
      }
    }
  }
  for (const [k, sourceIds] of needed) {
    const [table, source] = k.split("::");
    const ids = [...sourceIds];
    if (ids.length === 0) continue;
    const result = await pg.unsafe(
      `SELECT id, source, source_id FROM "${table}" WHERE merchant_id = $1 AND source = $2 AND source_id = ANY($3)`,
      [merchant_id, source, ids] as never[]
    );
    for (const row of result as unknown as InsertedRow[]) {
      idIndex.set(refKey(table, row.source, row.source_id), row.id);
    }
  }
}

interface InsertedRow {
  id: string;
  source: string;
  source_id: string;
}

function refKey(table: string, source: string, source_id: string): string {
  return `${table}::${source}::${source_id}`;
}

function stamp(
  row: NormalizedRow,
  raw_payload_id: string,
  merchant_id: string,
  fetched_at: Date,
  idIndex: Map<string, string>
): NormalizedRow {
  const data: Record<string, unknown> = { ...row.data };
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v === RAW_PAYLOAD_ID_PLACEHOLDER) {
      data[key] = raw_payload_id;
    } else if (
      typeof v === "object" &&
      v !== null &&
      "$ref" in v
    ) {
      const ref = (v as { $ref: { table: string; source: string; source_id: string } }).$ref;
      const resolved = idIndex.get(refKey(ref.table, ref.source, ref.source_id));
      if (!resolved) {
        // Best-effort: leave as null. We don't fail the row — orphan FKs
        // can be reconciled later by a separate stitcher job. v0 logs.
        data[key] = null;
      } else {
        data[key] = resolved;
      }
    }
  }
  return {
    ...row,
    data: {
      ...data,
      merchant_id,
      source: row.source,
      source_id: row.source_id,
      raw_payload_id,
      fetched_at,
    },
  };
}

function bucketByTable(rows: NormalizedRow[]): Map<UniversalTable, NormalizedRow[]> {
  const map = new Map<UniversalTable, NormalizedRow[]>();
  for (const r of rows) {
    const bucket = map.get(r.table) ?? [];
    bucket.push(r);
    map.set(r.table, bucket);
  }
  return map;
}

/**
 * Generic upsert. Uses pg.unsafe with parameterized values; table/column
 * names come from internal connector code, not user input, so no
 * SQL-injection surface. Returns the universal ids for each row so child
 * tables can resolve FKs.
 */
async function upsertBatch(
  table: UniversalTable,
  rows: NormalizedRow[]
): Promise<InsertedRow[]> {
  if (rows.length === 0) return [];

  // Drop any `_helper_*` columns that connectors include for orchestrator use only.
  for (const r of rows) {
    for (const k of Object.keys(r.data)) {
      if (k.startsWith("_helper_")) delete (r.data as Record<string, unknown>)[k];
    }
  }

  // Dedupe within batch on (source, source_id) — connectors may emit the
  // same parent multiple times (e.g. Meta repeats campaign per ad).
  const seen = new Set<string>();
  rows = rows.filter((r) => {
    const k = `${r.source}::${r.source_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (rows.length === 0) return [];

  const cols = Object.keys(rows[0].data);
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    const group: string[] = [];
    for (const c of cols) {
      group.push(`$${i++}`);
      const v = (r.data as Record<string, unknown>)[c];
      values.push(serialize(v));
    }
    placeholders.push(`(${group.join(", ")})`);
  }
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const updateCols = cols
    .filter((c) => !["merchant_id", "source", "source_id", "id"].includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  const stmt = `INSERT INTO "${table}" (${colList}) VALUES ${placeholders.join(
    ", "
  )} ON CONFLICT ("merchant_id", "source", "source_id") DO UPDATE SET ${updateCols} RETURNING id, source, source_id`;
  const result = await pg.unsafe(stmt, values as never[]);
  return result as unknown as InsertedRow[];
}

async function upsertCursor(
  merchant_id: string,
  source: NormalizedRow["source"],
  resource: string,
  cursor: string | null
) {
  await db
    .insert(syncState)
    .values({ merchant_id, source, resource, cursor, last_synced_at: new Date() })
    .onConflictDoUpdate({
      target: [syncState.merchant_id, syncState.source, syncState.resource],
      set: { cursor, last_synced_at: new Date() },
    });
}
