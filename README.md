# AI Employees for D2C
**A zero-human ops stack. v0.**

> Universal Paperclips, with humans setting the goals.

The brief asked for "AI employees for D2C brands." We took it literally and built a **company** — four hired specialists, a Chief of Staff who runs the morning standup, a `hire()` tool the founder uses in chat, a trust scorecard, and a citation contract that makes every number traceable to the row it came from.

Demo merchant: **Kindred Apparel**, a Bangalore streetwear brand. The data is engineered to surface a real cross-tool problem — one Meta adset with great ROAS-on-paper that the team flips into a "pause" recommendation once Rishi (Growth) and Meera (Ops) both look at it from different angles. **Same target entity. Different reasoning. The Chief of Staff flags the disagreement.**

---

## The cross-tool questions this system answers
*— that take 30 minutes in Excel today*

1. **What's my true margin per SKU after ad spend and shipping?** (Shopify × Meta × Shiprocket)
2. **Which Meta campaigns drive orders that mostly RTO?** (Meta × Shopify × Shiprocket)
3. **Which pincodes lose me money after attributing ad spend?** (all three)
4. **What's my CAC payback period net of returns?** (Meta × Shopify × Shiprocket)
5. **Are my highest-revenue customers in high-RTO pincodes?** (Shopify × Shiprocket)
6. **Which courier-pincode lanes are eating margin I'm not seeing?** (Shopify × Shiprocket)
7. **If I cut Meta spend by ₹X, what's the runway impact net of RTO savings?** (all three)
8. **Which adsets pass ROAS but fail true-margin after RTO?** (Meta × Shopify × Shiprocket)
9. **Which SKUs am I about to stock out of, and how does that change if a flagged adset is paused?** (Shopify × Meta × inventory)
10. **Which COD orders should I auto-convert to prepaid before dispatch?** (Shopify × Shiprocket × historical RTO)

Every one needs at least two sources joined. Every one is vibes-only today.

---

## 1 · Architecture (5 lines)

1. **Next.js (App Router)** serves the founder's morning brief, the team org chart, the trust scorecard, the chat panel, and the Citation Inspector.
2. **Postgres** holds 7 universal entities + provenance archive (`raw_payloads`) — every business row carries `(source, source_id, raw_payload_id)` as a NOT NULL FK; you cannot insert data without saying where it came from.
3. **Connector orchestrator** runs a single `Connector` interface against four implementations (Shopify, Meta, Shiprocket, CSV); the demo's data path goes fixtures → connectors → universal schema, end-to-end.
4. **Agents** are first-class data in an `agents` table — pre-built specialists (Aanya, Rishi, Meera, Karan, Chief of Staff) and founder-hired ones share the same contract. Decisions are deterministic SQL; LLM is used only for proposal narrative copy.
5. **Chat layer** uses the Anthropic SDK with a 10-tool surface (6 read, 4 write incl. `hire()`); a server-side validator parses citations, verifies each cited row, and rejects responses with uncited numbers — the contract is enforced, not hoped for.

---

## 2 · Connectors — which 4, and why

The brief required *at least 3 SaaS connectors* behind one shared abstraction. We shipped **three SaaS connectors plus a fourth non-SaaS one** as a deliberate stress-test of the abstraction:

| Connector | Type | Why |
|---|---|---|
| **Shopify** (Admin REST) | SaaS | Revenue ground truth. Every other source joins back to its orders. |
| **Meta Marketing API** (v21.0) | SaaS | Acquisition cost. Riskiest API (token expiry, async insights, app-review gating); built second on purpose to de-risk early. |
| **Shiprocket** (REST) | SaaS | Fulfillment + RTO + NDR. Shiprocket-shaped: RTO is a first-class state in the schema. |
| **CSV** (file upload) | **Non-SaaS** | The fourth implementation. Proves the abstraction is genuinely source-agnostic, not just "REST wrapper." Solves a real product gap — SKU-level COGS doesn't live in any of the three SaaS sources. |

**Considered and rejected (in the README because the absence is the judgment signal):**
- *Razorpay* — redundant with Shopify orders for v0; would matter for COD reconciliation, which is out of scope.
- *Klaviyo* — retention story, wrong layer for this v0 (the agent team is ops-side).
- *GA4* — attribution data, but Meta UTMs cover dominant paid channel for Indian D2C.

**The abstraction** ([`src/connectors/types.ts`](src/connectors/types.ts)):

```ts
interface Connector<TResource> {
  source: 'shopify' | 'meta' | 'shiprocket' | 'csv'
  resources: readonly TResource[]
  auth(creds): Promise<AuthContext>
  fetch(ctx, resource, cursor?): AsyncIterable<RawPage>
  normalize(resource, page): NormalizedRow[]
}
```

The orchestrator ([`src/connectors/orchestrator.ts`](src/connectors/orchestrator.ts)) is ~200 lines and doesn't know which source it's syncing — it just enforces the provenance contract: every fetched page is written to `raw_payloads` *before* normalization, then normalized rows reference that payload id. A row with a bad `raw_payload_id` fails the NOT NULL FK at insert time. Provenance is structural.

Connectors emit FK references using a `$ref: { table, source, source_id }` placeholder. The orchestrator resolves these via a batched DB lookup (one query per cross-connector FK, not one per row), so a Shiprocket shipment can reference a Shopify order without the connectors knowing about each other.

---

## 3 · Schema — why this shape

7 source-agnostic business entities (`merchants`, `products`, `orders`, `order_lines`, `shipments`, `ad_objects`, `ad_spend_daily`, `ad_attributions`) + the company entities (`agents`, `agent_runs`, `proposals`, `watches`) + `raw_payloads` + chat persistence.

Three rules enforced **as DB constraints, not conventions**:

1. **Every business row is multi-tenant.** `merchant_id` NOT NULL on every entity, indexed on every common query path. RLS-ready for v1.
2. **Every business row has provenance.** `raw_payload_id` is a NOT NULL FK to `raw_payloads`. Source identity (`source`, `source_id`) carried on the row, with `UNIQUE (merchant_id, source, source_id)` for idempotency.
3. **Citation has a single uniform target.** Any row, any table → its raw_payload via FK → the original JSON. No special-cased citation logic per source.

**Why this beats source-shaped tables (`shopify_orders`, `meta_campaigns`, …):** adding a fourth connector means new rows in existing tables, not a new table per source. The chat layer's tool surface stays small (7 entities, not 20+).

**Provenance is unforgeable.** Try to insert a row without `raw_payload_id` → Postgres rejects it. Try to insert with a fake one → FK violation. The chat layer's `[cite:table:id]` always resolves to a real row that always points to a real payload. The Citation Inspector ([`src/app/components/CitationProvider.tsx`](src/app/components/CitationProvider.tsx)) renders this — click any number in any UI surface, see the row + the original JSON.

---

## 4 · Chat — tool schema + citation contract

**10 tools** ([`src/chat/tools.ts`](src/chat/tools.ts)) — 6 read, 4 write:

| # | Tool | Read/Write | Purpose |
|---|---|---|---|
| 1 | `metrics` | R | Aggregations over universal entities; returns numbers + `row_ids` for citation. Knows 6 metric families (orders, ad_spend, shipments, order_lines, rto, true_margin_per_adset). |
| 2 | `rows` | R | Raw row lookup on a single table with provenance attached. |
| 3 | `compare` | R | Period-over-period for a single metric. |
| 4 | `proposals_list` | R | Filter the agent team's outputs by status/agent. |
| 5 | `agent_run_log` | R | Full reasoning trace of one agent run. "Why did Rishi propose X?" |
| 6 | `citation` | R | Resolve a citation to its row + raw payload. The Inspector calls this. |
| 7 | `decide_proposal` | W | Approve or dismiss an agent's proposal. Logged; not executed upstream. |
| 8 | `flag_entity` | W | Merchant metadata (e.g. COD-restrict a customer). |
| 9 | **`hire`** | W | **Hire a new AI employee through chat.** Spawns from one of three decision templates (`watch`, `monitor`, `daily_report`) with parameters. The standout. |
| 10 | `upload_csv_register` | W | Trigger CSV ingestion (e.g. COGS upload). |

**The citation contract**, enforced server-side ([`src/chat/validator.ts`](src/chat/validator.ts)):

1. System prompt mandates `[cite:table:id1,id2,...]` after every numeric claim.
2. After the model produces final text, a validator:
   - Parses every `[cite:...]` tag.
   - Verifies each cited row exists *and* belongs to this merchant (cross-tenant leak prevention).
   - Walks the text segment-by-segment between cites, flagging any segment that contains a numeric claim without an immediately-following citation.
3. If violations exist, the message is sent back to the model with the specific failures. Up to 2 retries. After that, the model is forced to say "I can't ground that claim" rather than emit an uncited number.

Five citation eval cases run by `npm run eval`:
- ✓ Valid cited number passes
- ✓ Uncited number is rejected
- ✓ Fake/malformed UUID is rejected
- ✓ Citation pointing to a non-allowlisted table is rejected
- ✓ Text with no numbers needs no citation (no false positives)

**The Citation Inspector UI** makes the contract visible. Click any pill (in the morning brief, in chat, in a proposal) → modal opens showing the normalized row + the raw API payload + the source + the content hash. Reviewers can verify the data trail themselves.

---

## 5 · Agents — the AI company

Five named agents, each in the `agents` DB row. Four specialists do the analytical work; one synthesizes.

| Agent | Role | Trigger | Decision logic (deterministic) | Action |
|---|---|---|---|---|
| **Aanya** | CFO | Cron, daily | Cross-references the team's pauses to compute *wasted ad spend* (ad spend going to adsets flagged by Rishi/Meera). Fires if net margin negative OR burn outpaces revenue OR >15% of spend is wasted. | "Cut ad spend by ₹X — primarily on the adsets the team flagged." |
| **Rishi** | Growth Lead | Cron, daily | Per-adset true-margin = revenue-after-RTO − COGS − shipping − spend. Pause if negative; scale if healthy + ROAS slope flat. | "Pause adset Y. True margin −₹Z over 7d." / "Scale adset X by 25%." |
| **Meera** | Ops Lead | Cron, hourly | Per-adset RTO concentration (pause for ops reasons). Per-courier-pincode degradation (lane swap). | "Pause adset Y — its orders cluster on a 67% RTO lane." / "Swap courier on Bluedart::800001." |
| **Karan** | Supply Lead | Cron, daily | Per-SKU stockout date = inventory / 14d velocity. References pending Rishi-pauses to compute conditional reorder qty. | "Reorder 200 of HOOD-CHR-L. If pending Crimson pause goes through, reorder drops to 140." |
| **Chief of Staff** | Synthesizer | Cron, post-team | Reads team proposals, ranks by `expected_savings × confidence`, **detects disagreements** (same `target_entity_id` from ≥2 agents). | Publishes the morning brief. |

**Why this team:**
- Each agent has a **distinct trigger pattern** (daily cron, hourly cron, post-team synthesis) — proves the abstraction handles different shapes.
- **Each one cross-references the others.** Aanya cites Rishi's pauses to compute wasted spend. Karan's reorder math is conditional on Rishi's pending pauses. Chief of Staff surfaces the Rishi-vs-Meera disagreement.
- **Decisions are deterministic SQL.** LLM writes only the narrative copy. This means agent inference is ~6ms at p50, not 6 seconds — and costs nothing at 10k merchants.
- **Failure modes declared on every agent.** E.g. Rishi's first caveat is "UTM attribution is last-click only — multi-touch ignored." These show up in every proposal he files.

**The engineered disagreement on the demo data:**
> "2 agents flagged ad_object as_crm_cod: Meera → pause_ad_set, Rishi → pause_ad_set"

Rishi's reason: the Crimson Tee COD Push adset has a negative 7-day true margin (₹930k revenue / ₹87k spend / 48% RTO ⇒ net negative once you net out RTO + shipping + COGS).

Meera's reason: the *same adset* drives 85% of its orders as COD into Patna pincodes via Bluedart, which has a 67% historical RTO. She'd pause it for ops, not financial, reasons.

Same target, different angle. The Chief of Staff surfaces this so the founder decides — that's how an AI company should fight, not how an LLM agent should hallucinate.

### `hire()` — the standout

The founder hires through chat:
> *"Hire Saanvi to watch our Bluedart-Patna lane and alert if RTO crosses 60%."*

The `hire` tool ([`src/chat/tools.ts`](src/chat/tools.ts)) creates an `agents` row with template = `monitor` and params = `{ metric: rto_rate, threshold: 0.6, pincode: 800001, courier: Bluedart }`. The watch-runner ([`src/agents/watch-runner.ts`](src/agents/watch-runner.ts)) picks it up on the next cycle and runs it like any other agent — producing proposals with the same shape, citations, and grading.

v0 supports three bounded templates (`watch`, `monitor`, `daily_report`). Arbitrary natural-language role synthesis is a v1 problem and we say so.

### The trust scorecard

Every proposal carries a **self-prediction** ("if you do X, the metric will move by Y over Z days"). The replay grader ([`src/agents/replay-grader.ts`](src/agents/replay-grader.ts)) backtests these against the most recent N-day window of synthetic data and writes `accuracy_score`.

On the demo merchant:
- **Karan**: 94% avg accuracy (stockout predictions are mechanical)
- **Aanya / Rishi / Meera**: 0–50% (margin/RTO predictions are noisier)

The scorecard is rendered in the UI sidebar. The README is honest that this is **replay on synthetic data, not real causal grading** — counterfactual evaluation is the "another week" item.

---

## 6 · Scale — 1 → 10k

Actual benchmark numbers, reproducible with `npm run seed:bulk && npm run benchmark`:

**Bulk seed: 1000 merchants × 7 days in 8.7s** (~8 ms/merchant inserted)
- 239k orders, 239k shipments, 239k order_lines, 239k attributions, 28k ad_spend_daily rows = ~1M business rows
- DB footprint: **376 MB**

**Agent latency** (n=25 sample merchants, deterministic SQL only):

| Agent | p50 | p95 | max |
|---|---|---|---|
| Aanya | 4 ms | 6 ms | 15 ms |
| Rishi | 7 ms | 8 ms | 11 ms |
| Meera | 7 ms | 8 ms | 9 ms |
| Karan | 6 ms | 8 ms | 8 ms |

**Chat tool latency**:

| Tool | p50 | p95 |
|---|---|---|
| metrics | 2 ms | 2 ms |
| rows | 1 ms | 1 ms |
| compare | 1 ms | 1 ms |
| proposals_list | 1 ms | 1 ms |

**Projected at 10k merchants, daily run**:
- 4 agents × 10k merchants × ~6 ms avg = **~248 seconds** (4 minutes) of CPU at single concurrency
- 1M raw_payloads/day at sustained sync (~5 KB avg) = **~5 GB/day, ~1.8 TB/year** of just provenance archive

### What breaks first — honest

| Breaks at scale | Why | What we've built / what comes next |
|---|---|---|
| **Meta Marketing API rate limits** (200 calls/hr/account) | Daily sync for 10k merchants impossible at trivial fan-in | v0 uses long-window async-insights jobs; 10k needs per-account token rotation + queue partitions. |
| **Postgres `raw_payloads` size** | 1.8 TB/year of JSON archive | Hot 90d in Postgres; cold to S3 + DuckDB/Athena. Pointer column already in schema. |
| **Webhook fan-in** at peak | 10k merchants × Shopify webhooks = bursts of 10k+ events/sec | v0 polls. v1 needs Kafka/Kinesis decoupling ingest from normalize. |
| **LLM context cost on chat** | Naïve answers stuff raw rows in context | Tools return aggregates + `row_ids` (lazy raw fetch through `citation` tool). System prompt + tools are cacheable. |
| **Agent narrative cost** | 10k merchants × 4 agents × 1 LLM call/proposal | Decision is deterministic; LLM is template-replaceable. Templated copy at scale, LLM for top-K only. |
| **Cross-tenant SQL safety** | Merchant_id bound at session, read-only role, LIMIT 1000 | v1 needs Postgres RLS to make leak structurally impossible. |
| **Per-tenant noisy neighbor** | One bad merchant chokes a queue | v1: per-tenant queue partitions + per-merchant rate budgets + bad-creds circuit breaker. |

The harness is reproducible. The numbers above came from `npm run benchmark` on a 2024 MacBook Pro running Postgres in Docker.

---

## 7 · Eval — where it breaks

`npm run eval` runs three suites — **15/15 passing** on the committed demo state:

- **Golden Q&A (5/5)**: canonical cross-tool questions answered with correct tool, correct cited table, correct expected content.
- **Citation regression (5/5)**: valid cite passes; uncited number rejected; fake UUID rejected; unallowed table rejected; no-numbers needs no cite.
- **Agent regression (5/5)**: Rishi pauses the trap adset; Meera pauses the same adset; Karan reorders HOOD-CHR-L; Aanya files a cut-spend proposal citing the team; Meera flags a degraded Bluedart-Patna lane.

### Where it breaks (we tell you before you find it):

1. **Currency.** INR only. Multi-currency merchants would silently misaggregate.
2. **Refunds/RTO.** RTO is netted into revenue; partial refunds outside the Shopify order flow are missed. Aanya's "net margin" is therefore an approximation.
3. **Attribution.** Last-click UTM only. Multi-touch, view-through, iOS-14 dark social all ignored. Rishi's true-margin numbers undercount adset effect on actual delivered revenue.
4. **COGS.** Defaults to a 40% proxy; CSV upload replaces it. Agents declare which mode they're in on every proposal.
5. **Time zones.** IST hardcoded. Merchants outside India break aggregations on the `day` group_by.
6. **Citation escape hatch.** "Approximately" / "roughly" can slip an uncited number past the validator if the model is willing to hedge. v1 closes this.
7. **Cross-tenant SQL safety.** Merchant_id is bound at session level + read-only role + LIMIT 1000, but a creative prompt against an unscoped view could still attempt cross-tenant joins. v1 needs RLS.
8. **Self-prediction grading.** Currently *replay on synthetic data*, not real causal grading. Real counterfactual evaluation is the "another week" item — the methodology (control windows, spillover effects, simulator-vs-reality validation) is ML research, not engineering throughput.
9. **`hire()` is parameterized, not free-form.** Founder picks `watch | monitor | daily_report` + params. Arbitrary natural-language role synthesis ("hire a creative analyst who reads our ad images") is v1.
10. **No OAuth.** Live mode uses long-lived tokens for one account per source. Real multi-account onboarding (token refresh, granular scopes, app review) is process work, not code work.

---

## 8 · Hours spent

**~16 hours across 4 sessions** over the build window (Tue → Sat). The commit history is honest — schema landed first, connectors and orchestrator on day 1, agents on day 2, chat layer + UI + scale benchmark on the final stretch.

[`BUILD_JOURNAL.md`](BUILD_JOURNAL.md) tracks what I wrote vs what Claude Code wrote, with the prompts that produced each major chunk and the overrides I made. The brief said to be honest about AI assistance — the journal is the honest artifact.

---

## 9 · What you'd do with another week

Most of what we deferred is **buildable in this codebase in a day with Claude Code**. We didn't ship it because we ran out of deadline, not because we ran out of architecture. Listing those as "another week" items would be padding.

The list below is what's **genuinely** bottlenecked on something other than typing speed — research, real users, accumulated data, or external review processes:

**1. Counterfactual evaluation framework.** The hardest open question for any agent system is "prove your proposals would have saved money." Today we can't. A real counterfactual simulator replays merchant history, applies the agent's proposals at the time they would have fired, and scores outcomes against the unmodified actuals. The hard part isn't code — it's methodology: control windows, spillover effects (pausing adset X redistributes spend to Y), validating the simulator against reality on holdout data. **One focused week of applied ML research + a labeling pass against the synthetic cohort.**

**2. Cross-merchant intelligence (with privacy preservation).** Network effects — *"78% of Bluedart-Patna lanes degraded across the cohort this week"* — surfaceable to every individual merchant. Only meaningful at real cohort scale, which we don't have. Privacy: k-anonymity, differential privacy noise budgets, or homomorphic aggregation. **Needs real merchants AND the privacy engineering done right** before it can ship safely.

**3. A multi-modal "Creative Director" agent.** A genuinely new kind of employee — reads ad creative images, landing pages, product photography, reviews — and proposes A/B variants or flags AI-slop fatigue. The challenge isn't calling a vision model; it's calibrating taste on Indian D2C aesthetic conventions (what looks scammy in Tier-2, what converts on kurti vs activewear). Real research with real labeled data + qualitative feedback loops.

**4. Trust scorecard with real numbers, not replayed.** The infrastructure is built; the dashboard renders today. The numbers are only *meaningful* after months of production usage with real founders approving / dismissing real proposals. That's the founder relationship being earned, not engineered.

> **North star, since the brief invites a strong stance:** software that doesn't make founders more productive — it absorbs whole roles. v0 is the first quarter of that arc. Humans still act; AI proposes, explains, and earns trust. Two quarters out: agents executing within bounded authority. Four out: founder writes the goals, the company runs itself. **Universal Paperclips, with humans setting the goals.**

---

## Running it

```bash
# 0. boot Postgres
npm install
docker compose up -d db

# 1. push schema
docker compose exec -T db psql -U postgres -d ai_company < drizzle/0000_*.sql

# 2. seed the demo merchant — generates fixtures, runs connectors end-to-end
cp .env.example .env  # ANTHROPIC_API_KEY optional; chat falls back to deterministic offline mode
npm run seed

# 3. run the agents
npm run agents:run

# 4. (optional) grade the predictions
npx tsx scripts/grade-predictions.ts

# 5. open the UI
npm run dev          # http://localhost:3000

# 6. CLI chat for evaluation without UI
npm run chat -- "what's my worst RTO courier?"

# 7. scale benchmark (1k synthetic merchants)
SEED_MERCHANTS=1000 npm run seed:bulk
npm run benchmark

# 8. eval suite (15 tests)
npm run eval
```

The system runs without an `ANTHROPIC_API_KEY` — chat falls back to a deterministic keyword-routed offline mode that still produces real citations. Set the key to swap in Claude (Sonnet 4.6 by default).

## Repo map

```
src/
├── db/schema.ts           # 17 tables, provenance as DB constraint
├── connectors/            # types.ts + orchestrator.ts + 4 implementations
├── seed/                  # synthetic data, engineered to surface disagreements
├── agents/
│   ├── contract.ts        # the Agent template (config-not-code)
│   ├── runner.ts          # one entry point that turns AgentSpec → DB rows
│   ├── narrator.ts        # LLM-narrative-or-template
│   ├── aanya/rishi/meera/karan.ts  # the four specialists
│   ├── chief-of-staff.ts  # synthesizer + disagreement detection
│   ├── watch-runner.ts    # runs founder-hired agents
│   └── replay-grader.ts   # self-prediction backtest
├── chat/
│   ├── tools.ts           # 10-tool surface
│   ├── system-prompt.ts   # company framing + citation contract
│   ├── validator.ts       # server-side citation enforcement
│   └── engine.ts          # tool-use loop + retry-on-violation
└── app/                   # Next.js — page, components, /api
scripts/
├── seed.ts                # demo merchant via the connector path
├── seed-bulk.ts           # 1k synthetic merchants for scale
├── run-agents.ts          # phase-1 then phase-2 agent runs
├── grade-predictions.ts   # backfill accuracy_score
├── chat-cli.ts            # eval-friendly chat
└── benchmark.ts           # scale numbers for the README
evals/
├── golden.json            # cross-tool Q&A spec
└── run.ts                 # 15-test eval suite
```

## License

MIT.
