import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pg } from "@/db/client";
import { merchants } from "@/db/schema";
import { gradeAll } from "@/agents/replay-grader";

async function main() {
  const [m] = await db.select().from(merchants).where(sql`name = 'Kindred Apparel'`).limit(1);
  if (!m) throw new Error("Seed first");
  const r = await gradeAll(m.id);
  console.log(`graded: ${r.graded}  skipped (horizon in future): ${r.skipped}`);

  const summary = (await db.execute(sql`
    SELECT a.name AS agent,
           COUNT(*)::int AS proposals,
           ROUND(AVG(p.accuracy_score)::numeric, 3)::float AS avg_accuracy
    FROM proposals p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.merchant_id = ${m.id} AND p.accuracy_score IS NOT NULL
    GROUP BY a.name
    ORDER BY avg_accuracy DESC NULLS LAST
  `)) as unknown as Array<{ agent: string; proposals: number; avg_accuracy: number }>;
  console.log("\nTrust scorecard (replay-graded):");
  console.table(summary);
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
