/**
 * The morning brief — the founder's daily push surface.
 *
 * Layout:
 *   [ ORG CHART  ]   [ MORNING BRIEF  ]
 *   [ TRUST CARD ]   [ DISAGREEMENTS  ]
 *                    [ chat panel     ]
 *
 * Click any number/citation pill → Citation Inspector modal opens with
 * the SQL row + raw_payload it came from.
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { merchants, agents } from "@/db/schema";
import { getLatestBrief, type BriefItem } from "@/agents/chief-of-staff";
import { ChatPanel } from "./components/ChatPanel";
import { CitationProvider } from "./components/CitationProvider";

async function getData() {
  const [m] = await db
    .select()
    .from(merchants)
    .where(sql`name = 'Kindred Apparel'`)
    .limit(1);
  if (!m) return null;
  const brief = await getLatestBrief(m.id);
  const team = await db
    .select({ id: agents.id, name: agents.name, role: agents.role, hired_by: agents.hired_by, status: agents.status })
    .from(agents)
    .where(sql`merchant_id = ${m.id}`)
    .orderBy(agents.hired_at);

  // Trust scorecard (mean accuracy per agent).
  const scorecard = (await db.execute(sql`
    SELECT a.name,
           COUNT(*)::int AS proposals,
           ROUND(AVG(p.accuracy_score)::numeric, 3)::float AS accuracy,
           ROUND(SUM(p.expected_savings_inr)::numeric, 0) AS proposed_savings_inr
    FROM proposals p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.merchant_id = ${m.id}
    GROUP BY a.name
    ORDER BY accuracy DESC NULLS LAST
  `)) as unknown as Array<{ name: string; proposals: number; accuracy: number | null; proposed_savings_inr: string }>;

  return { merchant: m, brief, team, scorecard };
}

export default async function Page() {
  const data = await getData();
  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="panel p-8 max-w-md">
          <h1 className="text-xl font-semibold mb-2">No data yet</h1>
          <p className="dim text-sm">
            Run <code className="text-[color:var(--accent)]">npm run seed</code> then{" "}
            <code className="text-[color:var(--accent)]">npm run agents:run</code> to populate the
            company.
          </p>
        </div>
      </div>
    );
  }

  const { merchant, brief, team, scorecard } = data;
  const ranked = brief?.ranked_proposals ?? [];
  const disagreements = brief?.disagreements ?? [];
  const totalSavings = ranked.reduce((s, p) => s + p.expected_savings_inr, 0);

  return (
    <CitationProvider>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-soft px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-xs dim tracking-wide uppercase">AI Employees for D2C</div>
            <h1 className="text-lg font-semibold">
              {merchant.name}
              <span className="dim font-normal text-sm ml-2">· {brief?.date ?? "no brief"}</span>
            </h1>
          </div>
          <div className="text-xs dim">
            A zero-human ops stack. v0. <span className="text-[color:var(--accent)]">Universal Paperclips, with humans setting the goals.</span>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-4 p-4 flex-1">
          {/* Left column — org chart + scorecard */}
          <aside className="col-span-3 space-y-4">
            <section className="panel p-4">
              <h2 className="text-xs uppercase tracking-wide dim mb-3">Org chart</h2>
              <div className="space-y-2">
                {team.map((t) => (
                  <div key={t.id} className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs dim">{t.role}</div>
                    </div>
                    <div className="flex gap-1">
                      <span className={`pill ${t.status === "active" ? "good" : t.status === "paused" ? "warn" : "bad"}`}>
                        {t.status}
                      </span>
                      {t.hired_by === "founder" && <span className="pill">hired by you</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel p-4">
              <h2 className="text-xs uppercase tracking-wide dim mb-3">Trust scorecard</h2>
              <div className="space-y-2">
                {scorecard.map((s) => (
                  <div key={s.name} className="flex items-center justify-between">
                    <span className="text-sm">{s.name}</span>
                    <span className="text-xs">
                      {s.accuracy === null ? (
                        <span className="dim">not yet graded</span>
                      ) : (
                        <>
                          <span
                            className={
                              s.accuracy >= 0.8 ? "text-good" : s.accuracy >= 0.5 ? "text-warn" : "text-bad"
                            }
                          >
                            {Math.round(s.accuracy * 100)}%
                          </span>
                          <span className="dim ml-1">· {s.proposals} props</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] dim mt-3">
                Accuracy is replay-graded on synthetic data. v1 swaps in counterfactual eval.
              </p>
            </section>
          </aside>

          {/* Center — morning brief */}
          <main className="col-span-6 space-y-4">
            <section className="panel p-5">
              <div className="flex items-baseline justify-between mb-1">
                <h2 className="text-base font-semibold">Morning brief</h2>
                <div className="text-xs dim">
                  Chief of Staff · {ranked.length} proposals · ₹{totalSavings.toLocaleString("en-IN")} total impact
                </div>
              </div>
              <p className="text-xs dim mb-4">
                Pushed at 7am IST. Every number cites source rows — click any pill to inspect.
              </p>

              {disagreements.length > 0 && (
                <div className="panel-2 p-3 mb-4 border-l-2 border-[color:var(--warn)]">
                  <div className="text-xs uppercase tracking-wide dim mb-1">⚠ Disagreements</div>
                  {disagreements.map((d, i) => (
                    <div key={i} className="text-sm mb-1 last:mb-0">{d.summary}</div>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {ranked.slice(0, 12).map((p, i) => (
                  <ProposalCard key={p.proposal_id} item={p} rank={i + 1} />
                ))}
              </div>
            </section>
          </main>

          {/* Right — chat panel */}
          <aside className="col-span-3">
            <ChatPanel merchant_id={merchant.id} />
          </aside>
        </div>
      </div>
    </CitationProvider>
  );
}

function ProposalCard({ item, rank }: { item: BriefItem; rank: number }) {
  const colorClass = item.in_disagreement_with?.length ? "warn" : "";
  return (
    <div className="panel-2 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm flex-1">
          <span className="dim mr-2">{rank}.</span>
          <span className="font-medium">{item.agent_name}</span>
          <span className="dim ml-1">({item.agent_role})</span>
          <span className="mx-1">·</span>
          <span className="font-mono text-xs">{item.action_type}</span>
          <span className="dim mx-1">on</span>
          <CitationPill table={pickTable(item.target_entity)} id={item.target_entity_id} label={`${item.target_entity}:${item.target_entity_id}`} />
        </div>
        <div className="text-right whitespace-nowrap">
          <div className={`font-mono ${colorClass ? "text-warn" : ""}`}>
            ₹{item.expected_savings_inr.toLocaleString("en-IN")}
          </div>
          <div className="text-[10px] dim">conf {Math.round(item.confidence * 100)}%</div>
        </div>
      </div>
      {item.in_disagreement_with && item.in_disagreement_with.length > 0 && (
        <div className="text-[11px] text-warn mt-1">⚠ in disagreement with {item.in_disagreement_with.length} other proposal(s)</div>
      )}
      {item.narrative && <div className="text-sm mt-2">{item.narrative}</div>}
      {item.caveats?.length > 0 && (
        <div className="text-[11px] dim mt-2">
          Caveats: {item.caveats.join("; ")}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="text-[10px] dim mr-1">citations:</span>
        {(item.citation_row_ids ?? []).slice(0, 6).map((c, i) => (
          <CitationPill key={`${c.table}-${c.id}-${i}`} table={c.table} id={c.id} />
        ))}
        {item.citation_row_ids.length > 6 && (
          <span className="text-[10px] dim">+{item.citation_row_ids.length - 6} more</span>
        )}
      </div>
    </div>
  );
}

function pickTable(target_entity: string): string {
  switch (target_entity) {
    case "ad_object": return "ad_objects";
    case "sku": return "products";
    case "pincode_courier": return "shipments";
    default: return "proposals";
  }
}

import { CitationPill } from "./components/CitationPill";
