/**
 * Meta Marketing API connector.
 *
 * Resources:
 *  - ad_objects: campaign / adset / ad hierarchy
 *  - insights:   daily spend / impressions / clicks per ad object
 *
 * Live: Graph API v21.0 against /act_{ad_account_id}/insights and /campaigns.
 * Fixture: same `fixtures/{merchant}/meta/{resource}/page-{n}.json` shape.
 *
 * Riskiest of the three connectors — the API has token expiry, rate
 * limits per ad account, async-insights for big windows, and a
 * permission model that needs app review for production accounts. v0
 * uses a long-lived user token + a single ad account. The connector
 * isolation lets us swap in OAuth + multi-account later without
 * touching the orchestrator or schema.
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
    ad_account_id: z.string().optional(),
    access_token: z.string().optional(),
    fixture_slug: z.string().optional(),
  })
  .refine((v) => v.mode === "fixture" || (v.ad_account_id && v.access_token), {
    message: "live mode requires ad_account_id + access_token",
  });

export type MetaResource = "ad_objects" | "insights";
const RESOURCES: readonly MetaResource[] = ["ad_objects", "insights"] as const;

export class MetaConnector implements Connector<MetaResource> {
  readonly source = "meta" as const;
  readonly resources = RESOURCES;

  async auth(input: ConnectorCredsInput): Promise<AuthContext> {
    const creds = credsSchema.parse(input.raw);
    return { merchant_id: input.merchant_id, source: "meta", creds };
  }

  async *fetch(ctx: AuthContext, resource: MetaResource, cursor?: string | null): AsyncIterable<RawPage> {
    const creds = ctx.creds as z.infer<typeof credsSchema>;
    const fetcher: Fetcher =
      creds.mode === "live" ? new LiveFetcher() : new FixtureFetcher(creds.fixture_slug ?? "demo");

    let page = cursor ? Number(cursor) : 1;
    while (true) {
      const { status, body } =
        creds.mode === "live"
          ? await fetcher.get(buildLiveUrl(creds, resource, page))
          : await fetcher.get(`meta/${resource}/page-${page}`);

      if (status === 404 || !body) return;
      const items = (body as { data?: unknown[] }).data ?? [];
      if (!Array.isArray(items) || items.length === 0) return;

      const source_ids = items.map((it: any) => idFor(resource, it));
      // Live mode uses `paging.next`; fixture mode terminates on a short page.
      const live_has_next = !!(body as { paging?: { next?: string } }).paging?.next;
      const short_page = items.length < 100;
      yield {
        resource,
        source_ids,
        payload: body,
        next_cursor: creds.mode === "live" ? (live_has_next ? String(page + 1) : null) : short_page ? null : String(page + 1),
      };
      page += 1;
    }
  }

  normalize(resource: MetaResource, page: RawPage): NormalizedRow[] {
    const items = ((page.payload as { data?: unknown[] }).data ?? []) as any[];
    if (resource === "ad_objects") return items.flatMap(normalizeAdObject);
    if (resource === "insights") return items.flatMap(normalizeInsight);
    return [];
  }
}

function idFor(resource: MetaResource, it: any): string {
  if (resource === "insights") {
    return `${it.ad_id ?? it.adset_id ?? it.campaign_id}_${it.date_start}`;
  }
  return String(it.id);
}

function buildLiveUrl(
  creds: { ad_account_id?: string; access_token?: string },
  resource: MetaResource,
  page: number
): string {
  const base = `https://graph.facebook.com/v21.0/act_${creds.ad_account_id}`;
  if (resource === "ad_objects") {
    return `${base}/ads?fields=id,name,status,campaign_id,adset_id&limit=100&page=${page}&access_token=${creds.access_token}`;
  }
  // insights
  return `${base}/insights?level=ad&fields=ad_id,adset_id,campaign_id,spend,impressions,clicks&time_increment=1&date_preset=last_30d&limit=100&page=${page}&access_token=${creds.access_token}`;
}

function normalizeAdObject(it: any): NormalizedRow[] {
  const rows: NormalizedRow[] = [];

  if (it.campaign_id && it.campaign_name) {
    rows.push({
      table: "ad_objects",
      source: "meta",
      source_id: String(it.campaign_id),
      data: {
        level: "campaign",
        name: it.campaign_name,
        parent_source_id: null,
        status: it.campaign_status ?? "ACTIVE",
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    });
  }
  if (it.adset_id && it.adset_name) {
    rows.push({
      table: "ad_objects",
      source: "meta",
      source_id: String(it.adset_id),
      data: {
        level: "adset",
        name: it.adset_name,
        parent_source_id: it.campaign_id ? String(it.campaign_id) : null,
        status: it.adset_status ?? "ACTIVE",
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    });
  }
  rows.push({
    table: "ad_objects",
    source: "meta",
    source_id: String(it.id),
    data: {
      level: "ad",
      name: it.name,
      parent_source_id: it.adset_id ? String(it.adset_id) : null,
      status: it.status ?? "ACTIVE",
      raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
    },
  });
  return rows;
}

function normalizeInsight(it: any): NormalizedRow[] {
  const adObjectSourceId = it.ad_id ?? it.adset_id ?? it.campaign_id;
  if (!adObjectSourceId) return [];
  return [
    {
      table: "ad_spend_daily",
      source: "meta",
      source_id: `${adObjectSourceId}_${it.date_start}`,
      data: {
        ad_object_id: { $ref: { table: "ad_objects", source: "meta", source_id: String(adObjectSourceId) } },
        date: it.date_start,
        spend: String(it.spend ?? "0"),
        impressions: Number(it.impressions ?? 0),
        clicks: Number(it.clicks ?? 0),
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    },
  ];
}
