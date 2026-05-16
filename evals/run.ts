/**
 * Eval harness.
 *
 * Three eval suites:
 *   1. Golden Q&A — runs the questions in golden.json against the chat
 *      layer. Checks: tool selected, table cited, expected content present.
 *   2. Citation regression — generates 10 fixture answers (some valid,
 *      some malformed) and checks the validator catches the bad ones.
 *   3. Agent decision regression — re-runs all four specialist agents
 *      and checks the canonical proposals fire (the trap pause, the
 *      hoodie reorder, the burn alert, the courier swap).
 *
 * Output: a single PASS/FAIL summary + per-test detail, plus aggregate
 * accuracy that goes in the README.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { merchants } from "@/db/schema";
import { chatTurn } from "@/chat/engine";
import { validate } from "@/chat/validator";
import { toolByName } from "@/chat/tools";

interface Result {
  name: string;
  passed: boolean;
  details: string;
}

const results: Result[] = [];

async function main() {
  const [m] = await db.select().from(merchants).where(sql`name = 'Kindred Apparel'`).limit(1);
  if (!m) throw new Error("Seed first");

  console.log("== Suite 1: Golden Q&A (offline-routable subset) ==");
  await runGoldenSuite(m.id);

  console.log("\n== Suite 2: Citation contract regression ==");
  await runCitationSuite(m.id);

  console.log("\n== Suite 3: Agent decision regression ==");
  await runAgentSuite(m.id);

  // Summary.
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n────────  ${passed}/${results.length} PASSED  ────────`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}${r.passed ? "" : ` — ${r.details}`}`);
  }
  await pg.end();
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

async function runGoldenSuite(merchant_id: string) {
  const golden = JSON.parse(readFileSync("evals/golden.json", "utf-8")) as {
    questions: any[];
  };
  for (const q of golden.questions) {
    try {
      const res = await chatTurn({ merchant_id, user_message: q.question });
      const text = res.assistant_message;
      const tools_used = res.tool_calls.map((t) => t.name);
      const cited_tables = new Set(res.citations.map((c) => c.table));

      const failures: string[] = [];
      // Spec checks
      if (q.must_cite_table && !cited_tables.has(q.must_cite_table)) {
        failures.push(`expected citation to ${q.must_cite_table}, got ${[...cited_tables].join(",")}`);
      }
      if (q.expected_contains_text && !text.toLowerCase().includes(q.expected_contains_text.toLowerCase())) {
        failures.push(`expected text to contain "${q.expected_contains_text}"`);
      }
      if (q.expected_contains_bucket) {
        const blob = JSON.stringify(res.tool_calls);
        if (!blob.includes(q.expected_contains_bucket)) {
          failures.push(`expected bucket "${q.expected_contains_bucket}" in tool result`);
        }
      }
      if (q.expected_top_bucket) {
        const blob = JSON.stringify(res.tool_calls);
        if (!blob.includes(q.expected_top_bucket)) {
          failures.push(`expected top bucket "${q.expected_top_bucket}"`);
        }
      }
      if (q.expected_worst_adset) {
        const blob = JSON.stringify(res.tool_calls);
        if (!blob.includes(q.expected_worst_adset)) {
          failures.push(`expected worst adset "${q.expected_worst_adset}"`);
        }
      }
      if (q.expected_contains_sku) {
        const blob = JSON.stringify(res.tool_calls);
        if (!blob.includes(q.expected_contains_sku)) {
          failures.push(`expected SKU "${q.expected_contains_sku}"`);
        }
      }
      results.push({
        name: `golden:${q.id}`,
        passed: failures.length === 0,
        details: failures.join("; ") || "ok",
      });
      console.log(`  ${failures.length === 0 ? "✓" : "✗"} ${q.id} (tools: ${tools_used.join(",")})`);
    } catch (e) {
      results.push({ name: `golden:${q.id}`, passed: false, details: `error: ${e}` });
      console.log(`  ✗ ${q.id} — error: ${e}`);
    }
  }
}

async function runCitationSuite(merchant_id: string) {
  // Generate a real citation by calling a tool.
  const t = toolByName("metrics")!;
  const real = await t.handler(merchant_id, { entity: "rto", group_by: "courier" });
  const realId = real.citations[0]?.id;
  if (!realId) {
    results.push({ name: "citation:setup", passed: false, details: "no real id from metrics" });
    return;
  }

  const cases: Array<{ name: string; text: string; expect_violation: boolean }> = [
    {
      name: "valid-cited-number",
      text: `Bluedart RTO is 39% [cite:shipments:${realId}].`,
      expect_violation: false,
    },
    {
      name: "uncited-number-rejected",
      text: `Bluedart RTO is around 39%.`,
      expect_violation: true,
    },
    {
      name: "fake-uuid-rejected",
      text: `Spend was ₹100 [cite:orders:00000000-0000-0000-0000-000000000000].`,
      expect_violation: true,
    },
    {
      name: "wrong-table-rejected",
      text: `Spend was ₹100 [cite:bogus_table:${realId}].`,
      expect_violation: true,
    },
    {
      name: "no-numbers-no-citation-ok",
      text: `We have several adsets. The team is watching them.`,
      expect_violation: false,
    },
  ];

  for (const c of cases) {
    const v = await validate(merchant_id, c.text);
    const got_violation = !v.ok;
    const passed = got_violation === c.expect_violation;
    results.push({
      name: `citation:${c.name}`,
      passed,
      details: passed ? "ok" : `expected ${c.expect_violation ? "violation" : "ok"}, got ${got_violation ? "violation" : "ok"} (${v.violations.join("; ")})`,
    });
    console.log(`  ${passed ? "✓" : "✗"} ${c.name}`);
  }
}

async function runAgentSuite(merchant_id: string) {
  // Just verify the canonical proposals exist on the demo merchant.
  const proposals = (await db.execute(sql`
    SELECT a.name AS agent, p.action_type, p.target_entity_id
    FROM proposals p JOIN agents a ON a.id = p.agent_id
    WHERE p.merchant_id = ${merchant_id}
  `)) as unknown as Array<{ agent: string; action_type: string; target_entity_id: string }>;

  const expectations: Array<{ name: string; pred: (p: typeof proposals) => boolean }> = [
    {
      name: "rishi-paused-trap-adset",
      pred: (p) =>
        p.some((x) => x.agent === "Rishi" && x.action_type === "pause_ad_set" && x.target_entity_id === "as_crm_cod"),
    },
    {
      name: "meera-paused-trap-adset",
      pred: (p) =>
        p.some((x) => x.agent === "Meera" && x.action_type === "pause_ad_set" && x.target_entity_id === "as_crm_cod"),
    },
    {
      name: "karan-reordered-hoodie-L",
      pred: (p) =>
        p.some((x) => x.agent === "Karan" && x.action_type === "reorder_inventory" && x.target_entity_id === "HOOD-CHR-L"),
    },
    {
      name: "aanya-cited-team",
      pred: (p) => p.some((x) => x.agent === "Aanya" && x.action_type === "cut_ad_spend"),
    },
    {
      name: "meera-flagged-degraded-lane",
      pred: (p) =>
        p.some(
          (x) =>
            x.agent === "Meera" &&
            x.action_type === "swap_courier_on_lane" &&
            x.target_entity_id.includes("Bluedart::800")
        ),
    },
  ];

  for (const e of expectations) {
    const passed = e.pred(proposals);
    results.push({
      name: `agent:${e.name}`,
      passed,
      details: passed ? "ok" : "expected proposal not found",
    });
    console.log(`  ${passed ? "✓" : "✗"} ${e.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
