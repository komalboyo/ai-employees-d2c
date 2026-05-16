/**
 * Google Ads connector.
 *
 * Same universal tables as Meta — ad_objects + ad_spend_daily — keyed
 * by `source = 'google'`. The agents' SQL queries already aggregate
 * across sources, so adding this connector immediately gives Rishi
 * the ability to compare Meta vs Google spend efficiency per SKU.
 *
 * The Google Ads object hierarchy is campaign / ad_group / ad, which
 * is structurally the same as Meta's campaign / adset / ad. I map
 * Google's `ad_group` to the universal `adset` level so the existing
 * adset-level rollups in Rishi/Meera "just work" across both channels.
 *
 * Live: Google Ads API v16, OAuth-gated. v0 ships fixture mode.
 */

import { z } from "zod";
import {
  type Connector,
  type AuthContext,
  type ConnectorCredsInput,
  type RawPage,
  type NormalizedRow,
  RAW_PAYLOAD_ID_PLACEHOLDER,
} from "./types";
import { type Fetcher, LiveFetcher, FixtureFetcher } from "./fetcher";

const credsSchema = z
  .object({
    mode: z.enum(["live", "fixture"]).default("fixture"),
    customer_id: z.string().optional(),
    developer_token: z.string().optional(),
    access_token: z.string().optional(),
    fixture_slug: z.string().optional(),
  })
  .refine(
    (v) => v.mode === "fixture" || (v.customer_id && v.developer_token && v.access_token),
    { message: "live mode requires customer_id + developer_token + access_token" }
  );

export type GoogleResource = "ad_objects" | "insights";
const RESOURCES: readonly GoogleResource[] = ["ad_objects", "insights"] as const;

export class GoogleConnector implements Connector<GoogleResource> {
  readonly source = "google" as const;
  readonly resources = RESOURCES;

  async auth(input: ConnectorCredsInput): Promise<AuthContext> {
    const creds = credsSchema.parse(input.raw);
    return { merchant_id: input.merchant_id, source: "google", creds };
  }

  async *fetch(ctx: AuthContext, resource: GoogleResource, cursor?: string | null): AsyncIterable<RawPage> {
    const creds = ctx.creds as z.infer<typeof credsSchema>;
    const fetcher: Fetcher =
      creds.mode === "live" ? new LiveFetcher() : new FixtureFetcher(creds.fixture_slug ?? "demo");

    let page = cursor ? Number(cursor) : 1;
    while (true) {
      const { status, body } =
        creds.mode === "live"
          ? await fetcher.get(buildLiveUrl(creds, resource, page))
          : await fetcher.get(`google/${resource}/page-${page}`);

      if (status === 404 || !body) return;
      const items = (body as { data?: unknown[] }).data ?? [];
      if (!Array.isArray(items) || items.length === 0) return;

      const source_ids = items.map((it: any) => idFor(resource, it));
      const short_page = items.length < 100;
      yield {
        resource,
        source_ids,
        payload: body,
        next_cursor: short_page ? null : String(page + 1),
      };
      page += 1;
    }
  }

  normalize(resource: GoogleResource, page: RawPage): NormalizedRow[] {
    const items = ((page.payload as { data?: unknown[] }).data ?? []) as any[];
    if (resource === "ad_objects") return items.flatMap(normalizeAdObject);
    if (resource === "insights") return items.flatMap(normalizeInsight);
    return [];
  }
}

function idFor(resource: GoogleResource, it: any): string {
  if (resource === "insights") {
    return `${it.ad_id ?? it.ad_group_id ?? it.campaign_id}_${it.date_start}`;
  }
  return String(it.id);
}

function buildLiveUrl(
  creds: { customer_id?: string },
  resource: GoogleResource,
  page: number
): string {
  // Google Ads API uses search/query (POST), not a list endpoint.
  // For v0 we'd POST a GAQL query against
  //   https://googleads.googleapis.com/v16/customers/{customer_id}/googleAds:searchStream
  // The live path is sketched here; the fixture path is what runs.
  return `https://googleads.googleapis.com/v16/customers/${creds.customer_id}/google_ads:search?page=${page}&resource=${resource}`;
}

function normalizeAdObject(it: any): NormalizedRow[] {
  const rows: NormalizedRow[] = [];

  if (it.campaign_id && it.campaign_name) {
    rows.push({
      table: "ad_objects",
      source: "google",
      source_id: String(it.campaign_id),
      data: {
        level: "campaign",
        name: it.campaign_name,
        parent_source_id: null,
        status: it.campaign_status ?? "ENABLED",
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    });
  }
  // Google's `ad_group` maps to our universal `adset` level.
  if (it.ad_group_id && it.ad_group_name) {
    rows.push({
      table: "ad_objects",
      source: "google",
      source_id: String(it.ad_group_id),
      data: {
        level: "adset",
        name: it.ad_group_name,
        parent_source_id: it.campaign_id ? String(it.campaign_id) : null,
        status: it.ad_group_status ?? "ENABLED",
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    });
  }
  rows.push({
    table: "ad_objects",
    source: "google",
    source_id: String(it.id),
    data: {
      level: "ad",
      name: it.name,
      parent_source_id: it.ad_group_id ? String(it.ad_group_id) : null,
      status: it.status ?? "ENABLED",
      raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
    },
  });
  return rows;
}

function normalizeInsight(it: any): NormalizedRow[] {
  const adObjectSourceId = it.ad_id ?? it.ad_group_id ?? it.campaign_id;
  if (!adObjectSourceId) return [];
  return [
    {
      table: "ad_spend_daily",
      source: "google",
      source_id: `${adObjectSourceId}_${it.date_start}`,
      data: {
        ad_object_id: { $ref: { table: "ad_objects", source: "google", source_id: String(adObjectSourceId) } },
        date: it.date_start,
        spend: String(it.spend ?? "0"),
        impressions: Number(it.impressions ?? 0),
        clicks: Number(it.clicks ?? 0),
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    },
  ];
}
