/**
 * Universal data model.
 *
 * Two design rules enforced structurally (not as convention):
 *   1. Every business row is multi-tenant (merchant_id NOT NULL, indexed).
 *   2. Every business row has provenance (raw_payload_id NOT NULL FK).
 *      You cannot insert data without saying where it came from.
 *
 * Source-agnostic shape: adding a 4th connector means new rows in existing
 * tables (`orders`, `ad_spend_daily`, ...) — not new "razorpay_orders" tables.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ---------- Enums ----------

export const sourceEnum = pgEnum("source", ["shopify", "meta", "shiprocket", "csv", "google"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cod", "prepaid", "unknown"]);
export const shipmentStatusEnum = pgEnum("shipment_status", [
  "pending",
  "in_transit",
  "delivered",
  "ndr",
  "rto_initiated",
  "rto_delivered",
  "lost",
]);
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "dismissed",
  "executed",
  "superseded",
]);
export const agentTriggerEnum = pgEnum("agent_trigger", ["cron", "event", "threshold"]);
export const agentStatusEnum = pgEnum("agent_status", ["active", "paused", "fired"]);

// ---------- Tenancy ----------

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Indian D2C defaults; v0 is INR/IST only.
  currency: text("currency").notNull().default("INR"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  // Founder-uploaded COGS overrides; if null, agents use the 40% proxy.
  default_cogs_ratio: numeric("default_cogs_ratio", { precision: 5, scale: 4 }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Raw payload archive (citation target) ----------
//
// Every fetched API response or uploaded file is hashed and stored here.
// Business rows FK into this table — when the chat layer cites
// `(table=orders, id=...)`, the row resolves to a raw_payload, which the
// Citation Inspector renders. Provenance is unforgeable.

export const rawPayloads = pgTable(
  "raw_payloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    source: sourceEnum("source").notNull(),
    resource: text("resource").notNull(), // e.g. "orders", "campaigns", "shipments"
    content_hash: text("content_hash").notNull(), // sha256 of payload
    payload: jsonb("payload").notNull(),
    blob_url: text("blob_url"), // pointer for >1MB payloads in object storage (v1)
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_merchant_hash: uniqueIndex("raw_payloads_merchant_hash_idx").on(t.merchant_id, t.content_hash),
    by_merchant_source_resource: index("raw_payloads_msr_idx").on(t.merchant_id, t.source, t.resource),
  })
);

// ---------- Products / SKU master ----------

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    sku: text("sku").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    // From CSV connector once founder uploads COGS:
    cogs_per_unit: numeric("cogs_per_unit", { precision: 12, scale: 2 }),
    inventory: integer("inventory"),
    // Provenance — NOT NULL, structurally required.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("products_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_merchant_sku: index("products_msku_idx").on(t.merchant_id, t.sku),
  })
);

// ---------- Orders ----------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    order_number: text("order_number").notNull(),
    placed_at: timestamp("placed_at", { withTimezone: true }).notNull(),
    customer_id: text("customer_id"), // source-side customer id; not normalized further in v0
    customer_email: text("customer_email"),
    payment_method: paymentMethodEnum("payment_method").notNull().default("unknown"),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    shipping_charged: numeric("shipping_charged", { precision: 12, scale: 2 }).notNull().default("0"),
    discount: numeric("discount", { precision: 12, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    // UTM block — used for ad attribution joins.
    utm_source: text("utm_source"),
    utm_medium: text("utm_medium"),
    utm_campaign: text("utm_campaign"),
    utm_content: text("utm_content"),
    ship_pincode: text("ship_pincode"),
    ship_city: text("ship_city"),
    ship_state: text("ship_state"),
    // Provenance.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("orders_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_merchant_placed: index("orders_mp_idx").on(t.merchant_id, t.placed_at),
    by_merchant_pincode: index("orders_mpin_idx").on(t.merchant_id, t.ship_pincode),
    by_merchant_utm_campaign: index("orders_muc_idx").on(t.merchant_id, t.utm_campaign),
  })
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    order_id: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    product_id: uuid("product_id").references(() => products.id),
    sku: text("sku").notNull(),
    title: text("title").notNull(),
    quantity: integer("quantity").notNull(),
    price_per_unit: numeric("price_per_unit", { precision: 12, scale: 2 }).notNull(),
    line_total: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    // Provenance inherited from parent order, but we duplicate so
    // every row is independently citable.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("order_lines_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_order: index("order_lines_o_idx").on(t.order_id),
    by_merchant_sku: index("order_lines_msku_idx").on(t.merchant_id, t.sku),
  })
);

// ---------- Shipments (Shiprocket) ----------

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    order_id: uuid("order_id").references(() => orders.id),
    awb: text("awb").notNull(),
    courier: text("courier").notNull(),
    pincode: text("pincode").notNull(),
    status: shipmentStatusEnum("status").notNull(),
    shipping_cost: numeric("shipping_cost", { precision: 12, scale: 2 }).notNull(),
    ndr_count: integer("ndr_count").notNull().default(0),
    dispatched_at: timestamp("dispatched_at", { withTimezone: true }),
    delivered_at: timestamp("delivered_at", { withTimezone: true }),
    rto_at: timestamp("rto_at", { withTimezone: true }),
    // Provenance.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("shipments_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_order: index("shipments_o_idx").on(t.order_id),
    by_merchant_pincode_courier: index("shipments_mpc_idx").on(t.merchant_id, t.pincode, t.courier),
    by_merchant_status: index("shipments_ms_idx").on(t.merchant_id, t.status),
  })
);

// ---------- Ads (Meta) ----------

export const adObjects = pgTable(
  "ad_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    level: text("level").notNull(), // 'campaign' | 'adset' | 'ad'
    name: text("name").notNull(),
    parent_source_id: text("parent_source_id"),
    status: text("status").notNull(),
    // Provenance.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("ad_objects_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_merchant_level: index("ad_objects_ml_idx").on(t.merchant_id, t.level),
  })
);

export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    ad_object_id: uuid("ad_object_id").references(() => adObjects.id, { onDelete: "cascade" }).notNull(),
    date: text("date").notNull(), // YYYY-MM-DD in IST
    spend: numeric("spend", { precision: 12, scale: 2 }).notNull(),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    // Provenance.
    source: sourceEnum("source").notNull(),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("ad_spend_daily_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_merchant_date: index("ad_spend_daily_md_idx").on(t.merchant_id, t.date),
    by_ad_object_date: index("ad_spend_daily_ad_idx").on(t.ad_object_id, t.date),
  })
);

// UTM-based attribution link rows. Lossy by design; agents must own that.
export const adAttributions = pgTable(
  "ad_attributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    order_id: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    ad_object_id: uuid("ad_object_id").references(() => adObjects.id, { onDelete: "cascade" }).notNull(),
    match_method: text("match_method").notNull(), // 'utm_campaign' | 'utm_content' | etc.
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(), // 0..1
    // Provenance (this row is computed, points at both raw payloads it joined).
    source: sourceEnum("source").notNull().default("shopify"),
    source_id: text("source_id").notNull(),
    raw_payload_id: uuid("raw_payload_id").references(() => rawPayloads.id).notNull(),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    by_merchant_source_id: uniqueIndex("ad_attributions_msi_idx").on(t.merchant_id, t.source, t.source_id),
    by_order: index("ad_attributions_o_idx").on(t.order_id),
    by_ad_object: index("ad_attributions_ad_idx").on(t.ad_object_id),
  })
);

// ---------- The Company: agents, proposals, run logs ----------

/**
 * Agents are first-class data — not hardcoded.
 *
 * Pre-built specialists (Aanya, Rishi, Meera, Karan, Chief of Staff) are
 * seeded into this table. `hire()` writes new rows. Firing flips the status.
 *
 * `decision_template` references one of the bounded shapes in src/agents/
 * for founder-hired agents. Pre-built specialists implement their own
 * decide() function and reference themselves here for narrative purposes.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(), // 'Aanya', 'Rishi', 'Meera', 'Karan', 'Chief of Staff', or founder-given
    role: text("role").notNull(), // 'CFO', 'Growth Lead', etc.
    trigger: agentTriggerEnum("trigger").notNull(),
    schedule: text("schedule"), // cron string, or event-spec, or threshold-spec
    decision_template: text("decision_template").notNull(), // 'aanya' | 'rishi' | ... | 'watch' | 'monitor' | 'daily_report'
    decision_params: jsonb("decision_params").notNull().default({}),
    tools: jsonb("tools").notNull(), // subset of available tools this agent can call
    system_prompt: text("system_prompt").notNull(),
    // Agent-native HR primitives:
    authority_cap_inr: numeric("authority_cap_inr", { precision: 14, scale: 2 }), // max ₹-impact this agent can propose
    status: agentStatusEnum("status").notNull().default("active"),
    hired_at: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
    hired_by: text("hired_by").notNull().default("system"), // 'system' for pre-built, 'founder' for hire()
    fired_at: timestamp("fired_at", { withTimezone: true }),
    // Failure modes the agent itself declares — read into system prompt at runtime.
    declared_failure_modes: jsonb("declared_failure_modes").notNull().default([]),
  },
  (t) => ({
    by_merchant_name: uniqueIndex("agents_mn_idx").on(t.merchant_id, t.name),
    by_merchant_status: index("agents_ms_idx").on(t.merchant_id, t.status),
  })
);

/**
 * Every agent invocation produces a run log. This is the agent's HR file.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    agent_id: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"), // 'running' | 'ok' | 'error'
    // Structured reasoning — input ids, intermediate calcs, rule fired, caveats.
    reasoning_log: jsonb("reasoning_log").notNull().default({}),
    error: text("error"),
  },
  (t) => ({
    by_agent_started: index("agent_runs_as_idx").on(t.agent_id, t.started_at),
    by_merchant_started: index("agent_runs_ms_idx").on(t.merchant_id, t.started_at),
  })
);

/**
 * Proposals are the agent's output — never executed in v0, always logged.
 *
 * The `target_entity` + `target_entity_id` pair is what disagreement
 * detection joins on. Two proposals on the same target = a conflict the
 * Chief of Staff surfaces.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    agent_id: uuid("agent_id").references(() => agents.id).notNull(),
    agent_run_id: uuid("agent_run_id").references(() => agentRuns.id).notNull(),
    action_type: text("action_type").notNull(), // 'pause_ad_set' | 'hold_order' | 'reorder' | 'cut_spend' | ...
    target_entity: text("target_entity").notNull(), // 'ad_object' | 'order' | 'sku' | 'pincode_courier' | ...
    target_entity_id: text("target_entity_id").notNull(),
    payload: jsonb("payload").notNull(), // action-specific structured args
    expected_savings_inr: numeric("expected_savings_inr", { precision: 14, scale: 2 }).notNull().default("0"),
    // Self-prediction — the agent predicts the outcome at proposal time.
    prediction: jsonb("prediction").notNull(),
    // Outcome filled in by the replay grader.
    actual_outcome: jsonb("actual_outcome"),
    accuracy_score: numeric("accuracy_score", { precision: 5, scale: 4 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    caveats: jsonb("caveats").notNull().default([]),
    // Citations to source rows that produced this proposal.
    citation_row_ids: jsonb("citation_row_ids").notNull().default([]),
    // References to other proposals that agree/disagree with this one.
    references: jsonb("references").notNull().default([]),
    status: proposalStatusEnum("status").notNull().default("pending"),
    decided_by: text("decided_by"), // 'founder' | 'auto-superseded'
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decision_note: text("decision_note"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_merchant_status_created: index("proposals_msc_idx").on(t.merchant_id, t.status, t.created_at),
    by_agent_created: index("proposals_ac_idx").on(t.agent_id, t.created_at),
    // The disagreement detector: same (merchant, target) → conflict.
    by_target: index("proposals_t_idx").on(t.merchant_id, t.target_entity, t.target_entity_id),
  })
);

// ---------- Sync cursors (per-merchant, per-resource incremental sync) ----------

export const syncState = pgTable(
  "sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    source: sourceEnum("source").notNull(),
    resource: text("resource").notNull(),
    cursor: text("cursor"),
    last_synced_at: timestamp("last_synced_at", { withTimezone: true }),
    last_error: text("last_error"),
  },
  (t) => ({
    by_merchant_source_resource: uniqueIndex("sync_state_msr_idx").on(t.merchant_id, t.source, t.resource),
  })
);

// ---------- Connector credentials (per-merchant, per-source) ----------

export const connectorCreds = pgTable(
  "connector_creds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    source: sourceEnum("source").notNull(),
    creds: jsonb("creds").notNull(), // encrypted in v1; cleartext in v0 (declared in README)
    valid_until: timestamp("valid_until", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_merchant_source: uniqueIndex("connector_creds_ms_idx").on(t.merchant_id, t.source),
  })
);

// ---------- Watches (founder-hired agents from chat) ----------

export const watches = pgTable(
  "watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    agent_id: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    condition_sql: text("condition_sql").notNull(),
    frequency: text("frequency").notNull(), // cron-ish or 'on_new_order' etc.
    action_template: text("action_template").notNull(),
    last_fired_at: timestamp("last_fired_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ by_merchant: index("watches_m_idx").on(t.merchant_id) })
);

// ---------- Chat conversations (for the audit trail) ----------

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
  title: text("title"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchant_id: uuid("merchant_id").references(() => merchants.id, { onDelete: "cascade" }).notNull(),
    session_id: uuid("session_id").references(() => chatSessions.id, { onDelete: "cascade" }).notNull(),
    role: text("role").notNull(), // 'user' | 'assistant' | 'tool'
    content: jsonb("content").notNull(),
    // The chat layer logs every tool call + result for the audit trail.
    tool_calls: jsonb("tool_calls"),
    // If this message has numeric claims, validator records each cite + verification result.
    citations: jsonb("citations"),
    citation_violations: jsonb("citation_violations"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ by_session_created: index("chat_messages_sc_idx").on(t.session_id, t.created_at) })
);
