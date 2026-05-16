/**
 * The Connector abstraction.
 *
 * One interface, four implementations (Shopify, Meta, Shiprocket, CSV).
 * The orchestrator does not know which source it is syncing — it just
 * calls `auth → fetch (per resource) → normalize`. Every fetched page is
 * written to `raw_payloads` BEFORE normalization, so provenance is
 * unforgeable: a normalized row that doesn't reference a real raw_payload
 * row will fail the NOT NULL FK at insert time.
 *
 * Connectors are intentionally tiny. They do auth, pagination, and
 * source→universal mapping. They don't decide what to write, when to
 * write, or how to retry — that's the orchestrator's job.
 */

import type { Source } from "./source";

export interface AuthContext {
  merchant_id: string;
  source: Source;
  /** Live API headers, file paths, or `{mode: 'fixture'}` — connector-specific. */
  creds: Record<string, unknown>;
}

export interface ConnectorCredsInput {
  merchant_id: string;
  // Free-form. Each connector validates its own shape with zod inside auth().
  raw: Record<string, unknown>;
}

/** A page from the source — raw, unnormalized. Goes straight to raw_payloads. */
export interface RawPage {
  resource: string;
  /** Source-side ids contained in this page. For idempotency + the
   * `(merchant_id, content_hash)` dedupe in raw_payloads. */
  source_ids: string[];
  payload: unknown;
  /** Opaque cursor for the next page; null = done. */
  next_cursor: string | null;
}

/**
 * A normalized row destined for one of the universal tables.
 *
 * `raw_payload_id` is filled in by the orchestrator AFTER the page is
 * persisted — the connector returns the placeholder symbol and the
 * orchestrator rewrites it. This keeps connectors free of DB awareness.
 */
export const RAW_PAYLOAD_ID_PLACEHOLDER = "__RAW_PAYLOAD_ID__" as const;

export type UniversalTable =
  | "products"
  | "orders"
  | "order_lines"
  | "shipments"
  | "ad_objects"
  | "ad_spend_daily"
  | "ad_attributions";

export interface NormalizedRow {
  table: UniversalTable;
  source: Source;
  source_id: string;
  /** All other columns. raw_payload_id will be filled in by orchestrator. */
  data: Record<string, unknown>;
}

export interface Connector<TResource extends string = string> {
  readonly source: Source;
  /** Stable list of the resources this connector knows how to fetch. */
  resources: readonly TResource[];

  /** Validate creds + return an auth context the orchestrator caches. */
  auth(input: ConnectorCredsInput): Promise<AuthContext>;

  /** Async-iterable page stream. Resumes from `cursor` if provided. */
  fetch(
    ctx: AuthContext,
    resource: TResource,
    cursor?: string | null
  ): AsyncIterable<RawPage>;

  /** Map a raw page back into universal rows. Pure function — no I/O. */
  normalize(resource: TResource, page: RawPage): NormalizedRow[];
}
