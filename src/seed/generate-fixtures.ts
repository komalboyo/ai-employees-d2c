/**
 * Generates Shopify/Meta/Shiprocket-shaped API payloads for the
 * Kindred Apparel demo merchant and writes them to fixtures/kindred/.
 *
 * The connectors then read these in fixture mode — the exact same code
 * path that hits the real APIs in live mode. So the demo run is a
 * genuine end-to-end exercise of the Connector abstraction, not a
 * bypass.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { rng } from "./rng";
import {
  KINDRED_SLUG,
  PINCODES,
  COURIERS,
  COURIER_PIN_MULT,
  PRODUCTS,
  ADSETS,
} from "./business";

interface GenOptions {
  /** Number of days of history to generate. */
  days: number;
  /** Random seed for determinism. */
  seed: number;
  /** Output root (defaults to fixtures/). */
  root?: string;
}

export async function generateFixtures(opts: GenOptions): Promise<void> {
  const r = rng(opts.seed);
  const root = path.join(opts.root ?? "fixtures", KINDRED_SLUG);
  await mkdir(root, { recursive: true });

  // ---- Shopify products ----
  const shopifyProducts = PRODUCTS.map((p, i) => ({
    id: 9000 + i,
    title: p.title.split(" — ")[0], // strip variant suffix
    product_type: p.category,
    variants: [
      {
        id: 9000 + i,
        title: p.title.split(" — ")[1] ?? "Default Title",
        sku: p.sku,
        price: String(p.price.toFixed(2)),
        inventory_quantity: p.start_inventory,
      },
    ],
  }));
  await writeJson(root, "shopify/products/page-1.json", { products: shopifyProducts });

  // ---- Build orders ----
  const NOW = new Date();
  const orders: any[] = [];
  const adAttributions: { adset_id: string; ad_id: string }[] = []; // unused but illustrative
  const utmByAdSet: Record<string, string> = Object.fromEntries(
    ADSETS.map((a) => [a.adset.id, a.adset.name.toLowerCase().replace(/\s+/g, "_")])
  );

  const stockRemaining: Record<string, number> = Object.fromEntries(
    PRODUCTS.map((p) => [p.sku, p.start_inventory])
  );

  let orderSeq = 100000;
  let lineSeq = 200000;

  for (let d = opts.days - 1; d >= 0; d--) {
    const day = new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
    const dayStr = day.toISOString().slice(0, 10);

    for (const adset of ADSETS) {
      // Synthetic funnel: impressions → clicks → orders for this adset, this day.
      const impressions = Math.round(adset.daily_spend / 0.4); // ~₹0.4 CPM proxy
      const clicks = Math.round(impressions * adset.click_through_rate);
      const ordersToday = Math.max(0, Math.round(clicks * adset.conversion_rate));

      for (let i = 0; i < ordersToday; i++) {
        const sku = r.pick(adset.preferred_skus);
        const product = PRODUCTS.find((p) => p.sku === sku)!;

        const pincode = adset.preferred_pincodes
          ? r.pick(adset.preferred_pincodes)
          : r.pick(PINCODES.map((p) => p.pin));
        const pin = PINCODES.find((p) => p.pin === pincode)!;

        const isCod = r.next() < adset.payment_cod_share;
        const qty = r.weighted([{ v: 1, w: 7 }, { v: 2, w: 2 }, { v: 3, w: 1 }]);

        if (stockRemaining[sku] >= qty) stockRemaining[sku] -= qty;

        const subtotal = product.price * qty;
        const shipping = isCod ? 80 : 0;
        const total = subtotal + shipping;

        orderSeq++;
        const orderId = orderSeq;
        const utm_campaign = adset.campaign.id;
        const utm_content = utmByAdSet[adset.adset.id];

        const placedAt = new Date(
          day.getTime() + r.int(0, 24 * 60 * 60 * 1000)
        );

        orders.push({
          id: orderId,
          order_number: orderId - 100000,
          name: `#${orderId - 100000}`,
          created_at: placedAt.toISOString(),
          customer: {
            id: 5000 + r.int(0, 500),
            email: `customer${r.int(1000, 9999)}@example.com`,
          },
          payment_gateway_names: isCod ? ["Cash on Delivery (COD)"] : ["Razorpay"],
          subtotal_price: subtotal.toFixed(2),
          shipping_lines: shipping > 0 ? [{ price: shipping.toFixed(2) }] : [],
          total_discounts: "0.00",
          total_price: total.toFixed(2),
          note_attributes: [
            { name: "utm_source", value: "meta" },
            { name: "utm_medium", value: "paid_social" },
            { name: "utm_campaign", value: utm_campaign },
            { name: "utm_content", value: utm_content },
          ],
          shipping_address: { zip: pincode, city: pin.city, province: pin.state },
          line_items: [
            {
              id: ++lineSeq,
              variant_id: 9000 + PRODUCTS.findIndex((p) => p.sku === sku),
              sku,
              title: product.title,
              quantity: qty,
              price: product.price.toFixed(2),
            },
          ],
          _meta_adset_id: adset.adset.id, // helper for shipment + attribution gen
          _is_cod: isCod,
        });
      }
    }
  }

  // Paginate orders 250/page (Shopify limit) but write all in one for v0
  const orderPages = paginate(orders, 250);
  for (let i = 0; i < orderPages.length; i++) {
    const cleaned = orderPages[i].map(stripHelperFields);
    await writeJson(root, `shopify/orders/page-${i + 1}.json`, { orders: cleaned });
  }

  // ---- Meta ad_objects (campaigns + adsets + ads, denormalized) ----
  const metaAdObjects = ADSETS.flatMap((a, idx) => [
    {
      id: a.campaign.id,
      name: a.campaign.name,
      level: "campaign",
      campaign_id: a.campaign.id,
      campaign_name: a.campaign.name,
      campaign_status: "ACTIVE",
      status: "ACTIVE",
    },
    {
      id: a.adset.id,
      name: a.adset.name,
      level: "adset",
      adset_id: a.adset.id,
      adset_name: a.adset.name,
      campaign_id: a.campaign.id,
      campaign_name: a.campaign.name,
      adset_status: "ACTIVE",
      status: "ACTIVE",
    },
    {
      id: `ad_${idx}_1`,
      name: `${a.adset.name} — Ad 1`,
      level: "ad",
      adset_id: a.adset.id,
      adset_name: a.adset.name,
      campaign_id: a.campaign.id,
      campaign_name: a.campaign.name,
      status: "ACTIVE",
    },
  ]);
  await writeJson(root, "meta/ad_objects/page-1.json", { data: metaAdObjects });

  // ---- Meta insights (daily spend per ad object) ----
  const insights: any[] = [];
  for (let d = opts.days - 1; d >= 0; d--) {
    const day = new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
    const dayStr = day.toISOString().slice(0, 10);
    for (let idx = 0; idx < ADSETS.length; idx++) {
      const a = ADSETS[idx];
      const noise = 0.85 + r.next() * 0.3;
      const spend = a.daily_spend * noise;
      const impressions = Math.round(spend / 0.4);
      const clicks = Math.round(impressions * a.click_through_rate);
      insights.push({
        ad_id: `ad_${idx}_1`,
        adset_id: a.adset.id,
        campaign_id: a.campaign.id,
        date_start: dayStr,
        spend: spend.toFixed(2),
        impressions,
        clicks,
      });
    }
  }
  const insightPages = paginate(insights, 100);
  for (let i = 0; i < insightPages.length; i++) {
    await writeJson(root, `meta/insights/page-${i + 1}.json`, { data: insightPages[i] });
  }

  // ---- Shiprocket shipments (linked to orders by _meta_adset_id / pincode) ----
  const shipments: any[] = [];
  let awbSeq = 7000000;
  for (const o of orders) {
    awbSeq++;
    const pin = PINCODES.find((p) => p.pin === o.shipping_address.zip)!;
    const adsetId = o._meta_adset_id as string;
    const adsetDef = ADSETS.find((a) => a.adset.id === adsetId)!;
    const courier = adsetDef.preferred_courier ?? r.pick(COURIERS);
    const isCod = o._is_cod as boolean;

    // RTO probability calc
    const lane = `${courier}::${pin.pin}`;
    const laneMult = COURIER_PIN_MULT[lane] ?? 1.0;
    const codMult = isCod ? pin.cod_mult : 1.0;
    const rtoProb = Math.min(0.95, pin.base_rto * codMult * laneMult);
    const willRto = r.next() < rtoProb;

    const placed = new Date(o.created_at);
    const pickup = new Date(placed.getTime() + 24 * 60 * 60 * 1000);
    let delivered_date: string | null = null;
    let rto_date: string | null = null;
    let ndr_count = 0;
    let status: string;
    if (willRto) {
      ndr_count = r.int(1, 3);
      rto_date = new Date(pickup.getTime() + r.int(5, 12) * 24 * 60 * 60 * 1000).toISOString();
      status = "RTO Delivered";
    } else {
      const stillInTransit = placed.getTime() > NOW.getTime() - 3 * 24 * 60 * 60 * 1000 && r.next() < 0.4;
      if (stillInTransit) {
        status = "In Transit";
      } else {
        delivered_date = new Date(pickup.getTime() + r.int(2, 7) * 24 * 60 * 60 * 1000).toISOString();
        status = "Delivered";
      }
    }

    const courierFreight = isCod ? 95 : 65; // COD costs more
    shipments.push({
      id: awbSeq,
      awb: String(awbSeq),
      order_source_id: String(o.id),
      courier_name: courier,
      pincode: pin.pin,
      delivery_pincode: pin.pin,
      status,
      current_status: status,
      freight_charges: courierFreight.toFixed(2),
      ndr_count,
      pickup_scheduled_date: pickup.toISOString(),
      delivered_date,
      rto_date,
    });
  }
  const shipmentPages = paginate(shipments, 100);
  for (let i = 0; i < shipmentPages.length; i++) {
    await writeJson(root, `shiprocket/shipments/page-${i + 1}.json`, { data: shipmentPages[i] });
  }

  // ---- CSV: COGS per SKU (founder-uploaded) ----
  const csv =
    "sku,title,category,price,cogs\n" +
    PRODUCTS.map((p) => `${p.sku},"${p.title}",${p.category},${p.price},${p.cogs}`).join("\n") +
    "\n";
  await mkdir(path.join(root, "csv"), { recursive: true });
  await writeFile(path.join(root, "csv/product_costs.csv"), csv, {
    encoding: "utf-8",
    flag: "w",
  });
}

function paginate<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function stripHelperFields(o: any): any {
  const { _meta_adset_id, _is_cod, ...rest } = o;
  return rest;
}

async function writeJson(root: string, rel: string, body: unknown) {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(body, null, 2), "utf-8");
}
