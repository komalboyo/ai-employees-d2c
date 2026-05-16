# AI Employees for D2C

The brief asked for a working v0 of "AI employees for D2C brands" with five hard requirements: three connectors, a universal data model, a chat layer, an autonomous agent, and a scalability story. I built an AI company — five named employees, a Chief of Staff who runs the morning standup, a chat layer to interrogate the team, and a citation contract that makes every number traceable to the row it came from.

Demo merchant is **Kindred Apparel**, a synthetic Bangalore streetwear brand. The data is engineered around one specific problem: a Meta adset that looks profitable on ROAS but actually loses money once you net out RTO, shipping, and COGS. Two of my agents independently flag the same adset, for different reasons. The Chief of Staff surfaces the disagreement.

![Morning brief — the founder's daily surface](docs/screenshots/01-morning-brief.png)

---

## How I read the brief

The sentence that decided the product for me was *"most of the time they don't bother. They run on vibes."* That changed how I read the chat-layer requirement. If founders don't bother *asking*, then a chat product alone solves only half the problem — you have to know what to ask. I built the chat layer because the brief required it, but I made it a follow-up surface, not the front door. The front door is a **morning brief**: a daily standup the team writes for the founder. The founder reads it; they don't have to interrogate it.

The second line that mattered was "AI employees" — plural in the problem statement, even though only one autonomous agent is required. I took the plural literally. The system is structured like a small company: roles, hires, authority limits, a track record, a synthesizer who runs the standup. That framing did real work — once it was in place, "two agents disagreeing on the same target" went from a feature to a natural consequence.

The third thing was the line *"two things matter equally: how well you build, and what you choose to build."* I spent the first session doing no coding — just iterating on what to build. That session is documented in [`BUILD_JOURNAL.md`](BUILD_JOURNAL.md).

---

## The cross-tool questions this system answers

Before any design decisions, here's the test I had in mind. Each of these is a question a D2C founder would have to stitch Excel exports for today. Every one needs at least two of my four data sources joined.

1. What's my true margin per SKU after ad spend and shipping?
2. Which Meta campaigns drive orders that mostly RTO?
3. Which pincodes lose me money after attributing ad spend?
4. What's my CAC payback period net of returns?
5. Are my highest-revenue customers in high-RTO pincodes?
6. Which courier-pincode lanes are eating margin I'm not seeing?
7. If I cut Meta spend by ₹X, what's the runway impact net of RTO savings?
8. Which adsets pass ROAS but fail true margin after RTO?
9. Which SKUs am I about to stock out of, and how does that change if a flagged adset is paused?
10. Which COD orders should I auto-convert to prepaid before dispatch?

All 10 are answered in [`demo/answers.md`](demo/answers.md). Re-run with `npm run demo:answer-10`. Total runtime: under 500ms.

---

## What I built — 5-line architecture summary

1. **Next.js (App Router)** serves the morning brief, the team org chart, the trust scorecard, the chat panel, and a Citation Inspector that opens on click.
2. **Postgres** holds 7 source-agnostic business entities, the `agents` / `proposals` / `agent_runs` tables, and a `raw_payloads` archive. Every business row has a NOT NULL foreign key to `raw_payloads` — provenance is structural, not a convention.
3. **One `Connector` interface** (`auth` → `fetch` → `normalize`) has four implementations: Shopify, Meta Marketing API, Shiprocket, and CSV.
4. **Five named agents** in an `agents` table — Aanya (CFO), Rishi (Growth), Meera (Ops), Karan (Supply), Chief of Staff. Their decisions are deterministic SQL; the LLM only writes the proposal copy.
5. **Chat layer with 10 tools** (6 read, 4 write including `hire()`), wrapped in a server-side citation validator that re-fetches every cited row and rejects responses with uncited numbers.

---

## The connectors

The brief asked for at least three SaaS sources behind one shared abstraction, and explicitly scored swappability. I picked:

| Connector | What it covers | Why |
|---|---|---|
| **Shopify (Admin REST)** | orders, line items, products, UTM block on the order | Revenue ground truth. Every other source joins back to its orders. |
| **Meta Marketing API (v21.0)** | campaign/adset/ad hierarchy, daily insights (spend, impressions, clicks) | Without this, "profit per SKU" is just gross margin. Also the riskiest API of the three (token expiry, async insights, app-review gating) — I built it second on purpose to de-risk early. |
| **Shiprocket (REST)** | shipments, AWB, courier, pincode, NDR count, RTO status | The Shiprocket-shaped choice. RTO is a first-class state in my schema because in Indian D2C, RTO is the silent killer of unit economics. |

I added a fourth, deliberately not counted as one of "the three":

| **CSV (file upload)** | SKU-level COGS uploaded by the founder | Stress test of the abstraction. If my `Connector` interface only handles REST APIs, it's shallow. CSV proves it's source-agnostic. Also solves a real gap — SKU-level COGS lives in a spreadsheet, not Shopify. |

**What I considered and rejected:**

- *Razorpay* — duplicates Shopify orders for v0.
- *Klaviyo* — retention layer, wrong slice for an ops-side v0.
- *GA4* — overlaps with Meta UTMs on attribution; marginal value at high integration cost.

The interface lives in [`src/connectors/types.ts`](src/connectors/types.ts):

```ts
interface Connector<TResource> {
  source: 'shopify' | 'meta' | 'shiprocket' | 'csv'
  resources: readonly TResource[]
  auth(creds): Promise<AuthContext>
  fetch(ctx, resource, cursor?): AsyncIterable<RawPage>
  normalize(resource, page): NormalizedRow[]
}
```

The orchestrator ([`src/connectors/orchestrator.ts`](src/connectors/orchestrator.ts)) doesn't know which source it's syncing. It enforces the provenance contract: every fetched page goes to `raw_payloads` first, then normalized rows reference that payload's id. A row with a bad `raw_payload_id` fails the foreign key at insert time.

Cross-connector foreign keys — a Shiprocket shipment referencing a Shopify order — work via a `$ref` placeholder convention. Connectors emit rows with `{ $ref: { table, source, source_id } }`; the orchestrator resolves them with a batched DB lookup (one query per ref-table per page, not per row). Connectors stay pure.

---

## The schema

The schema decision I'm most deliberate about is making **provenance a database constraint, not a convention**. Every business row carries `(source, source_id, raw_payload_id, fetched_at)`, and `raw_payload_id` is NOT NULL with a foreign key. There is no path in the code that can write a row without saying where it came from. The chat layer's citation contract works because of this.

Seven business entities, none of them source-shaped: `products`, `orders`, `order_lines`, `shipments`, `ad_objects`, `ad_spend_daily`, `ad_attributions`.

I deliberately did not create `shopify_orders`, `meta_campaigns`, `shiprocket_shipments` as separate tables. That's the obvious shape if you think source-first. Source-agnostic means adding a fifth connector is new rows in existing tables, not a new schema. It also keeps the chat layer's tool surface small — seven entities, not twenty-something.

`raw_payloads` is content-addressed (hash + JSON) with a unique index on `(merchant_id, content_hash)` so re-syncing a page doesn't duplicate the archive. This is what the Citation Inspector renders when you click a citation pill in the UI:

![Citation Inspector — normalized row + raw Shopify payload](docs/screenshots/03-citation-inspector.png)

*Click a citation on an order from the Crimson Tee COD Push adset. You see the normalized row (UTM = `crimson_tee_cod_push`) on top, and the raw Shopify Admin API payload underneath. The data trail is open.*

---

## The chat layer

Ten tools. Six read, four write:

| # | Tool | Purpose |
|---|---|---|
| 1 | `metrics` | Aggregations over universal entities. Returns numbers AND row_ids for citation. |
| 2 | `rows` | Raw row lookup on a single table with provenance attached. |
| 3 | `compare` | Period-over-period for a single metric. |
| 4 | `proposals_list` | Filter the agent team's outputs by status or agent. |
| 5 | `agent_run_log` | Full reasoning trace of one agent run. "Why did Rishi propose X?" |
| 6 | `citation` | Resolve `(table, id)` to the row + raw_payload. The Inspector calls this. |
| 7 | `decide_proposal` | Approve or dismiss a proposal. Logged. Not executed upstream. |
| 8 | `flag_entity` | Merchant metadata write (e.g. flag a customer as COD-restricted). |
| 9 | **`hire`** | Founder hires a new AI employee through chat. Spawns from a bounded template with parameters. |
| 10 | `upload_csv_register` | Trigger CSV ingestion (e.g. the COGS upload). |

`hire()` is the standout. The founder types something like *"hire someone to watch our Bluedart-Patna lane and alert if RTO crosses 60%"* — that maps to a `monitor` template with parameters, gets a row in the `agents` table, and starts running on the schedule the founder specified. v0 supports three template shapes (watch, monitor, daily_report); arbitrary natural-language role synthesis is v1 work.

**The citation contract is enforced server-side**, not hoped for. In [`src/chat/validator.ts`](src/chat/validator.ts):

1. The system prompt requires every numeric claim to end in `[cite:table:id1,id2,...]`.
2. After the model produces text, the validator parses every cite tag and checks each cited row actually exists *and* belongs to this merchant.
3. It walks the text between citations and flags any segment that contains a number without an immediately-following cite.
4. Violations go back to the model with the specific failures. Up to two retries. After that, the model is forced to say "I can't ground that claim" rather than emit an uncited number.

Five eval cases cover this — valid citation passes, uncited number rejected, fake UUID rejected, non-allowlisted table rejected, prose with no numbers passes (no false positives). All five pass.

The system runs without an Anthropic API key. The chat falls back to a deterministic keyword router that uses the same tools, returns the same citations, and goes through the same validator. The text isn't natural language, but the data trail is real.

---

## The agents

The brief asked for at least one autonomous agent. I built five, because once I committed to "AI employees" as a framing, one agent felt like a chatbot with a cron stapled on. Two or more agents create the conditions for them to disagree on the same target — which is what real teams do.

| Agent | Their job | When they run | What their decision is |
|---|---|---|---|
| **Aanya — CFO** | Watches the runway. Cross-references the team's pauses to compute *wasted ad spend* — ad spend going to adsets Rishi or Meera flagged. | Cron, daily | If net margin is negative OR ≥15% of spend is going to flagged adsets, file a "cut spend" proposal that cites the team's pauses. |
| **Rishi — Growth Lead** | Per-adset *true margin* = revenue-after-RTO − COGS − shipping − ad spend. The point is to flip ROAS-on-paper into a number that accounts for what actually got delivered. | Cron, daily | Pause if true margin negative; scale if margin healthy and ROAS slope flat. |
| **Meera — Ops Lead** | Per-adset RTO concentration (pause for ops reasons even if margin says scale). Per-courier-pincode lane degradation (courier swap). | Cron, hourly | Two proposal shapes — pause adset, swap courier on lane. |
| **Karan — Supply Lead** | Per-SKU stockout date from velocity × inventory × lead time. Reorder qty is conditional on Rishi's pending pauses — if a pause goes through, velocity drops and the reorder math changes. | Cron, daily | "Reorder X units; if Rishi's pause on adset Y goes through, reorder drops to Z." |
| **Chief of Staff** | Not a fifth specialist. A manager. Reads everyone's proposals, ranks by `expected_savings × confidence`, detects same-target disagreements, publishes the morning brief. | Cron, after the team | The morning brief is the Chief's "proposal." |

**The engineered disagreement.** This is the part I want a reviewer to look at first, because it's the moment the team behaves like a team.

The demo data is set up so one specific adset — *Crimson Tee COD Push* — has great ROAS on paper but routes 85% of its orders as COD into Patna pincodes via Bluedart, which is the degraded lane in the synthetic courier model. The adset produces ~48% RTO. Rishi flags it from the margin side (negative true margin after RTO + shipping + COGS). Meera flags the same adset from the ops side (concentrated RTO on a high-failure lane). The Chief of Staff's disagreement detector is a SQL join on `(target_entity, target_entity_id)` — when two proposals point at the same target, it shows up at the top of the brief:

![The disagreement banner + both proposals on the same target](docs/screenshots/02-disagreement.png)

*Top: the Chief of Staff's disagreement banner. Below: Meera's pause (ops reason, 72% confidence) and Karan's reorder that conditionally references Rishi's pause.*

**Why agent decisions are deterministic SQL, not LLM-driven.** This was deliberate. If every agent decision goes through an LLM, you have a 10k-merchant cost problem AND an auditability problem — different runs give different decisions, and a founder can't trust the track record. My agents run SQL against the schema and apply hand-written rules. The LLM is only used to write proposal copy, and that falls back to a templated string without an API key. Decision and explanation are separate layers.

**Trust scorecard.** Every proposal carries a self-prediction. A replay grader backtests these against the most recent N-day window of synthetic data and writes an `accuracy_score`. The UI sidebar shows the score per agent. I'm honest about what this is: replay on synthetic data, not real causal grading. Karan ends up at 94% (stockout predictions are mechanical); Rishi and Meera land at 0–50% (margin/RTO predictions are noisier and the replay window biases hard). Real grading needs counterfactual evaluation, which I treat as the most interesting "another week" item.

---

## Scale — 1 to 10k merchants

The brief wanted a harness or a sketch and an honest answer about what breaks. I built the harness and ran it.

**1000 synthetic merchants × 7 days, seeded directly to Postgres** (the connector path is exercised by the demo merchant; bulk skips it for speed). The seeder finished in 8.7 seconds. Result: ~1M business rows, ~376MB of database.

Agent latency across a random 25-merchant sample:

| Agent | p50 | p95 | max |
|---|---|---|---|
| Aanya | 4ms | 6ms | 15ms |
| Rishi | 7ms | 8ms | 11ms |
| Meera | 7ms | 8ms | 9ms |
| Karan | 6ms | 8ms | 8ms |

Chat tool latency: 1–2ms p95 across `metrics`, `rows`, `compare`, `proposals_list`.

So running the full team against 10,000 merchants every morning is roughly `4 agents × 10,000 × 6ms ≈ 4 minutes of CPU per day` at single-thread concurrency. That part isn't the bottleneck.

**What actually breaks first:**

- **Meta Marketing API rate limits** (200 calls/hour/ad account). At 10k merchants this is the wall, not Postgres. Fix is per-account token rotation + queued async-insights jobs.
- **`raw_payloads` storage**. ~5KB per page × ~100 pages per merchant per day = ~5GB/day, ~1.8TB/year. The schema already has a `blob_url` column for offloading to object storage. v1 keeps hot 90 days in Postgres, cold goes to S3 + DuckDB or Athena.
- **Webhook fan-in at peak**. v0 polls. At 10k merchants, Shopify webhooks at peak hours spike to thousands of events per second. Right thing is Kafka or Kinesis between ingest and normalize.
- **LLM context cost on chat**. Tools already return aggregates plus `row_ids` (not raw rows). Prompt-caching on system prompt + tool definitions cuts this further. Bigger concern is the agent narrator — at 10k × 4 agents that's 40k narration calls per day. v1 switches to templated copy at scale and uses LLM narration only for top-K-by-impact proposals.
- **Cross-tenant SQL safety**. Right now merchant_id is bound at session level + read-only role + LIMIT 1000. v1 turns on Postgres row-level security so leaks are structurally impossible.

Reproduce with `npm run seed:bulk && npm run benchmark`.

---

## Eval — where it breaks

The brief explicitly scored eval honesty: "you tell us where it breaks before we find it." `evals/run.ts` runs three suites:

- **Suite 1 — Golden Q&A (5 tests).** Real cross-tool questions through the chat engine. Each test asserts the right tool got selected, the right table got cited, and the expected content appeared.
- **Suite 2 — Citation contract regression (5 tests).** Valid citation passes; uncited number rejected; fake UUID rejected; non-allowlisted table rejected; prose with no numbers passes.
- **Suite 3 — Agent decision regression (5 tests).** Canonical proposals fire on the demo data: Rishi pauses the trap, Meera pauses the same trap, Karan reorders HOOD-CHR-L, Aanya cites the team, Meera flags the degraded Bluedart-Patna lane.

All 15 pass on the committed demo state. `npm run eval` reproduces.

Where I know it breaks:

1. **Currency.** INR only. Multi-currency merchants silently misaggregate.
2. **Refunds.** RTO is netted into revenue; partial refunds outside the Shopify order flow aren't modeled. Aanya's "net margin" is an approximation.
3. **Attribution.** Last-click UTM only. No multi-touch, no view-through, no iOS-14 dark social. Rishi undercounts the actual adset effect on delivered revenue.
4. **COGS.** Defaults to a 40% proxy unless you upload the CSV. Every agent declares which mode it's in on the proposal.
5. **Time zones.** IST hardcoded in the `day` group_by.
6. **Citation escape hatch.** "Approximately" or "roughly" can slip an uncited number past the validator if the model hedges. v1 closes this.
7. **Cross-tenant SQL.** Filtered, not RLS-enforced (yet).
8. **Self-prediction grading is replay on synthetic data, not real causal grading.** Real grading needs counterfactual evaluation.
9. **`hire()` is parameterized, not free-form.** Arbitrary "hire a creative analyst" is v1.
10. **No real OAuth.** Live mode uses long-lived tokens for one account per source.

---

## Hours and sessions

About **2.5 days across 4 sessions.** The commit history shows the order:

- **Session 1 (planning, no code).** 8+ revisions of the plan with Claude Code. Pivoted from "morning analyst chatbot" to "AI org chart with hires." Locked the engineered disagreement story.
- **Session 2 (build day 1).** Schema with provenance constraint. Connector interface. Four implementations. Orchestrator. Synthetic seeder. Demo merchant ingest end-to-end.
- **Session 3 (build day 2).** Five agents. Phase-1/phase-2 ordering so portfolio agents reference ops agents. Disagreement detection on demo data.
- **Session 4 (build day 3, the long one).** Chat layer with 10 tools + citation validator. Offline fallback. Next.js UI — morning brief, org chart, trust scorecard, Citation Inspector. Watch-runner. Replay grader. Bulk seeder + benchmark. 15-test eval suite. README and BUILD_JOURNAL.

[`BUILD_JOURNAL.md`](BUILD_JOURNAL.md) has the more detailed breakdown of what I owned vs what Claude wrote under direction, including the places I caught the LLM doing the wrong thing.

---

## What I'd do with another week

Most of what I deferred is buildable in this codebase in a day with Claude Code — refunds netted into margins, webhook ingestion, agent memory, more specialists, OAuth, RLS. Calling those "another week" items would be padding.

Here's what's genuinely *not* buildable in a day:

1. **Counterfactual evaluation.** The most damning question for any agent system is "can you prove your proposals would have saved money?" Today, I can't. Building a real counterfactual simulator means replaying merchant history, applying the agent's proposals at the time they would have fired, and scoring outcomes against the unmodified actuals. The hard part isn't the code — it's the methodology: picking control windows, handling spillover effects (pausing adset X redistributes spend to Y), validating the simulator against reality on holdout data. A focused week of applied ML research.

2. **Cross-merchant intelligence with privacy preservation.** *"78% of Bluedart-Patna lanes degraded across the cohort this week"* — network effects across merchants. Only meaningful at real cohort scale. And the privacy piece (k-anonymity, differential privacy noise) has to be done right before this ships safely.

3. **A multi-modal Creative Director agent.** Reads ad creative images, landing pages, product photography, reviews. The vision-model call is easy; calibrating taste on Indian D2C aesthetics is real research with real labeled data.

4. **A trust scorecard with real numbers.** The infrastructure renders today. The numbers become meaningful only after months of real founders approving and dismissing real proposals.

The north star: software that doesn't make founders more productive — it absorbs whole roles. v0 is the first quarter of that arc. Humans still act; AI proposes, explains, and earns trust on a visible scorecard. Two quarters out, agents execute within bounded authority. Four out, the founder writes the goals and the company runs itself. Call it an intra-company [Paperclip](https://github.com/paperclipai/paperclip) — an agentic business with an org hierarchy that can hire, fire, and earn its keep.

---

## Running it

```bash
# 0. boot Postgres
npm install
docker compose up -d db

# 1. push schema
docker compose exec -T db psql -U postgres -d ai_company < drizzle/0000_*.sql

# 2. seed the demo merchant (generates fixtures, runs connectors end-to-end)
cp .env.example .env
npm run seed

# 3. run the agents
npm run agents:run

# 4. (optional) backfill the trust scorecard
npx tsx scripts/grade-predictions.ts

# 5. open the UI
npm run dev   # http://localhost:3000

# 6. CLI chat for eval without UI
npm run chat -- "what's my worst RTO courier?"

# 7. all 10 cross-tool questions as a transcript
npm run demo:answer-10

# 8. scale benchmark (1k synthetic merchants)
SEED_MERCHANTS=1000 npm run seed:bulk
npm run benchmark

# 9. eval suite (15 tests)
npm run eval
```

`ANTHROPIC_API_KEY` is optional. Without it, the chat falls back to a deterministic keyword router that still produces real citations. Set the key to get Claude doing the chat (Sonnet 4.6 by default).

---

## Repo map

```
src/
├── db/schema.ts           # 17 tables, provenance as DB constraint
├── connectors/            # types.ts + orchestrator.ts + 4 implementations
├── seed/                  # synthetic data, engineered to surface disagreements
├── agents/
│   ├── contract.ts        # AgentSpec — config not code
│   ├── runner.ts          # turns AgentSpec → DB rows
│   ├── narrator.ts        # LLM narrative or template fallback
│   ├── aanya/rishi/meera/karan.ts
│   ├── chief-of-staff.ts  # synthesizer + disagreement detection
│   ├── watch-runner.ts    # runs founder-hired agents
│   └── replay-grader.ts   # self-prediction backtest
├── chat/
│   ├── tools.ts           # 10-tool surface
│   ├── system-prompt.ts
│   ├── validator.ts       # server-side citation enforcement
│   └── engine.ts          # tool-use loop + retry-on-violation
└── app/                   # Next.js — page, components, /api
scripts/
├── seed.ts                # demo merchant via the connector path
├── seed-bulk.ts           # 1k synthetic merchants for scale
├── run-agents.ts          # phase-1 then phase-2 agent runs
├── grade-predictions.ts   # backfill accuracy_score
├── chat-cli.ts            # eval-friendly chat
├── benchmark.ts           # scale numbers
├── answer-all-10.ts       # cross-tool transcript
└── screenshots.ts         # README screenshot capture
evals/
├── golden.json            # cross-tool Q&A spec
└── run.ts                 # 15-test eval suite
```

## License

MIT.
