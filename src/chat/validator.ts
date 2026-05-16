/**
 * Citation validator.
 *
 * Two passes:
 *   1. Parse the model's text response into segments. A segment is a
 *      sentence-ish chunk that either contains a number (must be cited)
 *      or doesn't (free pass).
 *   2. For every numeric segment, require a `[cite:table:id,...]` tag
 *      and verify each cited row exists and belongs to the merchant.
 *
 * Returns a verdict — "ok" with cleaned text, or "violation" with the
 * specific failure for the model to retry against.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export interface ValidationResult {
  ok: boolean;
  /** Final user-facing text. Citations may be left in or rewritten as footnotes. */
  text: string;
  /** Citations that were verified, in order. Used to render the inspector. */
  verified_citations: { table: string; id: string }[];
  violations: string[];
}

const CITE_RE = /\[cite:([a-z_]+):([0-9a-f\-,\s]+)\]/gi;
// A "numeric claim" is any number that's not part of a date or a citation.
const NUMBER_RE = /(?<![0-9a-f])\d[\d,]*(?:\.\d+)?\s*(?:%|₹|rupees|orders|days?|d|wks?|months?)?/gi;

export async function validate(
  merchant_id: string,
  text: string
): Promise<ValidationResult> {
  // First pass: collect all citation tags + cited row ids.
  const citationsByPosition: Array<{ start: number; end: number; table: string; ids: string[] }> = [];
  for (const m of text.matchAll(CITE_RE)) {
    const ids = m[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    citationsByPosition.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      table: m[1],
      ids,
    });
  }

  // Verify each cited id exists + belongs to this merchant.
  const violations: string[] = [];
  const verified: { table: string; id: string }[] = [];
  for (const c of citationsByPosition) {
    for (const id of c.ids) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        violations.push(`citation has malformed uuid: ${c.table}:${id}`);
        continue;
      }
      const exists = await rowExists(c.table, id, merchant_id);
      if (!exists) {
        violations.push(`cited row not found or not in merchant scope: ${c.table}:${id}`);
        continue;
      }
      verified.push({ table: c.table, id });
    }
  }

  // Walk the text segment by segment between citations.
  // Strip citation tags so we can detect raw numbers in the prose.
  const segments: Array<{ text: string; has_following_cite: boolean }> = [];
  let lastEnd = 0;
  const citationStarts = citationsByPosition.map((c) => c.start);
  for (let i = 0; i < citationsByPosition.length; i++) {
    const c = citationsByPosition[i];
    segments.push({ text: text.slice(lastEnd, c.start), has_following_cite: true });
    lastEnd = c.end;
  }
  if (lastEnd < text.length) {
    segments.push({ text: text.slice(lastEnd), has_following_cite: false });
  }
  // If no citations at all, treat the whole text as a single segment.
  if (citationsByPosition.length === 0) {
    segments.push({ text, has_following_cite: false });
  }

  // For each segment without a following citation, check it doesn't carry
  // a numeric claim.
  for (const seg of segments) {
    if (seg.has_following_cite) continue;
    const matches = [...seg.text.matchAll(NUMBER_RE)];
    // Filter out obvious non-claims: bullet numbers, years, percentages
    // that look like enumerations.
    const real = matches.filter((m) => looksLikeClaim(m[0], seg.text, m.index ?? 0));
    if (real.length > 0) {
      violations.push(
        `uncited numeric claim: "${real.map((r) => r[0]).join(" / ")}" in segment "${truncate(seg.text)}"`
      );
    }
  }

  return {
    ok: violations.length === 0,
    text,
    verified_citations: verified,
    violations,
  };
}

function looksLikeClaim(num: string, seg: string, pos: number): boolean {
  // Skip "page 1", "step 2", obvious enumerations at line start.
  const before = seg.slice(Math.max(0, pos - 16), pos).toLowerCase();
  if (/(page|step|item|#)\s*$/.test(before)) return false;
  // Skip standalone "1.", "2.", numbered list markers.
  if (/^\s*\d+\.\s/.test(seg.slice(Math.max(0, pos - 4)))) return false;
  // Skip plain years (1900-2099) without unit suffix.
  if (/^(19|20)\d{2}$/.test(num)) return false;
  return true;
}

function truncate(s: string, n = 80): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function rowExists(table: string, id: string, merchant_id: string): Promise<boolean> {
  // Whitelist tables — never interpolate user-controlled identifiers.
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
    "raw_payloads",
  ]);
  if (!ALLOWED.has(table)) return false;
  const rows = (await db.execute(
    sql`SELECT 1 FROM ${sql.raw(table)} WHERE id = ${id} AND merchant_id = ${merchant_id} LIMIT 1`
  )) as unknown as Array<unknown>;
  return rows.length > 0;
}
