CREATE TYPE "public"."agent_status" AS ENUM('active', 'paused', 'fired');--> statement-breakpoint
CREATE TYPE "public"."agent_trigger" AS ENUM('cron', 'event', 'threshold');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cod', 'prepaid', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'dismissed', 'executed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'in_transit', 'delivered', 'ndr', 'rto_initiated', 'rto_delivered', 'lost');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('shopify', 'meta', 'shiprocket', 'csv');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"ad_object_id" uuid NOT NULL,
	"match_method" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source" "source" DEFAULT 'shopify' NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"level" text NOT NULL,
	"name" text NOT NULL,
	"parent_source_id" text,
	"status" text NOT NULL,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_spend_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"ad_object_id" uuid NOT NULL,
	"date" text NOT NULL,
	"spend" numeric(12, 2) NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"reasoning_log" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"trigger" "agent_trigger" NOT NULL,
	"schedule" text,
	"decision_template" text NOT NULL,
	"decision_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"authority_cap_inr" numeric(14, 2),
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hired_by" text DEFAULT 'system' NOT NULL,
	"fired_at" timestamp with time zone,
	"declared_failure_modes" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"tool_calls" jsonb,
	"citations" jsonb,
	"citation_violations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_creds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"creds" jsonb NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"default_cogs_ratio" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"sku" text NOT NULL,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"price_per_unit" numeric(12, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"customer_id" text,
	"customer_email" text,
	"payment_method" "payment_method" DEFAULT 'unknown' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"shipping_charged" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"ship_pincode" text,
	"ship_city" text,
	"ship_state" text,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"price" numeric(12, 2) NOT NULL,
	"cogs_per_unit" numeric(12, 2),
	"inventory" integer,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"target_entity" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expected_savings_inr" numeric(14, 2) DEFAULT '0' NOT NULL,
	"prediction" jsonb NOT NULL,
	"actual_outcome" jsonb,
	"accuracy_score" numeric(5, 4),
	"confidence" numeric(4, 3) NOT NULL,
	"caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citation_row_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"resource" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"blob_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"order_id" uuid,
	"awb" text NOT NULL,
	"courier" text NOT NULL,
	"pincode" text NOT NULL,
	"status" "shipment_status" NOT NULL,
	"shipping_cost" numeric(12, 2) NOT NULL,
	"ndr_count" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"rto_at" timestamp with time zone,
	"source" "source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_payload_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"resource" text NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"condition_sql" text NOT NULL,
	"frequency" text NOT NULL,
	"action_template" text NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_ad_object_id_ad_objects_id_fk" FOREIGN KEY ("ad_object_id") REFERENCES "public"."ad_objects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_attributions" ADD CONSTRAINT "ad_attributions_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_objects" ADD CONSTRAINT "ad_objects_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_objects" ADD CONSTRAINT "ad_objects_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_ad_object_id_ad_objects_id_fk" FOREIGN KEY ("ad_object_id") REFERENCES "public"."ad_objects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ad_spend_daily" ADD CONSTRAINT "ad_spend_daily_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_creds" ADD CONSTRAINT "connector_creds_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_raw_payload_id_raw_payloads_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payloads"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watches" ADD CONSTRAINT "watches_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watches" ADD CONSTRAINT "watches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_attributions_msi_idx" ON "ad_attributions" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_attributions_o_idx" ON "ad_attributions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_attributions_ad_idx" ON "ad_attributions" USING btree ("ad_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_objects_msi_idx" ON "ad_objects" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_objects_ml_idx" ON "ad_objects" USING btree ("merchant_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_spend_daily_msi_idx" ON "ad_spend_daily" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_spend_daily_md_idx" ON "ad_spend_daily" USING btree ("merchant_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_spend_daily_ad_idx" ON "ad_spend_daily" USING btree ("ad_object_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_as_idx" ON "agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_ms_idx" ON "agent_runs" USING btree ("merchant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_mn_idx" ON "agents" USING btree ("merchant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_ms_idx" ON "agents" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_sc_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_creds_ms_idx" ON "connector_creds" USING btree ("merchant_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_lines_msi_idx" ON "order_lines" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_lines_o_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_lines_msku_idx" ON "order_lines" USING btree ("merchant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_msi_idx" ON "orders" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_mp_idx" ON "orders" USING btree ("merchant_id","placed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_mpin_idx" ON "orders" USING btree ("merchant_id","ship_pincode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_muc_idx" ON "orders" USING btree ("merchant_id","utm_campaign");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_msi_idx" ON "products" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_msku_idx" ON "products" USING btree ("merchant_id","sku");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_msc_idx" ON "proposals" USING btree ("merchant_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_ac_idx" ON "proposals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_t_idx" ON "proposals" USING btree ("merchant_id","target_entity","target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raw_payloads_merchant_hash_idx" ON "raw_payloads" USING btree ("merchant_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_payloads_msr_idx" ON "raw_payloads" USING btree ("merchant_id","source","resource");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shipments_msi_idx" ON "shipments" USING btree ("merchant_id","source","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_o_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_mpc_idx" ON "shipments" USING btree ("merchant_id","pincode","courier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_ms_idx" ON "shipments" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_state_msr_idx" ON "sync_state" USING btree ("merchant_id","source","resource");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watches_m_idx" ON "watches" USING btree ("merchant_id");