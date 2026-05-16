/**
 * CSV connector.
 *
 * The fourth implementation. Deliberately not SaaS. Proves the
 * `Connector` abstraction is genuinely source-agnostic — it handles
 * REST APIs (Shopify, Meta, Shiprocket) AND file uploads with the same
 * fetch → normalize → orchestrate pipeline.
 *
 * Solves a real product gap: SKU-level COGS lives nowhere except the
 * founder's spreadsheet. Without this, agent margin math is stuck on
 * the 40% proxy. With a single CSV upload, margins become real.
 *
 * Resources:
 *  - product_costs: sku, cogs_per_unit
 *
 * Future shapes (lead_times.csv, customer_flags.csv) plug in the same way.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  type Connector,
  type AuthContext,
  type ConnectorCredsInput,
  type RawPage,
  type NormalizedRow,
  RAW_PAYLOAD_ID_PLACEHOLDER,
} from "./types";

const credsSchema = z.object({
  file_path: z.string(),
  resource: z.enum(["product_costs"]),
});

export type CsvResource = "product_costs";
const RESOURCES: readonly CsvResource[] = ["product_costs"] as const;

export class CsvConnector implements Connector<CsvResource> {
  readonly source = "csv" as const;
  readonly resources = RESOURCES;

  async auth(input: ConnectorCredsInput): Promise<AuthContext> {
    const creds = credsSchema.parse(input.raw);
    return { merchant_id: input.merchant_id, source: "csv", creds };
  }

  async *fetch(ctx: AuthContext, _resource: CsvResource): AsyncIterable<RawPage> {
    const creds = ctx.creds as z.infer<typeof credsSchema>;
    const text = await readFile(creds.file_path, "utf-8");
    const rows = parseCsv(text);
    // One "page" per upload. The whole file is one raw_payload.
    yield {
      resource: creds.resource,
      source_ids: rows.map((r) => String(r.sku)),
      payload: { rows, source_file: creds.file_path },
      next_cursor: null,
    };
  }

  normalize(_resource: CsvResource, page: RawPage): NormalizedRow[] {
    const rows = (page.payload as { rows: Record<string, string>[] }).rows;
    // We don't insert a new product row from the CSV — we update the
    // existing one (matched on merchant + sku) with cogs_per_unit. The
    // universal upsert path keys on (merchant, source, source_id), so we
    // emit shadow product rows pointing at the same source as the
    // existing Shopify products, with a deterministic source_id that
    // collides and triggers DO UPDATE on cogs_per_unit only.
    //
    // For simplicity in v0, we instead write a parallel csv-sourced
    // product row keyed on csv:sku. Joining at query time prefers
    // shopify products but falls back to csv COGS via SQL coalesce. The
    // README documents this trade-off explicitly.
    return rows.map((r) => ({
      table: "products" as const,
      source: "csv" as const,
      source_id: String(r.sku),
      data: {
        sku: r.sku,
        title: r.title ?? r.sku,
        category: r.category ?? null,
        price: String(r.price ?? "0"),
        cogs_per_unit: String(r.cogs ?? r.cogs_per_unit ?? "0"),
        inventory: r.inventory ? Number(r.inventory) : null,
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    }));
  }
}

/**
 * Minimal CSV parser. Header row required. Handles quoted fields and
 * commas inside quotes. Newlines inside quotes are not supported (v0
 * scope; real merchant uploads rarely include them in COGS sheets).
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length === 0) return [];
  const headers = splitRow(lines[0]).map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => (row[h] = (cells[idx] ?? "").trim()));
    out.push(row);
  }
  return out;
}

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"' && inQuote) {
      cur += '"';
      i++;
    } else if (c === '"') {
      inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}
