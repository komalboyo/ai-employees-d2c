/**
 * Shopify Admin REST connector.
 *
 * Resources:
 *  - products: SKU master
 *  - orders: revenue events (with line items + UTM block)
 *
 * Real-mode auth: `X-Shopify-Access-Token` header against
 * `https://{store}.myshopify.com/admin/api/2024-10/...`
 *
 * Fixture-mode: reads `fixtures/{merchant}/shopify/{resource}/page-{n}.json`
 * so the reviewer can run the demo without a real store.
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
    store_domain: z.string().optional(),
    access_token: z.string().optional(),
    fixture_slug: z.string().optional(), // merchant slug for fixture path
  })
  .refine((v) => v.mode === "fixture" || (v.store_domain && v.access_token), {
    message: "live mode requires store_domain + access_token",
  });

export type ShopifyResource = "products" | "orders";
const RESOURCES: readonly ShopifyResource[] = ["products", "orders"] as const;

export class ShopifyConnector implements Connector<ShopifyResource> {
  readonly source = "shopify" as const;
  readonly resources = RESOURCES;

  async auth(input: ConnectorCredsInput): Promise<AuthContext> {
    const creds = credsSchema.parse(input.raw);
    return { merchant_id: input.merchant_id, source: "shopify", creds };
  }

  async *fetch(ctx: AuthContext, resource: ShopifyResource, cursor?: string | null): AsyncIterable<RawPage> {
    const creds = ctx.creds as z.infer<typeof credsSchema>;
    const fetcher: Fetcher =
      creds.mode === "live" ? new LiveFetcher() : new FixtureFetcher(creds.fixture_slug ?? "demo");

    let page = cursor ? Number(cursor) : 1;
    while (true) {
      const { status, body } =
        creds.mode === "live"
          ? await fetcher.get(
              `https://${creds.store_domain}/admin/api/2024-10/${resource}.json?limit=250&page=${page}`,
              { headers: { "X-Shopify-Access-Token": creds.access_token! } }
            )
          : await fetcher.get(`shopify/${resource}/page-${page}`);

      if (status === 404 || !body) return;
      const items = (body as { [k: string]: unknown[] })[resource] ?? [];
      if (!Array.isArray(items) || items.length === 0) return;

      const source_ids = items.map((it: any) => String(it.id));
      yield {
        resource,
        source_ids,
        payload: body,
        next_cursor: items.length < 250 ? null : String(page + 1),
      };
      page += 1;
    }
  }

  normalize(resource: ShopifyResource, page: RawPage): NormalizedRow[] {
    const items = ((page.payload as { [k: string]: unknown[] })[resource] ?? []) as any[];
    if (resource === "products") return items.flatMap(normalizeProduct);
    if (resource === "orders") return items.flatMap(normalizeOrder);
    return [];
  }
}

function normalizeProduct(p: any): NormalizedRow[] {
  // Each variant is a SKU in our universal model.
  const variants: any[] = p.variants ?? [];
  return variants.map((v) => ({
    table: "products",
    source: "shopify",
    source_id: String(v.id),
    data: {
      sku: v.sku || String(v.id),
      title: `${p.title}${v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""}`,
      category: p.product_type || null,
      price: String(v.price ?? "0"),
      cogs_per_unit: null,
      inventory: v.inventory_quantity ?? null,
      raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
    },
  }));
}

function normalizeOrder(o: any): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  const utm = parseNoteAttributes(o.note_attributes ?? []);

  rows.push({
    table: "orders",
    source: "shopify",
    source_id: String(o.id),
    data: {
      order_number: String(o.order_number ?? o.name ?? o.id),
      placed_at: new Date(o.created_at),
      customer_id: o.customer?.id ? String(o.customer.id) : null,
      customer_email: o.customer?.email ?? null,
      payment_method: inferPaymentMethod(o),
      subtotal: String(o.subtotal_price ?? "0"),
      shipping_charged: String(sumShipping(o)),
      discount: String(o.total_discounts ?? "0"),
      total: String(o.total_price ?? "0"),
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      utm_content: utm.utm_content,
      ship_pincode: o.shipping_address?.zip ?? null,
      ship_city: o.shipping_address?.city ?? null,
      ship_state: o.shipping_address?.province ?? null,
      raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
    },
  });

  for (const li of o.line_items ?? []) {
    rows.push({
      table: "order_lines",
      source: "shopify",
      source_id: String(li.id),
      data: {
        order_id: { $ref: { table: "orders", source: "shopify", source_id: String(o.id) } },
        product_id: li.variant_id
          ? { $ref: { table: "products", source: "shopify", source_id: String(li.variant_id) } }
          : null,
        sku: li.sku || String(li.variant_id ?? li.id),
        title: li.title,
        quantity: li.quantity,
        price_per_unit: String(li.price ?? "0"),
        line_total: String(Number(li.price ?? 0) * Number(li.quantity ?? 0)),
        raw_payload_id: RAW_PAYLOAD_ID_PLACEHOLDER,
      },
    });
  }
  return rows;
}

function parseNoteAttributes(attrs: { name: string; value: string }[]) {
  const m: Record<string, string | null> = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
  };
  for (const a of attrs) if (a.name in m) m[a.name] = a.value;
  return m;
}

function inferPaymentMethod(o: any): "cod" | "prepaid" | "unknown" {
  const gateways: string[] = o.payment_gateway_names ?? [];
  if (gateways.some((g) => /cash on delivery|cod/i.test(g))) return "cod";
  if (gateways.length > 0) return "prepaid";
  return "unknown";
}

function sumShipping(o: any): number {
  return (o.shipping_lines ?? []).reduce(
    (s: number, l: any) => s + Number(l.price ?? 0),
    0
  );
}
