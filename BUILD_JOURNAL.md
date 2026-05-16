# BUILD_JOURNAL

The brief asks for honesty about what was written by hand vs by an LLM.

**Short version:** I read the brief, designed the product, picked the connectors, designed the schema, structured the agent team, engineered the demo's disagreement, defined the citation contract, picked the Paperclip framing, and overrode Claude's mistakes throughout. Claude wrote the code text under my direction.

## What I decided vs what Claude wrote

Read this column-by-column. The left column is the part that took *thinking*. The right column is the part that took *typing*.

| Layer | What **I (Komal)** decided | What **Claude** wrote under that direction |
|---|---|---|
| **Product framing** — taking "AI employees" literally as an org chart; making the Chief of Staff a synthesizer not a fifth specialist; the `hire()` tool as the standout; the disagreement-detection feature; the intra-company Paperclip north star | All of it. The planning conversation went through 8+ revisions before any code was written. | — |
| **Connector choice** — Shopify + Meta + Shiprocket as the 3 SaaS sources because they cover the canonical D2C unit-economics question, plus CSV as a 4th to stress-test the abstraction with a non-API source. Explicitly rejected Razorpay (redundant for v0), Klaviyo (wrong layer), GA4 (Meta UTMs cover the channel). | Reasoning lives in the plan iterations. | — |
| **The engineered demo story** — Crimson Tee COD Push routes orders to Patna pincodes via the degraded Bluedart lane, producing ~48% RTO. Rishi sees negative true margin; Meera sees concentrated RTO; same target, different reasoning. Karan's hoodie stockout cross-references Rishi's pause. | All my product design. | — |
| **Schema rules** — multi-tenant root on every table, provenance as a NOT NULL FK (not a convention), source-agnostic entities (no `shopify_orders` / `meta_campaigns` per-source tables), `$ref` placeholder convention for cross-connector FKs. | I specified the rules. | Drizzle schema text. |
| **Connector abstraction** — interface shape (`auth` / `fetch` / `normalize`), the orchestrator's provenance contract (write `raw_payloads` before normalization, NULL-fail on missing provenance), the FixtureFetcher / LiveFetcher split so reviewers can run without real creds. | Design + the rules the orchestrator enforces. | Implementations + the FK resolver. |
| **Agent contract** — what's shared vs what each specialist owns (trigger, tools, system_prompt, decision rule shape, run-log structure, proposal format, citation requirement, authority cap, declared failure modes); phase-1 / phase-2 ordering so portfolio agents reference ops agents. | All design. | The TypeScript scaffolding. |
| **Each specialist's decision logic** — Aanya's wasted-spend cross-reference; Rishi's true-margin formula with RTO netting; Meera's two responsibilities (adset RTO concentration + lane degradation); Karan's conditional reorder qty that references pending pauses. | My math, my rules, my thresholds. | The SQL + TypeScript. |
| **Citation contract** — `[cite:table:id1,id2,...]` mandatory after every numeric claim, server-side re-verification, retry-on-violation up to 2 times, forced "I can't ground that" fallback. | I designed the contract. | The parser + validator + engine loop. |
| **Synthetic data design** — Kindred Apparel's business model, the pincode × courier × payment-method RTO matrix, the trap adset parameters that produce the canonical disagreement, the hoodie stockout setup. | All my product design. | The generator. |
| **Scale benchmark + the numbers** — what to measure (per-agent latency, chat tool p50/p95, projected 10k cost), the 1000-merchant target, the what-breaks-first table. | My design. The numbers are real Postgres measurements. | The benchmark script. |
| **README + this journal** | I dictated every section's structure, the 10 cross-tool questions, the "another week" stance (genuine bottlenecks vs typing speed), the Paperclip framing. | Claude drafted prose against my outline; I edited. |

## Sessions

| Session | What got built |
|---|---|
| 1 (planning, no code) | Worked through 8+ revisions of the plan. Pivoted from "Tara morning analyst" to "AI org chart" to "the company designed for agents, not humans." Killed several ideas (multi-touch attribution, real OAuth, founder-set agent contracts) for v0. Locked the engineered disagreement story. |
| 2 (build day 1) | Schema (17 tables, provenance constraint). `Connector` interface + 4 implementations (Shopify, Meta, Shiprocket, CSV). Orchestrator with `$ref` resolution. Synthetic seeder. Demo merchant ingest end-to-end. |
| 3 (build day 2) | Five agents (Aanya, Rishi, Meera, Karan, Chief of Staff). Phase-1 / phase-2 orchestration so portfolio agents cross-reference ops agents. Disagreement detection on the demo data. |
| 4 (build day 3 — final) | Chat layer with 10 tools + server-side citation validator. Offline fallback. Next.js UI: morning brief, org chart, trust scorecard, Citation Inspector. Watch-runner + replay grader. Bulk seeder + benchmark (1k merchants in 8.7s). 15-test eval suite passing. README + this journal. |
| 5 (post-feedback polish) | Closed the framing gap on `hire()`. The original design had it as a chat tool only (founder-managed). I added an opt-in autonomous-hire path: with `AUTO_HIRE=1`, the Chief of Staff calls `hireAgent()` herself when a target has been flagged across ≥3 distinct runs. Strictly bounded: max 1 hire per run, idempotent on agent name, full audit trail. Default OFF because autonomous spawning needs trust earned over time. Added a fourth eval suite (4 tests) verifying the bounds. README now explains both modes and the design tension out loud. **19/19 evals passing.** |

## Where Claude got it wrong (and I caught it)

These are the moments where rubber-stamping LLM output would have produced a broken submission. I caught each one.

- **The orchestrator's first dynamic-upsert path** used Drizzle's typed insert builder — Drizzle doesn't expose a fully dynamic-column upsert path. I switched it to `pg.unsafe` with parameterized statements + an allowlist of internal table names (no SQL-injection surface since the table list is internal code).
- **Aanya's thresholds were too tight** and she silently produced 0 proposals. Rather than just loosening, I redesigned her to **cross-reference Rishi/Meera's pauses** — she fires when ≥15% of ad spend is going to adsets the team flagged. That's the right behavior for a CFO and the right pattern for AI-team composition.
- **Karan was too noisy** — 10 SKU reorders. I tightened her threshold to `days_to_stockout < lead_time` so only genuinely urgent SKUs get flagged.
- **Rishi's spend rollup** joined `ad_spend_daily` to the adset level directly. The actual Meta data is at the ad level — I made Claude rewrite the SQL to roll up via `parent_source_id`. (Catching this required me to actually understand how the Meta API exposes insights.)
- **Date serialization to postgres-js**: Drizzle's sql template passes Date objects through fine, but `pg.unsafe(..., params)` doesn't auto-convert. Claude hit this three times before I told it to add a `serialize`/`paramize` helper. Classic case of a model that fixes the local symptom without addressing the root cause.
- **Meta pagination fixture-vs-live**: the connector terminated on `body.paging.next` (live mode) but the fixtures don't return that field — so the first version stopped after 1 page in fixture mode. I caught it because the seeded data showed only 25 ad_spend rows instead of 120. Mode-aware termination fixed it.
- **First README draft was list-heavy.** I rewrote the opening with the 10 cross-tool questions because that's what makes the product legible to a Shiprocket reviewer in 30 seconds.
- **Initial chat offline fallback was useless** — Claude wrote a hardcoded "(no API key)" string. I rewrote it as a real keyword router that still hits the tools and returns real citations, so the citation contract holds in offline mode too.

