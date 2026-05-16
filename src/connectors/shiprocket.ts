/**
 * Shiprocket connector.
 *
 * Resources:
 *  - shipments: AWB / courier / pincode / status / NDR / RTO
 *
 * Live: Shiprocket REST API at https://apiv2.shiprocket.in/v1.
 * Auth flow: POST /auth/login → token in response, used as Bearer.
 * Fixture: `fixtures/{merchant}/shiprocket/shipments/page-{n}.json`.
 *
 * RTO is a first-class state in this connector. The status enum maps
 * Shiprocket's many courier statuses into the canonical 7 states our
 * universal schema knows about. NDR count is exposed as a column
 * because it's the strongest pre-RTO leading indicator and Meera (the
 * Ops agent) reads it directly.
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
    email: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
    fixture_slug: z.string().optional(),
  })
  .refine(
    (v) => v.mode === "fixture" || v.token || (v.email && v.password),
    { message: "live mode requires token or email/password" }
  );

export type ShiprocketResource = "shipments";
const RESOURCES: readonly ShiprocketResource[] = ["shipments"] as const;

export class ShiprocketConnector implements Connector<ShiprocketResource> {
  readonly source = "shiprocket" as const;
  readonly resources = RESOURCES;

  async auth(input: ConnectorCredsInput): Promise<AuthContext> {
    const creds = credsSchema.parse(input.raw);
    if (creds.mode === "live" && !creds.token && creds.email && creds.password) {
      const live = new LiveFetcher();
      const res = await live.post!("https://apiv2.shiprocket.in/v1/auth/login", {
        email: creds.email,
        password: creds.password,
      });
      const token = (res.body as { token?: string }).token;
      if (!token) throw new Error("shiprocket auth failed");
      creds.token = token;
    }
    return { merchant_id: input.merchant_id, source: "shiprocket", creds };
  }

  async *fetch(
    ctx: AuthContext,
    resource: ShiprocketResource,
    cursor?: string | null
  ): AsyncIterable<RawPage> {
    const creds = ctx.creds as z.infer<typeof credsSchema>;
    const fetcher: Fetcher =
      creds.mode === "live" ? new LiveFetcher() : new FixtureFetcher(creds.fixture_slug ?? "demo");

    let page = cursor ? Number(cursor) : 1;
    while (true) {
      const { status, body } =
        creds.mode === "live"
          ? await fetcher.get(
              `https://apiv2.shiprocket.in/v1/external/shipments?per_page=100&page=${page}`,
              { headers: { Authorization: `Bearer ${creds.token}` } }
            )
          : await fetcher.get(`shiprocket/${resource}/page-${page}`);

      if (status === 404 || !body) return;
      const items = (body as { data?: unknown[]; shipments?: unknown[] }).data ??
        (body as { shipments?: unknown[] }).shipments ?? [];
      if (!Array.isArray(items) || items.length === 0) return;

      yield {
        resource,
        source_ids: items.map((it: any) => String(it.id ?? it.awb)),
        payload: body,
        next_cursor: items.length < 100 ? null : String(page + 1),
      };
      page += 1;
    }
  }

  normalize(_resource: ShiprocketResource, page: RawPage): NormalizedRow[] {
    const items = (
      (page.payload as { data?: unknown[]; shipments?: unknown[] }).data ??
      (page.payload as { shipments?: unknown[] }).shipments ?? []
    ) as any[];
    return items.map((it) => ({
      table: "shipments" as const,
      source: "shiprocket" as const,
      source_id: String(it.id ?? it.awb),
      data: {
        order_id: it.order_source_id
          ? { $ref: { table: "orders", source: "shopify", source_id: String(it.order_source_id) } }
          : null,
        awb: String(it.awb ?? it.awb_code ?? ""),
        courier: it.courier_name ?? it.courier ?? "unknown",
        pincode: String(it.pincode ?? it.delivery_pincode ?? ""),
        status: mapStatus(it.status ?? it.current_status ?? ""),
        shipping_cost: String(it.freight_charges ?? it.shipping_cost ?? "0"),
        ndr_count: Number(it.ndr_count ?? 0),
        dispatched_at: it.pickup_scheduled_date ? new Date(it.pickup_scheduled_date) : null,
        delivered_at: it.delivered_date ? new Date(it.delivered_date) : null,
        rto_at: it.rto_date ? new Date(it.rto_date) : null,
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    }));
  }
}

function mapStatus(s: string):
  | "pending"
  | "in_transit"
  | "delivered"
  | "ndr"
  | "rto_initiated"
  | "rto_delivered"
  | "lost" {
  const k = s.toLowerCase();
  if (/rto.*delivered|returned to origin/.test(k)) return "rto_delivered";
  if (/rto/.test(k)) return "rto_initiated";
  if (/delivered/.test(k)) return "delivered";
  if (/ndr|non.?delivery|undelivered/.test(k)) return "ndr";
  if (/transit|out for delivery|pickup/.test(k)) return "in_transit";
  if (/lost|damaged/.test(k)) return "lost";
  return "pending";
}
