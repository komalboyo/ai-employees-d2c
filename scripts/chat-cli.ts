/**
 * Quick CLI for the chat layer — useful for evals and demo without UI.
 * Usage: npm run chat -- "what's my worst RTO pincode?"
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { merchants } from "@/db/schema";
import { chatTurn } from "@/chat/engine";

async function main() {
  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    console.error('Usage: npm run chat -- "your question"');
    process.exit(1);
  }
  const [m] = await db.select().from(merchants).where(sql`name = 'Kindred Apparel'`).limit(1);
  if (!m) throw new Error("Seed first");

  console.log(`\n> ${userMessage}\n`);
  const res = await chatTurn({ merchant_id: m.id, user_message: userMessage });
  console.log(res.assistant_message);
  console.log(`\n---`);
  console.log(`citations: ${res.citations.length}`);
  if (res.violations.length > 0) {
    console.log(`violations: ${res.violations.length}`);
    for (const v of res.violations) console.log(`  ! ${v}`);
  }
  console.log(`tool calls: ${res.tool_calls.map((t) => t.name).join(", ")}`);
  if (res.fallback_used) console.log(`(offline fallback used — set ANTHROPIC_API_KEY to use Claude)`);

  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
