/**
 * Run all agents end-to-end for the demo merchant.
 *
 *   1. Wipe today's pending proposals (idempotent demo).
 *   2. Run Aanya, Rishi, Meera, Karan in parallel.
 *   3. Run Chief of Staff to synthesize + detect disagreements.
 *   4. Print the morning brief preview.
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { merchants, proposals } from "@/db/schema";
import { runAgent } from "@/agents/runner";
import { aanya } from "@/agents/aanya";
import { rishi } from "@/agents/rishi";
import { meera } from "@/agents/meera";
import { karan } from "@/agents/karan";
import { chiefOfStaff, getLatestBrief } from "@/agents/chief-of-staff";

async function main() {
  const [m] = await db
    .select()
    .from(merchants)
    .where(sql`name = 'Kindred Apparel'`)
    .limit(1);
  if (!m) throw new Error("Seed first: npm run seed");
  const merchant_id = m.id;

  // Clear pending proposals from previous runs (replayable demo).
  await db.execute(sql`DELETE FROM proposals WHERE merchant_id = ${merchant_id} AND status = 'pending'`);

  // Phase 1: ops-side specialists (Rishi + Meera) run first — they
  // surface adset-level concerns. Phase 2: portfolio-level specialists
  // (Aanya + Karan) run with phase-1 proposals visible so they can
  // cross-reference the team's pauses ("cite Rishi" / "conditional on
  // Rishi's pause"). This is how the AI company works as a team.
  console.log("\n[agents] phase 1: ops-side specialists...");
  const phase1 = await Promise.all([
    runAgent(rishi, { merchant_id, no_narrate: true }),
    runAgent(meera, { merchant_id, no_narrate: true }),
  ]);
  for (const r of phase1) console.log(`  ${r.agent_name}: ${r.proposals_written} proposal(s)`);

  console.log("\n[agents] phase 2: portfolio specialists (cross-referencing)...");
  const phase2 = await Promise.all([
    runAgent(aanya, { merchant_id, no_narrate: true }),
    runAgent(karan, { merchant_id, no_narrate: true }),
  ]);
  for (const r of phase2) console.log(`  ${r.agent_name}: ${r.proposals_written} proposal(s)`);

  const specResults = [...phase1, ...phase2];
  for (const r of specResults) {
    console.log(`  ${r.agent_name}: ${r.proposals_written} proposal(s)`);
  }

  console.log("\n[agents] running Chief of Staff...");
  const cosResult = await runAgent(chiefOfStaff, { merchant_id, no_narrate: true });
  console.log(`  Chief of Staff: ${cosResult.proposals_written} brief written`);

  // Render the brief.
  const brief = await getLatestBrief(merchant_id);
  if (!brief) {
    console.log("\n(no brief produced)");
  } else {
    console.log("\n────────  MORNING BRIEF — Kindred Apparel  ────────");
    console.log(`Date: ${brief.date}`);
    console.log(`Disagreements detected: ${brief.disagreements.length}`);
    for (const d of brief.disagreements) {
      console.log(`  ⚠  ${d.summary}`);
    }
    console.log(`\nTop ${Math.min(brief.ranked_proposals.length, 8)} proposals (by ₹-impact × confidence):`);
    for (const p of brief.ranked_proposals.slice(0, 8)) {
      const dis = p.in_disagreement_with?.length ? " ⚠in-disagreement" : "";
      console.log(
        `  · ${p.agent_name} (${p.agent_role}): ${p.action_type} on ${p.target_entity}:${p.target_entity_id} · ₹${p.expected_savings_inr.toLocaleString("en-IN")} · conf ${(p.confidence * 100).toFixed(0)}%${dis}`
      );
      if (p.narrative) console.log(`     ${p.narrative}`);
    }
  }

  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
