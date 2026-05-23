# Reference-Cron Comparison: Improvement Backlog

> **Status (2026-05-23):** Improvement note, not a design lock. Written after a side-by-side comparison of one live `pixiu analyze cost-summary` run (run-id `e8d73b9e`, three GrafanaDevRP-family subscriptions, 2026-05-16 → 2026-05-23) against the reference Claude-Code cron at `claw-context/cron-azure-cost-analysis/report.md` (Run 12, 8 subscriptions, week ending 2026-05-12).
>
> The reference cron is currently producing materially better operator value per run than az-pixiu. This document characterizes *why*, ties each finding to either an existing roadmap slot or a previously-unnamed gap, and calls out one operational blocker — 429 handling — that is design-discussed but not implemented.

## TL;DR

- **The Phase 2.5 / Phase 3 plan in [cost-summary-depth.md](cost-summary-depth.md) is the right plan.** Every major gap surfaced by the comparison maps cleanly onto Gaps 1–6 of that document. No re-design needed for them; the work just hasn't shipped yet.
- **There is one critical gap the existing design *names* but does not *plan*: 429 / rate-limit retry behaviour.** The current pixiu run dropped 2 of 3 subscriptions to rate-limit errors and produced a one-subscription report without comment. The reference cron handled the same condition with 60–180s backoff and serialized retries across an 8-sub run, never losing a subscription in 12 weeks. This is not a Gap 1–6 item; it is a `MCPTransport` / orchestrator concern that needs its own §7 entry. **§Gap 7 below.**
- **Three smaller observations are worth landing earlier than the rest of Phase 3** because they cost very little and meaningfully tighten the report on every run: dedupe of repeated freshness findings, executive-summary call-out of dropped subscriptions, and a one-line "operational footer" similar to the reference cron's. **§Smaller items below.**

## Setup: what was compared

**Pixiu live run** (`runs/e8d73b9e-5a7b-4e8a-ad95-4d8d0b436a48/report.md`):

- Scope: 3 subscriptions matching `--subscription-name-filter GrafanaDevRP`.
- 7-day window ending `2026-05-23T15:43:22Z`.
- Returned cost data for **1 of 3 subs** ($5,433.79 total observed). Two subs (`c01c5bb6`, `5812591f`) returned 429 from `amgmcp_cost_analysis`.
- 5 facts, 2 hypotheses, 2 recommendations.
- 3 freshness findings (`dq-freshness-1/2/3`) with byte-identical body text, one per subscription.
- 2 data-quality findings (`dq-1` rate_limit, `dq-2` freshness_partial_window).
- Langfuse trace export 401 (separate plumbing issue, not in scope here).

**Reference cron weekly report** (`claw-context/cron-azure-cost-analysis/report.md`, Run 12):

- Scope: 8 subscriptions (4 of which overlap with the pixiu scope).
- 7-day window ending 2026-05-12 (one cycle earlier than pixiu's, but the comparison is structural not numerical).
- Returned cost data for **8 of 8 subs**; hit 1 throttle on Jenkins, cleared with 120s backoff.
- Cross-week historical table (12 runs).
- Per-service WoW delta column.
- Per-sub WoW delta column with directional arrows.
- Named waste candidates (orphan IPs, restored-PG, stopped/failed AKS, unattached disks, deallocated VM), counted, with weekly $ estimates.
- Naming-pattern clusters (`ipv6-pe-pool-test-vhx-*` family of 24 IPs treated as one cluster).
- Continuity markers ("UNCHANGED week 10", "first movement in 10 weeks", "RECURRING — same pattern as Run 8").
- One-line operational footer per run-changelog entry ("All 8 cost-analysis queries succeeded with 0 throttles this run").

## The six already-designed gaps, restated against the live data

These are not new findings; they are confirmations that the Phase 2.5 / Phase 3 plan would have produced a materially better report on this scope. Numbered to match [cost-summary-depth.md](cost-summary-depth.md).

| Plan gap | What the live pixiu run produced | What the reference cron produced | Status |
|---|---|---|---|
| Gap 1 — waste detection lane | None — only "top services by spend" | 182 orphan IPs / 7 restored-PG / 2 stopped AKS / 8 disks / 1 deallocated VM, each enumerated by ID | Designed, Phase 3, partially seeded (`pricing/`, `src/run/freshness.ts`) |
| Gap 2 — naming-pattern clustering | None | `ipv6-pe-pool-test-vhx-*` cluster of 24 IPs called out as one cause, not 24 leaks | Designed, Phase 3, not started |
| Gap 3 — calibrated weekly impact | None — qualitative "material" tag only | "~$87/week for 182 orphan IPs", "~$700/week for 7 restored-PG" | Designed, Phase 3, **rate card seeded** in commit `7f1e5c9` |
| Gap 4 — freshness reasoning | **3 findings emitted** (one per sub, repeated body) — partial credit | "🚨 Likely data-freshness artifact" narrative in Run 8/9 when uniform drop fired | Designed, Phase 3, **partial-window check shipped** in commit `b851ff9`. Uniform-drop heuristic still pending; *dedupe* not addressed (see Smaller item §S1) |
| Gap 5 — cross-run continuity | "found 1 prior run(s) … injecting prior_run_context" — orchestrator path works; reasoner did not surface continuity in the report body | "UNCHANGED week 10", "first movement in 10 weeks", "RECURRING from Run 8" | **Phase 2.5 foundation shipped** (commits `69479e8`, `fdc18a6`); `reasoner.v2` prompt rules to *consume* it pending (Phase 3 step 10) |
| Gap 6 — Run Quality section | Section emitted but body content is just the three repeated freshness findings | "1 throttle on Jenkins (120s backoff cleared)", "0 throttles, all 8 queries succeeded" | Designed, **section shipped** in `src/report/markdown.ts`; transport/throttle observations not yet plumbed in (see §Gap 7 and §S3) |

The Phase 2.5 work has landed. Phase 3 is partly seeded (rate card, freshness check). The user-visible delta will appear when steps 6–11 in [cost-summary-depth.md §Implementation sequencing](cost-summary-depth.md#implementation-sequencing) land in series.

---

## §Gap 7 — 429 / rate-limit handling: design-named, implementation-missing

This is the most important gap surfaced by the comparison. It is also the one not currently planned, only acknowledged.

### Observation

The live pixiu run hit 429 on `amgmcp_cost_analysis` for 2 of 3 in-scope subscriptions, classified them as `rate_limit` per `src/failure/taxonomy.ts`, attached an `actionable_hint` of "Back off and serialize calls per subscription; tighten the analysis scope if persistent" — and then **moved on without retry**. The two failed subs contributed *zero* facts to the report. The reasoner correctly hedged its recommendations ("limited to one subscription with available data", `dq-1` weakens both `rec-1` and `rec-2`), but the operator lost two-thirds of the intended scope.

The reference cron, against 8 subs every Friday for 12 weeks, hit 429s on roughly half of runs. Every single one was recovered with 60–180s backoff and a serialized retry. The cron's changelog footer makes the recovery first-class: "1 throttle on Jenkins (120s backoff cleared)" in Run 12, "Multiple 429 throttles … required ~7 minutes of cumulative backoff" in Run 6, "All 8 queries succeeded with 0 throttles" in Run 10. The cron never lost a subscription to 429 across 12 runs.

### Why the existing design discusses this but doesn't fix it

- [`docs/prd/amg-mcp-integration.md`](../prd/amg-mcp-integration.md) lines 17, 85, 88 require the integration to handle rate limits, classify them in user-meaningful terms, and "plan query patterns that respect these limits, such as serializing across subscriptions where the budget is uncertain". Lines 71 / 85 set the bar at "degrade into clear output rather than incorrect recommendations" — which the current code does, narrowly.
- [`docs/design/phase-1.md`](phase-1.md) line 519 in the failure-taxonomy table prescribes "Backoff with jitter, capped retries; serialize across subs" as the runtime behaviour for `rate_limit`. **No code implements this.** `src/failure/taxonomy.ts:135` only classifies; the orchestrator does not retry.
- [`docs/design/cost-summary-depth.md`](cost-summary-depth.md) §Gap 6 observation calls out "1 throttle on Jenkins (120s backoff cleared)" as a Run Quality footer, but treats it as a *reporting* concern, not a *behavioural* one. The design assumes the retry happens somewhere; that somewhere does not yet exist.

So the design corpus is consistent that retry-with-backoff is required, but no design document owns the *how*. That is the gap.

### Design (proposed, not yet locked)

A new section §7 in [cost-summary-depth.md](cost-summary-depth.md) — *or* a small standalone `docs/design/transport-resilience.md` — should answer four questions:

1. **Where does retry live?** Three plausible layers:
   - **(a) Inside `MCPTransport`.** Every capability call gets transparent retry. Pros: one place; consistent. Cons: opaque to the reasoner; hides which queries took longer; complicates the §14 trace vocabulary.
   - **(b) Inside the orchestrator's evidence executor.** Retries happen between the planner and the reasoner, with each retry attempt visible as a sibling Langfuse span. Pros: visible in traces; easy to attach `transport.retry_count` and `transport.cumulative_backoff_ms` attributes; respects the §14 trace vocabulary.
   - **(c) Inside the playbook itself.** Each playbook decides its own retry policy. Pros: per-capability tunability. Cons: duplication; the same retry logic gets rewritten across analyzers.

   **Recommend (b).** It is the level that already owns per-evidence-record lifecycle, and it is the level the Phase 2 score taxonomy ([phase-2.md](phase-2.md) §Score taxonomy) is shaped against. The Langfuse trace will be legible: one parent span per evidence request, child spans per retry attempt, terminal status reflects the final outcome.

2. **What is the retry policy?**

   - **Triggering categories.** `rate_limit` (429), `timeout` (408/504/network), and `transport` errors with retriable HTTP status (502, 503). Not: `auth` (401), `authz_gap` (403), `invalid_scope` (400/422), `unsupported_capability` (404). These categorical rules are already in `src/failure/taxonomy.ts`; the retry layer reads the classification, not the raw status.
   - **Backoff schedule.** Exponential with jitter: `min(base * 2^attempt + jitter, cap)` where `base = 30s`, `cap = 180s`, `jitter ∈ [0, 30s)`. The reference cron's empirical recovery times (60–180s) inform these numbers, not derive them.
   - **Cap.** 3 retries per capability call (so 4 attempts total). The reference cron's "~7 minutes cumulative backoff in Run 6" gives a hint that 3 retries × ≤180s = ≤9 min worst case is operationally acceptable.
   - **Per-subscription serialization on rate-limit.** When any 429 is observed, *subsequent* cost-analysis calls for the rest of the run serialize across subscriptions (collapse parallel fanout to a single in-flight call) with a small inter-call gap (default 30s). This matches [`amg-mcp-capabilities.md`](../amg-mcp-capabilities.md) line 24's "expect to serialize cost queries across subscriptions when the budget is uncertain". The flag clears at run end; it is not persistent state.
   - **Final-failure behaviour.** When retries are exhausted, the existing path applies: `DataQualityFinding` of category `rate_limit`, recommendation framing is hedged, report renders the affected scope as "evidence unavailable". This is the only behaviour the current pipeline supports today; the change is that it becomes rare instead of routine.

3. **What do operators see?**

   - **Run Quality section** (Gap 6 surface, already shipped) gains a sub-line per capability that retried: `amgmcp_cost_analysis: 2/3 subscriptions required retry (1× 120s backoff, 1× 180s backoff; both succeeded)`. The reference cron's footer is one line; pixiu's structured version is fine to be two or three.
   - **Langfuse trace** gains attributes: `transport.retry_count`, `transport.cumulative_backoff_ms`, `transport.final_outcome`. These join the §14 vocabulary alongside the new attributes Gap 3 / Gap 5 already introduce.
   - **`run.json`** gains a `transport_summary` block at the top level, parallel to `data_quality_findings`, so cross-run continuity (Gap 5) can detect "this capability has hit 429 for N consecutive runs" — itself a useful escalation signal.

4. **What is the failure mode of the retry layer?**

   - **Retry storm safety.** Serializing on rate-limit naturally limits in-flight calls; the cap of 3 retries × 4 attempts × 180s worst-case ensures a bounded run time even when AMG-MCP is fully throttled. No exponential blow-up.
   - **Idempotency.** All retried capabilities are read-only (the read-only allowlist guarantees this). Retrying is safe by construction.
   - **Test surface.** A fixture transport (`MockTransport`) that injects 429 on the first two calls and success on the third should produce a successful run with a `transport_summary` showing 2 retries and a Run Quality line. This is a Phase 2.5 / Phase 3 eval addition, not Phase 1's existing rubrics.

### Trade-off named, not resolved

**Should the retry layer be aware of the Cost Management API's QPU (query units) budget?** [`amg-mcp-capabilities.md`](../amg-mcp-capabilities.md) line 24 mentions QPU as the root cause of the fan-out 429s. A QPU-aware client would slow down *before* receiving a 429, not after. AMG-MCP does not currently expose remaining QPU in its responses, so this is upstream work; for now, reactive backoff is the right shape. If AMG-MCP later exposes a remaining-budget header, the retry layer can become proactive without changing its interface.

### Roadmap slot

**Phase 2.5+ or early Phase 3.** This unblocks Gap 1 (waste detection) at the operationally honest level — running waste lanes across 8 subs sequentially is materially throttle-prone, and the lanes are useless if they fail half the time. It should land *before* the waste-lane work in [§Implementation sequencing](cost-summary-depth.md#implementation-sequencing) step 6.

---

## Smaller items, candidates for early landing

These are not architectural; they are cheap report-tightening wins that would visibly improve every run today. Each is small enough to be one PR.

### §S1 — Deduplicate freshness findings

**Observation.** The live run emitted `dq-freshness-1`, `dq-freshness-2`, `dq-freshness-3` with byte-identical body text. The freshness check ([`src/run/freshness.ts`](../../src/run/freshness.ts), commit `b851ff9`) runs per cost-analysis evidence record; with three subs it fires three times.

**Fix.** The freshness check should emit at most one `freshness_partial_window` finding per `(category, time_window.end_utc)` tuple per run. The reasoner needs to know the condition exists, not that it exists three times. The dedupe lives where the findings are aggregated (orchestrator), not where they are emitted (the check).

**Effort.** Single-file change in the aggregator. Eval covers it via the existing `cost-summary-freshness-001` fixture once that lands.

### §S2 — Executive summary should mention dropped subscriptions

**Observation.** The live run's Executive Summary names the *top-priority recommendation* (PostgreSQL/Cosmos review) but does not mention that **two of three subscriptions returned no data**. An operator scanning the report header could miss that the scope was effectively 1 sub, not 3. The `dq-1` finding records it, but the summary's framing reads as if the analysis was complete.

**Fix.** The reasoner prompt ([`prompts/reasoner.v1.md`](../../prompts/reasoner.v1.md), and the upcoming `reasoner.v2.md`) needs an explicit rule: when scope coverage is below 100% due to data-quality findings of category `rate_limit`, `auth`, `authz_gap`, `timeout`, or `unsupported_capability`, the executive summary must surface the coverage gap in its first or second sentence. Example phrasing: *"Coverage: 1 of 3 subscriptions returned data (2 rate-limited; see Run Quality)."*

**Effort.** Prompt rule + one new rubric (`rubric.coverage_disclosure_grounded`). The §Gap 7 retry work will reduce how often this rule fires, but the rule should ship now because retry is not free in 100% of cases.

### §S3 — Run Quality section should always emit a baseline line, even when nothing went wrong

**Observation.** The reference cron's "All 8 cost-analysis queries succeeded with 0 throttles this run" line is genuinely useful — it tells the operator "nothing was hidden". The current `src/report/markdown.ts` Run Quality section only emits when there *are* findings.

**Fix.** Run Quality should always render. When there are no transport / freshness findings, the section emits one line: `0 transport errors, 0 freshness findings across N capabilities; full scope coverage.` This matches the Gap 6 verification criterion already in [cost-summary-depth.md](cost-summary-depth.md): *"The Run Quality section appears at the top of every report, even when nothing of note happened ('0 throttles, all capabilities returned evidence')."* The verification text exists; the implementation does not honour it.

**Effort.** Single-file change in `src/report/markdown.ts`. The phase-1 rubrics already cover "report renders all required sections"; this just expands the always-on set.

### §S4 — Throttle observations should land in `run.json` before they land in the report

**Observation.** Today, the only place a 429 / retry attempt is *recorded* is the in-memory `DataQualityFinding`. There is no persistent transport-level summary in `run.json`. Without that, cross-run continuity (Gap 5) cannot reason about "this capability has been throttled for N consecutive runs".

**Fix.** Add a `transport_summary` block to `run.json` (and to the `RunSummary` schema that `RunHistoryStore` indexes). One entry per (capability, attempt outcome) tuple. This is purely additive; existing readers ignore unknown fields. Pairs naturally with §Gap 7's retry work but can land independently — even without retry, recording the failure attempt is useful.

**Effort.** Schema addition + one writer change. Cross-run continuity readers (Phase 3 step 10's `reasoner.v2`) get this for free.

---

## What this note deliberately does **not** propose

- **Do not redesign the six existing gaps.** The [cost-summary-depth.md](cost-summary-depth.md) document is sound; the comparison confirms it rather than re-opens it. The work that remains is execution against §Implementation sequencing steps 6–12.
- **Do not introduce a `cost-summary-deep` analyzer.** The reference cron is a single playbook with deeper evidence and continuity, not a different analyzer. The Phase 3 plan keeps `cost-summary` as one playbook; this note keeps that commitment.
- **Do not propose a hosted scheduler or notification surface.** The reference cron schedules itself via OpenClaw and posts WhatsApp summaries; pixiu's scheduling is the operator's concern. The roadmap's "What is not on the roadmap" — owner notification, real-time alerting, hosted multi-tenant — still holds.
- **Do not propose QPU-aware proactive throttling.** §Gap 7 is reactive backoff. Proactive QPU awareness is upstream AMG-MCP work, not pixiu's.
- **Do not commit to a specific Langfuse trace-export fix.** The 401 observed in the live run is environment / credentials plumbing, not a design concern; it should be triaged separately.

---

## Critical references

- [Roadmap](../roadmap.md) — Phase 2.5 / Phase 3 slots that this note's items target.
- [cost-summary-depth.md](cost-summary-depth.md) — the six gaps this comparison confirms; §Gap 7 should be added there or kept as a sibling design doc.
- [AMG-MCP integration PRD](../prd/amg-mcp-integration.md) — already mandates the rate-limit and back-pressure behaviour §Gap 7 implements.
- [Reporting and recommendations PRD](../prd/reporting-and-recommendations.md) — FR-18 already requires the Run Quality surface §S3 expands and §Gap 7 enriches.
- [Phase 1 design](phase-1.md) §14 — trace vocabulary the new `transport.*` attributes will join.
- [Phase 2 design](phase-2.md) §Score taxonomy — the new rubric §S2 proposes (`rubric.coverage_disclosure_grounded`) plugs in here.
- [`claw-context/cron-azure-cost-analysis/report.md`](https://github.com/1w2w3y/claw-context/blob/main/cron-azure-cost-analysis/report.md) — the reference cron whose Run 12 grounds every observation in this note.
- [`runs/e8d73b9e-5a7b-4e8a-ad95-4d8d0b436a48/report.md`](../../runs/e8d73b9e-5a7b-4e8a-ad95-4d8d0b436a48/report.md) — the live pixiu run grounding the §Gap 7 / §S1–S4 observations.
