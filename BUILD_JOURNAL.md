# BUILD_JOURNAL

The brief asks for honesty about what was written by hand vs by an LLM. This is that honesty. Everything in this repo was built in collaboration with Claude Code (Opus 4.7). I drove the product decisions and architecture; Claude wrote ~90% of the code text under specific direction.

## What the LLM wrote vs what I wrote

| Layer | What I owned | What the LLM produced under direction |
|---|---|---|
| **Product framing** — "AI company" metaphor, the org-chart vs chatbot pivot, the disagreement-detection feature, the `hire()` standout, the "intra-company Paperclip" north star | 100% mine — these came out of the planning conversation before any code | — |
| **Connector decision** (Shopify + Meta + Shiprocket + CSV; rejecting Razorpay/Klaviyo/GA4) | mine, with the reasoning surfaced in the plan iterations | — |
| **The engineered disagreement** (Crimson Tee COD Push → Patna pincodes → Bluedart trap) | mine | — |
| **Schema** | I specified the rules: multi-tenant root, provenance as DB constraint, source-agnostic entities, `$ref` placeholder convention for cross-row FKs | Claude wrote the Drizzle schema text |
| **Connector abstraction** | I specified the interface shape (auth/fetch/normalize) and the orchestrator's provenance contract | Claude wrote the implementations and the FK resolver |
| **Agents** | I specified each one's trigger / decision rule / failure modes / cross-references | Claude wrote the SQL queries and TypeScript |
| **Chat layer + citation validator** | I specified the contract (`[cite:table:id]` mandatory after every numeric claim, server-side re-verification) and the 10-tool surface | Claude wrote the parser, the validator, the engine loop |
| **Synthetic data design** | I designed the Kindred Apparel business model, the pincode-courier-payment-method RTO matrix, the trap adset parameters | Claude wrote the generator |
| **Scale benchmark + numbers** | I specified what to measure; the numbers are real (Claude can't fake what comes out of Postgres) | Claude wrote the benchmark script |
| **README + this journal** | I dictated the structure and the framing of every section | Claude drafted; I edited |

## Sessions

| Session | What got built |
|---|---|
| 1 (planning, no code) | Worked through 8+ revisions of the plan. Pivoted from "Tara morning analyst" to "AI org chart" to "the company designed for agents, not humans." Killed several ideas (multi-touch attribution, real OAuth, founder-set agent contracts) for v0. Locked the engineered disagreement story. |
| 2 (build day 1) | Schema (17 tables, provenance constraint). `Connector` interface + 4 implementations (Shopify, Meta, Shiprocket, CSV). Orchestrator with `$ref` resolution. Synthetic seeder. Demo merchant ingest end-to-end. |
| 3 (build day 2) | Five agents (Aanya, Rishi, Meera, Karan, Chief of Staff). Phase-1 / phase-2 orchestration so portfolio agents cross-reference ops agents. Disagreement detection on the demo data. |
| 4 (build day 3 — final) | Chat layer with 10 tools + server-side citation validator. Offline fallback. Next.js UI: morning brief, org chart, trust scorecard, Citation Inspector. Watch-runner + replay grader. Bulk seeder + benchmark (1k merchants in 8.7s). 15-test eval suite passing. README + this journal. |

## Where the LLM got it wrong (and I overrode)

- **First attempt at the orchestrator** used Drizzle's typed insert builder — but Drizzle doesn't expose a fully-dynamic-column upsert path. I switched to `pg.unsafe` with parameterized statements and a strict allowlist of internal table names.
- **Initial agent decisions were too sensitive.** Aanya fired on every run because her thresholds were too tight. I made her cross-reference Rishi's pauses so she has a *reason* to fire that's tied to the rest of the team's findings. Karan fired on 10 SKUs (noisy); tightened threshold to `days_to_stockout < lead_time`.
- **First Rishi SQL** joined `ad_spend_daily` to the `adset` level directly. The actual Meta data is at the ad level. I had it switched to roll up via `parent_source_id`.
- **Date serialization to postgres-js**: Drizzle's sql template passes Date objects through, but `pg.unsafe(..., params)` doesn't auto-convert. Added a `serialize`/`paramize` helper to coerce Date → ISO string. Hit this three separate times before adding the helper.
- **Meta pagination fixture-vs-live**: my fixture connector terminated on a short page; the original code only checked `body.paging.next`. Added a mode-aware termination condition.
- **First README draft was list-heavy.** I rewrote the opening with the 10 cross-tool questions because that's what makes the product legible to a reviewer in 30 seconds.

