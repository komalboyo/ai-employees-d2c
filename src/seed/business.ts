/**
 * The synthetic business — "Kindred Apparel", Bangalore-based premium
 * streetwear D2C. Numbers are engineered so the four specialist agents
 * each find a real signal, and so Rishi and Meera produce a genuine
 * disagreement on the same target entity:
 *
 *   - Aanya (CFO) sees ad burn running ahead of net revenue → runway alert.
 *   - Rishi (Growth) sees one adset with great ROAS on paper that the
 *     true-margin math (net of RTO + shipping) flips to loss → propose pause.
 *   - Meera (Ops) sees the *same adset* driving COD orders to a
 *     degraded Bluedart-Patna lane with 65% RTO → propose pause until
 *     courier swap. Same target entity, different reasoning.
 *   - Karan (Supply) sees Charcoal Hoodie L stocking out in 8 days
 *     based on velocity that *partly* comes from one of Rishi's adsets;
 *     proposal references Rishi's pending pause.
 */

export const KINDRED_SLUG = "kindred";

export const PINCODES = [
  // pincode, city, state, base_rto_rate (prepaid), cod_rto_multiplier
  { pin: "560001", city: "Bangalore",  state: "Karnataka",      base_rto: 0.05, cod_mult: 1.4 },
  { pin: "560034", city: "Bangalore",  state: "Karnataka",      base_rto: 0.04, cod_mult: 1.3 },
  { pin: "110001", city: "New Delhi",  state: "Delhi",          base_rto: 0.08, cod_mult: 1.8 },
  { pin: "110020", city: "New Delhi",  state: "Delhi",          base_rto: 0.10, cod_mult: 2.0 },
  { pin: "400001", city: "Mumbai",     state: "Maharashtra",    base_rto: 0.06, cod_mult: 1.5 },
  { pin: "400050", city: "Mumbai",     state: "Maharashtra",    base_rto: 0.05, cod_mult: 1.4 },
  { pin: "600001", city: "Chennai",    state: "Tamil Nadu",     base_rto: 0.06, cod_mult: 1.6 },
  { pin: "700001", city: "Kolkata",    state: "West Bengal",    base_rto: 0.12, cod_mult: 2.5 },
  // The trap: Patna pincodes — high COD RTO, currently degraded courier
  { pin: "800001", city: "Patna",      state: "Bihar",          base_rto: 0.18, cod_mult: 3.5 },
  { pin: "800020", city: "Patna",      state: "Bihar",          base_rto: 0.20, cod_mult: 3.6 },
  { pin: "500001", city: "Hyderabad",  state: "Telangana",      base_rto: 0.07, cod_mult: 1.5 },
  { pin: "411001", city: "Pune",       state: "Maharashtra",    base_rto: 0.06, cod_mult: 1.4 },
] as const;

export const COURIERS = ["Bluedart", "Delhivery", "DTDC", "Ekart"] as const;

/**
 * Courier × pincode quality multiplier — Bluedart on Patna is degraded
 * over the last 30 days; Delhivery on Patna is normal. This is
 * Quartermaster-shaped data, except we don't ship Quartermaster in v0.
 */
export const COURIER_PIN_MULT: Record<string, number> = {
  "Bluedart::800001": 1.9, // degraded lane
  "Bluedart::800020": 1.9,
  "Delhivery::800001": 1.0,
  "Delhivery::800020": 1.0,
  "Ekart::700001": 1.4,
};

export interface ProductDef {
  sku: string;
  title: string;
  category: string;
  price: number;
  cogs: number;
  start_inventory: number;
}

export const PRODUCTS: ProductDef[] = [
  { sku: "TEE-COB-S",  title: "Cobalt Tee — S",   category: "Tee",    price: 1499, cogs: 540, start_inventory: 80 },
  { sku: "TEE-COB-M",  title: "Cobalt Tee — M",   category: "Tee",    price: 1499, cogs: 540, start_inventory: 95 },
  { sku: "TEE-COB-L",  title: "Cobalt Tee — L",   category: "Tee",    price: 1499, cogs: 540, start_inventory: 70 },
  { sku: "TEE-COB-XL", title: "Cobalt Tee — XL",  category: "Tee",    price: 1499, cogs: 540, start_inventory: 50 },
  { sku: "TEE-CRM-S",  title: "Crimson Tee — S",  category: "Tee",    price: 1499, cogs: 540, start_inventory: 60 },
  { sku: "TEE-CRM-M",  title: "Crimson Tee — M",  category: "Tee",    price: 1499, cogs: 540, start_inventory: 75 },
  { sku: "TEE-CRM-L",  title: "Crimson Tee — L",  category: "Tee",    price: 1499, cogs: 540, start_inventory: 65 },
  { sku: "TEE-CRM-XL", title: "Crimson Tee — XL", category: "Tee",    price: 1499, cogs: 540, start_inventory: 45 },
  // The stockout victim: Charcoal Hoodie L
  { sku: "HOOD-CHR-M", title: "Charcoal Hoodie — M", category: "Hoodie", price: 2499, cogs: 1050, start_inventory: 40 },
  { sku: "HOOD-CHR-L", title: "Charcoal Hoodie — L", category: "Hoodie", price: 2499, cogs: 1050, start_inventory: 28 },
];

export interface AdSetDef {
  campaign: { id: string; name: string };
  adset: { id: string; name: string };
  daily_spend: number;          // ₹/day
  click_through_rate: number;   // 0..1
  conversion_rate: number;      // among clicks → orders
  payment_cod_share: number;    // 0..1 share of resulting orders that are COD
  preferred_skus: string[];     // bias the SKU mix this adset drives
  preferred_pincodes?: string[]; // bias geography (otherwise uniform)
  preferred_courier?: string;    // bias courier assignment for orders attributed to this
}

export const ADSETS: AdSetDef[] = [
  // Cobalt: healthy, well-distributed.
  {
    campaign: { id: "c_streetwear",  name: "Streetwear Awareness" },
    adset:    { id: "as_cob_lkl",    name: "Cobalt Tee Lookalikes" },
    daily_spend: 2000, click_through_rate: 0.018, conversion_rate: 0.04,
    payment_cod_share: 0.30,
    preferred_skus: ["TEE-COB-S","TEE-COB-M","TEE-COB-L","TEE-COB-XL"],
  },
  // THE TRAP: Crimson COD push — high ROAS on paper, terrible net economics.
  {
    campaign: { id: "c_streetwear",  name: "Streetwear Awareness" },
    adset:    { id: "as_crm_cod",    name: "Crimson Tee COD Push" },
    daily_spend: 3500, click_through_rate: 0.028, conversion_rate: 0.06,
    payment_cod_share: 0.85,             // mostly COD by design (the trap)
    preferred_skus: ["TEE-CRM-S","TEE-CRM-M","TEE-CRM-L","TEE-CRM-XL"],
    preferred_pincodes: ["800001","800020","700001","110001","110020"],
    preferred_courier: "Bluedart",       // routed via the degraded lane
  },
  // Hoodie retargeting — drives the stockout for Karan.
  {
    campaign: { id: "c_hoodie",     name: "Hoodie Launch" },
    adset:    { id: "as_hood_rt",   name: "Hoodie Retargeting" },
    daily_spend: 1500, click_through_rate: 0.040, conversion_rate: 0.09,
    payment_cod_share: 0.20,
    preferred_skus: ["HOOD-CHR-M","HOOD-CHR-L"],
  },
  // Hoodie cold acquisition — early days, modest spend.
  {
    campaign: { id: "c_hoodie",     name: "Hoodie Launch" },
    adset:    { id: "as_hood_cold", name: "Charcoal Hoodie Cold" },
    daily_spend: 800, click_through_rate: 0.012, conversion_rate: 0.025,
    payment_cod_share: 0.35,
    preferred_skus: ["HOOD-CHR-M","HOOD-CHR-L"],
  },
];
