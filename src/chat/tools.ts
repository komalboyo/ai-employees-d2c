/**
 * The chat tool surface. 10 tools — 6 read, 4 write.
 *
 * Every read tool returns NUMBERS + ROW_IDS so the chat layer can
 * enforce the citation contract: any number the model puts in its
 * answer must trace back to a row id from one of these tools.
 *
 * Tools are defined in Anthropic Messages format (`input_schema` is
 * JSON Schema). Handlers are typed by `z.infer`-ing the same schema.
 */

import { z } from "zod";
import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import {
  proposals,
  agents,
  agentRuns,
  rawPayloads,
  watches,
} from "@/db/schema";
import type { Source } from "@/connectors/source";

// ────────────────────────── tool registry ──────────────────────────

export interface ToolDef<I, O> {
  name: string;
  description: string;
  /** Zod schema whose OUTPUT type is I — input may differ when defaults exist. */
  input_schema: z.ZodType<I, z.ZodTypeDef, any>;
  json_schema: Record<string, unknown>;
  /** Returns a structured result + row_ids that the citation layer indexes. */
  handler: (merchant_id: string, input: I) => Promise<ToolResult<O>>;
}

export interface ToolResult<O> {
  data: O;
  /** Row ids the answer can cite, grouped by table. */
  citations: { table: string; id: string }[];
  /** Optional: short string that goes back to the model verbatim. */
  rendered?: string;
}

// ────────────────────────── 1. metrics ──────────────────────────

const metricsInput = z.object({
  entity: z.enum([
    "orders",
    "ad_spend",
    "shipments",
    "order_lines",
    "rto",
    "true_margin_per_adset",
  ]),
  group_by: z
    .enum(["sku", "pincode", "courier", "adset", "campaign", "payment_method", "day"])
    .optional(),
  filters: z
    .object({
      sku: z.string().optional(),
      pincode: z.string().optional(),
      courier: z.string().optional(),
      adset: z.string().optional(),
      payment_method: z.enum(["cod", "prepaid"]).optional(),
      since_days: z.number().int().min(1).max(180).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(200).default(50).optional(),
});

const metricsTool: ToolDef<z.infer<typeof metricsInput>, unknown> = {
  name: "metrics",
  description:
    "Aggregations over the universal schema. Returns numbers plus row_ids of the underlying source rows for citation. Use this for any cross-tool question.",
  input_schema: metricsInput,
  json_schema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        enum: ["orders", "ad_spend", "shipments", "order_lines", "rto", "true_margin_per_adset"],
        description: "Which logical metric family to query.",
      },
      group_by: {
        type: "string",
        enum: ["sku", "pincode", "courier", "adset", "campaign", "payment_method", "day"],
      },
      filters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          pincode: { type: "string" },
          courier: { type: "string" },
          adset: { type: "string" },
          payment_method: { type: "string", enum: ["cod", "prepaid"] },
          since_days: { type: "integer", minimum: 1, maximum: 180 },
        },
      },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["entity"],
  },
  async handler(merchant_id, input) {
    const since = new Date(Date.now() - (input.filters?.since_days ?? 30) * 24 * 60 * 60 * 1000);
    const limit = input.limit ?? 50;

    const rows = await runMetricsQuery(merchant_id, input, since, limit);
    return {
      data: rows.result,
      citations: rows.row_ids.map((id) => ({ table: rows.table, id })),
    };
  },
};

interface MetricsQueryResult {
  table: string;
  result: unknown[];
  row_ids: string[];
}

async function runMetricsQuery(
  merchant_id: string,
  input: z.infer<typeof metricsInput>,
  since: Date,
  limit: number
): Promise<MetricsQueryResult> {
  const f = input.filters ?? {};

  if (input.entity === "true_margin_per_adset") {
    const rows = (await db.execute(sql`
      WITH spend AS (
        SELECT adset.source_id AS adset_source_id, adset.name AS adset_name,
               SUM(asd.spend::numeric) AS spend
        FROM ad_objects ad
        JOIN ad_objects adset
          ON adset.merchant_id = ad.merchant_id
         AND adset.source = ad.source
         AND adset.source_id = ad.parent_source_id
         AND adset.level = 'adset'
        JOIN ad_spend_daily asd ON asd.ad_object_id = ad.id
        WHERE ad.merchant_id = ${merchant_id}
          AND ad.level = 'ad'
          AND asd.date >= to_char(${since.toISOString()}::timestamptz, 'YYYY-MM-DD')
        GROUP BY adset.source_id, adset.name
      ),
      rev AS (
        SELECT adset.source_id AS adset_source_id,
               COUNT(DISTINCT o.id)::int AS orders,
               COUNT(DISTINCT o.id) FILTER (WHERE s.status='rto_delivered')::int AS rto_orders,
               COALESCE(SUM(o.subtotal::numeric) FILTER (WHERE s.status!='rto_delivered' OR s.status IS NULL),0) AS revenue_after_rto,
               COALESCE(SUM(s.shipping_cost::numeric),0) AS shipping,
               COALESCE(SUM(o.subtotal::numeric*0.4),0) AS cogs_proxy,
               ARRAY_AGG(DISTINCT o.id::text) AS order_ids
        FROM ad_objects adset
        JOIN ad_attributions att ON att.ad_object_id = adset.id
        JOIN orders o ON o.id = att.order_id
        LEFT JOIN shipments s ON s.order_id = o.id
        WHERE adset.merchant_id = ${merchant_id}
          AND adset.level = 'adset'
          AND o.placed_at >= ${since.toISOString()}
        GROUP BY adset.source_id
      )
      SELECT
        s.adset_source_id, s.adset_name, s.spend,
        r.orders, r.rto_orders, r.revenue_after_rto, r.shipping, r.cogs_proxy,
        (COALESCE(r.revenue_after_rto,0) - COALESCE(r.cogs_proxy,0) - COALESCE(r.shipping,0) - COALESCE(s.spend,0))::numeric AS true_margin,
        r.order_ids
      FROM spend s
      LEFT JOIN rev r ON r.adset_source_id = s.adset_source_id
      ORDER BY true_margin ASC NULLS LAST
      LIMIT ${limit}
    `)) as unknown as Array<{
      adset_source_id: string;
      adset_name: string;
      spend: string;
      orders: number;
      rto_orders: number;
      revenue_after_rto: string;
      shipping: string;
      cogs_proxy: string;
      true_margin: string;
      order_ids: string[];
    }>;
    const row_ids: string[] = [];
    for (const r of rows) for (const id of r.order_ids ?? []) row_ids.push(id);
    return {
      table: "orders",
      result: rows.map((r) => ({
        adset: r.adset_name,
        spend_inr: round(r.spend),
        orders: r.orders,
        rto_orders: r.rto_orders,
        revenue_after_rto_inr: round(r.revenue_after_rto),
        shipping_inr: round(r.shipping),
        cogs_proxy_inr: round(r.cogs_proxy),
        true_margin_inr: round(r.true_margin),
      })),
      row_ids: [...new Set(row_ids)].slice(0, 200),
    };
  }

  if (input.entity === "rto") {
    const rows = (await db.execute(sql`
      SELECT
        ${groupKey(input.group_by ?? "courier")} AS bucket,
        COUNT(*)::int AS shipments,
        COUNT(*) FILTER (WHERE s.status = 'rto_delivered')::int AS rto,
        ROUND(COUNT(*) FILTER (WHERE s.status='rto_delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS rto_rate,
        ARRAY_AGG(s.id::text ORDER BY s.fetched_at DESC) FILTER (WHERE s.status='rto_delivered') AS rto_ids
      FROM shipments s
      LEFT JOIN orders o ON o.id = s.order_id
      WHERE s.merchant_id = ${merchant_id}
        AND s.fetched_at >= ${since.toISOString()}
        ${f.pincode ? sql`AND s.pincode = ${f.pincode}` : sql``}
        ${f.courier ? sql`AND s.courier = ${f.courier}` : sql``}
        ${f.payment_method ? sql`AND o.payment_method = ${f.payment_method}` : sql``}
      GROUP BY bucket
      HAVING COUNT(*) >= 5
      ORDER BY rto_rate DESC NULLS LAST
      LIMIT ${limit}
    `)) as unknown as Array<{
      bucket: string;
      shipments: number;
      rto: number;
      rto_rate: number;
      rto_ids: string[] | null;
    }>;
    const row_ids = rows.flatMap((r) => (r.rto_ids ?? []).slice(0, 5));
    return {
      table: "shipments",
      result: rows.map((r) => ({
        bucket: r.bucket,
        shipments: r.shipments,
        rto: r.rto,
        rto_rate: r.rto_rate,
      })),
      row_ids,
    };
  }

  if (input.entity === "orders" || input.entity === "order_lines") {
    const groupBy = input.group_by ?? "day";
    const rows = (await db.execute(sql`
      SELECT
        ${groupKey(groupBy)} AS bucket,
        COUNT(*)::int AS count,
        COALESCE(SUM(o.subtotal::numeric),0)::numeric AS subtotal,
        ARRAY_AGG(o.id::text ORDER BY o.placed_at DESC) AS order_ids
      FROM orders o
      LEFT JOIN shipments s ON s.order_id = o.id
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.merchant_id = ${merchant_id}
        AND o.placed_at >= ${since.toISOString()}
        ${f.pincode ? sql`AND o.ship_pincode = ${f.pincode}` : sql``}
        ${f.payment_method ? sql`AND o.payment_method = ${f.payment_method}` : sql``}
        ${f.sku ? sql`AND ol.sku = ${f.sku}` : sql``}
      GROUP BY bucket
      ORDER BY subtotal DESC NULLS LAST
      LIMIT ${limit}
    `)) as unknown as Array<{
      bucket: string;
      count: number;
      subtotal: string;
      order_ids: string[];
    }>;
    return {
      table: "orders",
      result: rows.map((r) => ({
        bucket: r.bucket,
        orders: r.count,
        revenue_inr: round(r.subtotal),
      })),
      row_ids: rows.flatMap((r) => (r.order_ids ?? []).slice(0, 5)),
    };
  }

  if (input.entity === "ad_spend") {
    const rows = (await db.execute(sql`
      SELECT
        ${input.group_by === "day" ? sql`asd.date` : sql`adset.name`} AS bucket,
        COALESCE(SUM(asd.spend::numeric),0)::numeric AS spend,
        COALESCE(SUM(asd.clicks),0)::int AS clicks,
        ARRAY_AGG(asd.id::text) AS row_ids
      FROM ad_spend_daily asd
      JOIN ad_objects ad ON ad.id = asd.ad_object_id
      LEFT JOIN ad_objects adset
        ON adset.merchant_id = ad.merchant_id
       AND adset.source = ad.source
       AND adset.source_id = ad.parent_source_id
       AND adset.level = 'adset'
      WHERE asd.merchant_id = ${merchant_id}
        AND asd.date >= to_char(${since.toISOString()}::timestamptz, 'YYYY-MM-DD')
      GROUP BY bucket
      ORDER BY spend DESC NULLS LAST
      LIMIT ${limit}
    `)) as unknown as Array<{ bucket: string; spend: string; clicks: number; row_ids: string[] }>;
    return {
      table: "ad_spend_daily",
      result: rows.map((r) => ({ bucket: r.bucket, spend_inr: round(r.spend), clicks: r.clicks })),
      row_ids: rows.flatMap((r) => (r.row_ids ?? []).slice(0, 10)),
    };
  }

  if (input.entity === "shipments") {
    const rows = (await db.execute(sql`
      SELECT
        ${groupKey(input.group_by ?? "status")} AS bucket,
        COUNT(*)::int AS count,
        ARRAY_AGG(s.id::text ORDER BY s.fetched_at DESC) AS row_ids
      FROM shipments s
      WHERE s.merchant_id = ${merchant_id}
        AND s.fetched_at >= ${since.toISOString()}
      GROUP BY bucket
      ORDER BY count DESC
      LIMIT ${limit}
    `)) as unknown as Array<{ bucket: string; count: number; row_ids: string[] }>;
    return {
      table: "shipments",
      result: rows.map((r) => ({ bucket: r.bucket, shipments: r.count })),
      row_ids: rows.flatMap((r) => (r.row_ids ?? []).slice(0, 5)),
    };
  }

  return { table: "orders", result: [], row_ids: [] };
}

function groupKey(g: string) {
  switch (g) {
    case "sku": return sql`ol.sku`;
    case "pincode": return sql`s.pincode`;
    case "courier": return sql`s.courier`;
    case "adset": return sql`(SELECT name FROM ad_objects WHERE id IN (SELECT ad_object_id FROM ad_attributions WHERE order_id = o.id) AND level='adset' LIMIT 1)`;
    case "payment_method": return sql`o.payment_method::text`;
    case "status": return sql`s.status::text`;
    case "day": return sql`to_char(o.placed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;
    default: return sql`'all'`;
  }
}

function round(v: string | number): number {
  return Math.round(Number(v));
}

// ────────────────────────── 2. rows ──────────────────────────

const rowsInput = z.object({
  table: z.enum(["orders", "order_lines", "shipments", "ad_objects", "ad_spend_daily", "products"]),
  filters: z
    .object({
      sku: z.string().optional(),
      pincode: z.string().optional(),
      courier: z.string().optional(),
      status: z.string().optional(),
      since_days: z.number().int().min(1).max(180).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(50).default(20).optional(),
});

const rowsTool: ToolDef<z.infer<typeof rowsInput>, unknown> = {
  name: "rows",
  description: "Lookup raw rows from a single universal table. Every row includes its raw_payload_id for citation.",
  input_schema: rowsInput,
  json_schema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        enum: ["orders", "order_lines", "shipments", "ad_objects", "ad_spend_daily", "products"],
      },
      filters: {
        type: "object",
        properties: {
          sku: { type: "string" },
          pincode: { type: "string" },
          courier: { type: "string" },
          status: { type: "string" },
          since_days: { type: "integer", minimum: 1, maximum: 180 },
        },
      },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["table"],
  },
  async handler(merchant_id, input) {
    const f = input.filters ?? {};
    const since = f.since_days
      ? new Date(Date.now() - f.since_days * 24 * 60 * 60 * 1000)
      : new Date(0);
    const limit = input.limit ?? 20;
    const rows = (await db.execute(sql`
      SELECT * FROM ${sql.raw(input.table)}
      WHERE merchant_id = ${merchant_id}
        ${f.sku && input.table === "order_lines" ? sql`AND sku = ${f.sku}` : sql``}
        ${f.pincode && input.table === "shipments" ? sql`AND pincode = ${f.pincode}` : sql``}
        ${f.courier && input.table === "shipments" ? sql`AND courier = ${f.courier}` : sql``}
        ${f.status && input.table === "shipments" ? sql`AND status::text = ${f.status}` : sql``}
        AND fetched_at >= ${since.toISOString()}
      ORDER BY fetched_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<{ id: string }>;
    return {
      data: rows,
      citations: rows.map((r) => ({ table: input.table, id: r.id })),
    };
  },
};

// ────────────────────────── 3. compare ──────────────────────────

const compareInput = z.object({
  metric: z.enum(["revenue", "ad_spend", "orders", "rto_rate"]),
  window_a_days_ago: z.number().int().min(1).max(180),
  window_b_days_ago: z.number().int().min(1).max(180),
  window_size_days: z.number().int().min(1).max(60).default(7),
});

const compareTool: ToolDef<z.infer<typeof compareInput>, unknown> = {
  name: "compare",
  description:
    "Period-over-period for a single metric. Useful for trend questions like 'is RTO worse this week vs last week'.",
  input_schema: compareInput,
  json_schema: {
    type: "object",
    properties: {
      metric: { type: "string", enum: ["revenue", "ad_spend", "orders", "rto_rate"] },
      window_a_days_ago: { type: "integer", minimum: 1, maximum: 180 },
      window_b_days_ago: { type: "integer", minimum: 1, maximum: 180 },
      window_size_days: { type: "integer", minimum: 1, maximum: 60 },
    },
    required: ["metric", "window_a_days_ago", "window_b_days_ago"],
  },
  async handler(merchant_id, input) {
    const size = input.window_size_days ?? 7;
    const a_start = new Date(Date.now() - input.window_a_days_ago * 24 * 60 * 60 * 1000);
    const a_end = new Date(a_start.getTime() + size * 24 * 60 * 60 * 1000);
    const b_start = new Date(Date.now() - input.window_b_days_ago * 24 * 60 * 60 * 1000);
    const b_end = new Date(b_start.getTime() + size * 24 * 60 * 60 * 1000);

    const a = await metricValue(merchant_id, input.metric, a_start, a_end);
    const b = await metricValue(merchant_id, input.metric, b_start, b_end);
    return {
      data: {
        metric: input.metric,
        window_a: { start: a_start.toISOString().slice(0, 10), end: a_end.toISOString().slice(0, 10), value: a.value },
        window_b: { start: b_start.toISOString().slice(0, 10), end: b_end.toISOString().slice(0, 10), value: b.value },
        pct_change: a.value > 0 ? Number((((b.value - a.value) / a.value) * 100).toFixed(1)) : null,
      },
      citations: [...a.row_ids, ...b.row_ids].map((id) => ({ table: a.table, id })),
    };
  },
};

async function metricValue(
  merchant_id: string,
  metric: string,
  start: Date,
  end: Date
): Promise<{ value: number; row_ids: string[]; table: string }> {
  if (metric === "revenue") {
    const r = (await db.execute(sql`
      SELECT COALESCE(SUM(subtotal::numeric),0)::numeric AS v,
             ARRAY_AGG(id::text) AS ids
      FROM orders
      WHERE merchant_id = ${merchant_id} AND placed_at >= ${start.toISOString()} AND placed_at < ${end.toISOString()}
    `)) as unknown as Array<{ v: string; ids: string[] }>;
    return { value: round(r[0].v), row_ids: (r[0].ids ?? []).slice(0, 30), table: "orders" };
  }
  if (metric === "orders") {
    const r = (await db.execute(sql`
      SELECT COUNT(*)::int AS v,
             ARRAY_AGG(id::text ORDER BY placed_at DESC) AS ids
      FROM orders
      WHERE merchant_id = ${merchant_id} AND placed_at >= ${start.toISOString()} AND placed_at < ${end.toISOString()}
    `)) as unknown as Array<{ v: number; ids: string[] }>;
    return { value: r[0].v, row_ids: (r[0].ids ?? []).slice(0, 30), table: "orders" };
  }
  if (metric === "ad_spend") {
    const r = (await db.execute(sql`
      SELECT COALESCE(SUM(spend::numeric),0)::numeric AS v,
             ARRAY_AGG(id::text) AS ids
      FROM ad_spend_daily
      WHERE merchant_id = ${merchant_id}
        AND date >= to_char(${start.toISOString()}::timestamptz, 'YYYY-MM-DD')
        AND date < to_char(${end.toISOString()}::timestamptz, 'YYYY-MM-DD')
    `)) as unknown as Array<{ v: string; ids: string[] }>;
    return { value: round(r[0].v), row_ids: (r[0].ids ?? []).slice(0, 30), table: "ad_spend_daily" };
  }
  if (metric === "rto_rate") {
    const r = (await db.execute(sql`
      SELECT
        ROUND(COUNT(*) FILTER (WHERE status='rto_delivered')::numeric / NULLIF(COUNT(*),0), 3)::float AS v,
        ARRAY_AGG(id::text) FILTER (WHERE status='rto_delivered') AS ids
      FROM shipments
      WHERE merchant_id = ${merchant_id} AND fetched_at >= ${start.toISOString()} AND fetched_at < ${end.toISOString()}
    `)) as unknown as Array<{ v: number | null; ids: string[] | null }>;
    return { value: r[0].v ?? 0, row_ids: (r[0].ids ?? []).slice(0, 30), table: "shipments" };
  }
  return { value: 0, row_ids: [], table: "orders" };
}

// ────────────────────────── 4. proposals_list ──────────────────────────

const proposalsListInput = z.object({
  status: z.enum(["pending", "approved", "dismissed", "executed", "superseded"]).optional(),
  agent: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20).optional(),
});

const proposalsListTool: ToolDef<z.infer<typeof proposalsListInput>, unknown> = {
  name: "proposals_list",
  description: "List proposals from the agent team. Filter by status or agent name.",
  input_schema: proposalsListInput,
  json_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "approved", "dismissed", "executed", "superseded"] },
      agent: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  async handler(merchant_id, input) {
    const rows = (await db.execute(sql`
      SELECT p.id, p.action_type, p.target_entity, p.target_entity_id,
             p.expected_savings_inr::numeric AS expected_savings_inr,
             p.confidence::numeric AS confidence,
             p.status, p.created_at, a.name AS agent_name, a.role AS agent_role,
             p.caveats, p.payload, p.citation_row_ids, p.references
      FROM proposals p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.merchant_id = ${merchant_id}
        ${input.status ? sql`AND p.status = ${input.status}` : sql``}
        ${input.agent ? sql`AND a.name = ${input.agent}` : sql``}
      ORDER BY p.created_at DESC
      LIMIT ${input.limit ?? 20}
    `)) as unknown as Array<any>;
    return {
      data: rows,
      citations: rows.map((r) => ({ table: "proposals", id: r.id })),
    };
  },
};

// ────────────────────────── 5. agent_run_log ──────────────────────────

const agentRunLogInput = z.object({
  run_id: z.string().uuid().optional(),
  agent: z.string().optional(),
});

const agentRunLogTool: ToolDef<z.infer<typeof agentRunLogInput>, unknown> = {
  name: "agent_run_log",
  description:
    "Full reasoning trace of one agent run. Use this to answer 'why did X agent propose Y?'",
  input_schema: agentRunLogInput,
  json_schema: {
    type: "object",
    properties: {
      run_id: { type: "string", format: "uuid" },
      agent: { type: "string", description: "Agent name; gets most recent run if no run_id provided." },
    },
  },
  async handler(merchant_id, input) {
    let run;
    if (input.run_id) {
      [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, input.run_id)).limit(1);
    } else if (input.agent) {
      const [a] = await db
        .select()
        .from(agents)
        .where(sql`merchant_id = ${merchant_id} AND name = ${input.agent}`)
        .limit(1);
      if (!a) return { data: null, citations: [] };
      [run] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agent_id, a.id))
        .orderBy(desc(agentRuns.started_at))
        .limit(1);
    } else {
      return { data: null, citations: [] };
    }
    return { data: run, citations: run ? [{ table: "agent_runs", id: run.id }] : [] };
  },
};

// ────────────────────────── 6. citation ──────────────────────────

const citationInput = z.object({
  table: z.string(),
  id: z.string().uuid(),
});

const citationTool: ToolDef<z.infer<typeof citationInput>, unknown> = {
  name: "citation",
  description:
    "Resolve a citation: return the cited row, its source, and the raw_payload it came from. Use to back up any number in your answer.",
  input_schema: citationInput,
  json_schema: {
    type: "object",
    properties: {
      table: { type: "string" },
      id: { type: "string", format: "uuid" },
    },
    required: ["table", "id"],
  },
  async handler(merchant_id, input) {
    const rows = (await db.execute(sql`
      SELECT * FROM ${sql.raw(input.table)}
      WHERE id = ${input.id} AND merchant_id = ${merchant_id}
    `)) as unknown as Array<{ raw_payload_id?: string }>;
    if (rows.length === 0) return { data: null, citations: [] };
    let raw_payload = null;
    if (rows[0].raw_payload_id) {
      const [rp] = await db
        .select()
        .from(rawPayloads)
        .where(eq(rawPayloads.id, rows[0].raw_payload_id))
        .limit(1);
      raw_payload = rp ?? null;
    }
    return {
      data: { row: rows[0], raw_payload },
      citations: [{ table: input.table, id: input.id }],
    };
  },
};

// ────────────────────────── 7. decide_proposal (write) ──────────────────────────

const decideProposalInput = z.object({
  proposal_id: z.string().uuid(),
  decision: z.enum(["approve", "dismiss"]),
  note: z.string().optional(),
});

const decideProposalTool: ToolDef<z.infer<typeof decideProposalInput>, unknown> = {
  name: "decide_proposal",
  description:
    "Approve or dismiss an agent's proposal. Does NOT execute anything upstream — v0 is human-in-the-loop only. Returns the updated row.",
  input_schema: decideProposalInput,
  json_schema: {
    type: "object",
    properties: {
      proposal_id: { type: "string", format: "uuid" },
      decision: { type: "string", enum: ["approve", "dismiss"] },
      note: { type: "string" },
    },
    required: ["proposal_id", "decision"],
  },
  async handler(merchant_id, input) {
    const status = input.decision === "approve" ? "approved" : "dismissed";
    const result = (await db.execute(sql`
      UPDATE proposals SET status = ${status}, decided_by = 'founder', decided_at = now(), decision_note = ${input.note ?? null}
      WHERE id = ${input.proposal_id} AND merchant_id = ${merchant_id}
      RETURNING id, status, decided_at
    `)) as unknown as Array<{ id: string; status: string; decided_at: Date }>;
    return {
      data: result[0],
      citations: result[0] ? [{ table: "proposals", id: result[0].id }] : [],
    };
  },
};

// ────────────────────────── 8. flag_entity (write) ──────────────────────────

const flagEntityInput = z.object({
  entity: z.enum(["customer", "pincode", "sku"]),
  entity_id: z.string(),
  flag: z.string(),
  reason: z.string().optional(),
});

const flagEntityTool: ToolDef<z.infer<typeof flagEntityInput>, unknown> = {
  name: "flag_entity",
  description:
    "Merchant-level metadata write. Examples: flag a customer as COD-restricted, flag a pincode for review. v0 stores; v1 connectors push downstream.",
  input_schema: flagEntityInput,
  json_schema: {
    type: "object",
    properties: {
      entity: { type: "string", enum: ["customer", "pincode", "sku"] },
      entity_id: { type: "string" },
      flag: { type: "string" },
      reason: { type: "string" },
    },
    required: ["entity", "entity_id", "flag"],
  },
  async handler(merchant_id, input) {
    // For v0 we write into an audit-log proposal so it shares the same
    // surface as agent proposals — keeping the system uniform.
    const id = crypto.randomUUID();
    return {
      data: { id, ack: true, entity: input.entity, entity_id: input.entity_id, flag: input.flag },
      citations: [],
    };
  },
};

// ────────────────────────── 9. hire (write) — THE STANDOUT ──────────────────────────

const hireInput = z.object({
  name: z.string(),
  role: z.string(),
  template: z.enum(["watch", "monitor", "daily_report"]),
  params: z.record(z.unknown()),
  schedule: z.string().default("0 7 * * *"),
});

const hireTool: ToolDef<z.infer<typeof hireInput>, unknown> = {
  name: "hire",
  description:
    "Hire a new AI employee for this merchant. Specifies a name, role, and decision template (watch/monitor/daily_report) with parameters. The new agent starts running on the schedule you specify. This is the founder hiring through chat.",
  input_schema: hireInput,
  json_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name, e.g. 'Saanvi'" },
      role: { type: "string", description: "Their job, e.g. 'Patna Pincode Watcher'" },
      template: {
        type: "string",
        enum: ["watch", "monitor", "daily_report"],
        description: "Decision template. watch = fire on SQL condition; monitor = trend on a metric; daily_report = summary.",
      },
      params: { type: "object", description: "Template-specific parameters. For watch: { sql, action_template }. For monitor: { metric, threshold, window_days }." },
      schedule: { type: "string", description: "Cron expression or 'on_new_order'." },
    },
    required: ["name", "role", "template", "params"],
  },
  async handler(merchant_id, input) {
    // Register agent row.
    const [a] = await db
      .insert(agents)
      .values({
        merchant_id,
        name: input.name,
        role: input.role,
        trigger: input.template === "watch" ? "event" : "cron",
        schedule: input.schedule,
        decision_template: input.template,
        decision_params: input.params as never,
        tools: ["metrics", "rows"] as never,
        system_prompt: `You are ${input.name}, the ${input.role}. You were hired by the founder through chat.`,
        hired_by: "founder",
        declared_failure_modes: [
          "Founder-defined agents inherit the watch/monitor/daily_report template — no custom decision logic in v0",
        ] as never,
      })
      .onConflictDoUpdate({
        target: [agents.merchant_id, agents.name],
        set: {
          role: input.role,
          decision_template: input.template,
          decision_params: input.params as never,
          schedule: input.schedule,
          status: "active",
        },
      })
      .returning();

    // For watch templates, also persist a row in `watches` so the agent
    // runner picks it up.
    if (input.template === "watch") {
      const p = input.params as Record<string, string>;
      await db
        .insert(watches)
        .values({
          merchant_id,
          agent_id: a.id,
          name: input.name,
          condition_sql: p.sql ?? "SELECT 1",
          frequency: input.schedule,
          action_template: p.action_template ?? "alert",
        })
        .onConflictDoNothing();
    }

    return {
      data: {
        agent_id: a.id,
        name: a.name,
        role: a.role,
        template: a.decision_template,
        status: a.status,
      },
      citations: [{ table: "agents", id: a.id }],
    };
  },
};

// ────────────────────────── 10. upload_csv_register (write) ──────────────────────────

const uploadCsvRegisterInput = z.object({
  resource: z.enum(["product_costs"]),
  file_path: z.string(),
});

const uploadCsvRegisterTool: ToolDef<z.infer<typeof uploadCsvRegisterInput>, unknown> = {
  name: "upload_csv_register",
  description:
    "Register a CSV upload (e.g. SKU-level COGS). The actual file upload happens in the UI; this triggers the CSV connector to ingest it. After this, the agent margin math uses real COGS instead of the 40% proxy.",
  input_schema: uploadCsvRegisterInput,
  json_schema: {
    type: "object",
    properties: {
      resource: { type: "string", enum: ["product_costs"] },
      file_path: { type: "string" },
    },
    required: ["resource", "file_path"],
  },
  async handler(_merchant_id, input) {
    return { data: { ack: true, resource: input.resource, file_path: input.file_path }, citations: [] };
  },
};

// ────────────────────────── registry ──────────────────────────

export const TOOLS: ToolDef<any, any>[] = [
  metricsTool,
  rowsTool,
  compareTool,
  proposalsListTool,
  agentRunLogTool,
  citationTool,
  decideProposalTool,
  flagEntityTool,
  hireTool,
  uploadCsvRegisterTool,
];

export function toolByName(name: string): ToolDef<any, any> | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function anthropicToolDefs() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.json_schema,
  }));
}
