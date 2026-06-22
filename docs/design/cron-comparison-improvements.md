# Reference-Cron Comparison: Improvement Backlog

> **Status (updated 2026-06):** Improvement note, with several items now implemented. Written after a side-by-side comparison of one live `pixiu analyze cost-summary` run (run-id `e8d73b9e`, three GrafanaDevRP-family subscriptions, 2026-05-16 → 2026-05-23) against the reference Claude-Code cron at `claw-context/cron-azure-cost-analysis/report.md` (Run 12, 8 subscriptions, week ending 2026-05-12).
>
> The reference cron is currently producing materially better operator value per run than az-pixiu. This document characterizes *why*, ties each finding to either an existing roadmap slot or a previously-unnamed gap, and calls out one operational blocker — 429 handling — that is design-discussed but not implemented.

## TL;DR

- **The Phase 2.5 / Phase 3 plan in [cost-summary-depth.md](cost-summary-depth.md) is the right plan.** Every major gap surfaced by the comparison maps cleanly onto Gaps 1–6 of that document. No re-design needed for them; the work just hasn't shipped yet.
- **The critical 429 / rate-limit retry gap is now mostly closed in code.** `EvidenceExecutor` retries retriable wire-level failures with capped backoff and pacing, detects payload-embedded `amgmcp_cost_analysis` 429/auth/authz failures, records `transport_summary`, and feeds Run Quality / coverage disclosure. Proactive QPU-aware throttling remains upstream-dependent and intentionally out of scope.
- **The smaller report-tightening observations have mostly landed.** Freshness findings are deduplicated, Executive Summary coverage disclosure is deterministic, Run Quality always emits a baseline line, and `run.json` carries transport summaries.

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
| Gap 1 — waste detection lane | None — only "top services by spend" | 182 orphan IPs / 7 restored-PG / 2 stopped AKS / 8 disks / 1 deallocated VM, each enumerated by ID | Designed, Phase 3, first lane shipped (`orphan_public_ip`) |
| Gap 2 — naming-pattern clustering | None | `ipv6-pe-pool-test-vhx-*` cluster of 24 IPs called out as one cause, not 24 leaks | Designed, Phase 3, not started |
| Gap 3 — calibrated weekly impact | None — qualitative "material" tag only | "~$87/week for 182 orphan IPs", "~$700/week for 7 restored-PG" | Designed, Phase 3, **rate card and lane-level range estimates shipped for orphan public IPs** |
| Gap 4 — freshness reasoning | **3 findings emitted** (one per sub, repeated body) — partial credit | "Likely data-freshness artifact" narrative in Run 8/9 when uniform drop fired | Designed, Phase 3, **partial-window check and dedupe shipped**. Uniform-drop heuristic still pending. |
| Gap 5 — cross-run continuity | "found 1 prior run(s) … injecting prior_run_context" — orchestrator path works; reasoner did not surface continuity in the report body | "UNCHANGED week 10", "first movement in 10 weeks", "RECURRING from Run 8" | **Phase 2.5 foundation shipped** (commits `69479e8`, `fdc18a6`); `reasoner.v2` prompt rules to *consume* it pending (Phase 3 step 10) |
| Gap 6 — Run Quality section | Section emitted but body content is just the three repeated freshness findings | "1 throttle on Jenkins (120s backoff cleared)", "0 throttles, all 8 queries succeeded" | Designed, **section shipped and enriched** in `src/report/markdown.ts`; transport/throttle observations now flow through `transport_summary` |

The Phase 2.5 work has landed. Phase 3 is partly seeded (rate card, freshness check). The user-visible delta will appear when steps 6–11 in [cost-summary-depth.md §Implementation sequencing](cost-summary-depth.md#implementation-sequencing) land in series.

---

## §Gap 7 — 429 / rate-limit handling: mostly implemented

> **Current status (2026-06):** The retry substrate described below has shipped in `src/evidence/executor.ts` and `src/evidence/retry-policy.ts`: retriable `rate_limit` and `timeout` failures retry with capped exponential backoff and jitter, per-capability pacing is applied after an observed rate limit, and per-request `transport_summary` rows feed Run Quality and run-history rollups. Payload-embedded Cost Management 429s are also handled via `src/evidence/payload-failure.ts`; see [embedded-rate-limit.md](embedded-rate-limit.md). The design text below is retained as the rationale and for remaining gaps such as proactive QPU awareness.

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

**Phase 2.5+ or early Phase 3.** This has landed before the broader waste-lane group, which is the right order: running waste lanes across many subscriptions is materially throttle-prone, and the lanes are not operationally honest without retry/backoff and truthful coverage reporting.

### Amendment (2026-05-23): payload-embedded rate limits

Live AMG-MCP testing surfaced a second detection surface that this §Gap 7 design did not anticipate. The `amgmcp_cost_analysis` tool wraps upstream Cost Management 429s into a schema-valid 200-OK payload (`subscriptions[*].error: "Cost Management API rate limit (429) hit …"`) rather than surfacing them as MCP transport errors. The retry substrate described above is correct; its **trigger surface is one detection layer too narrow** — `client.invoke()` never throws, so `classifyFailure()` never runs, and the retry loop is bypassed entirely. `transport_summary` rows record `final_outcome=success` for runs that produced zero usable cost data.

The payload-embedded case shares the retry substrate (backoff, jitter, pacing, budget, transport rollup) and is now handled by a detection layer that runs between `client.invoke()` success and `raw_evidence.push()`. The full rationale lives in [embedded-rate-limit.md](embedded-rate-limit.md). With that work landed, §Gap 7's retry substrate handles **both** wire-level and payload-embedded rate limits through the same mechanism.

---

## Smaller items, candidates for early landing

These are not architectural; they are cheap report-tightening wins that would visibly improve every run today. Each is small enough to be one PR.

### §S1 — Deduplicate freshness findings

**Status:** Shipped. `src/run/freshness.ts` groups findings by `(category, source_capability, time_window.end)` and merges affected scope subsets.

**Observation.** The live run emitted `dq-freshness-1`, `dq-freshness-2`, `dq-freshness-3` with byte-identical body text. The freshness check ([`src/run/freshness.ts`](../../src/run/freshness.ts), commit `b851ff9`) runs per cost-analysis evidence record; with three subs it fires three times.

**Fix.** The freshness check emits at most one `freshness_partial_window` finding per `(category, source_capability, time_window.end_utc)` tuple per run. The reasoner needs to know the condition exists, not that it exists three times.

**Effort.** Single-file change in the aggregator. Eval covers it via the existing `cost-summary-freshness-001` fixture once that lands.

### §S2 — Executive summary should mention dropped subscriptions

**Status:** Shipped as renderer-owned deterministic coverage disclosure. `src/report/coverage.ts` computes cost-scope coverage from evidence plus `transport_summary`, and `src/report/shared.ts` renders the Executive Summary coverage line. A dedicated rubric is still optional future work.

**Observation.** The live run's Executive Summary names the *top-priority recommendation* (PostgreSQL/Cosmos review) but does not mention that **two of three subscriptions returned no data**. An operator scanning the report header could miss that the scope was effectively 1 sub, not 3. The `dq-1` finding records it, but the summary's framing reads as if the analysis was complete.

**Fix.** The coverage disclosure is deterministic report rendering, not model output: when scope coverage is below 100% due to retrieval-stage findings of category `rate_limit`, `auth`, `authz_gap`, `timeout`, or `unsupported_capability`, the Executive Summary surfaces the coverage gap before the model-authored recommendation summary. Example phrasing: *"Coverage: 1 of 3 subscriptions returned cost evidence; 2 had retrieval failures (rate_limit)."*

**Effort.** Implemented in renderer helpers and report tests. A future `rubric.coverage_disclosure_grounded` may still be useful, but the core product behavior no longer depends on prompt obedience.

### §S3 — Run Quality section should always emit a baseline line, even when nothing went wrong

**Status:** Shipped. `src/report/markdown.ts` always renders Run Quality and includes the quantified baseline line.

**Observation.** The reference cron's "All 8 cost-analysis queries succeeded with 0 throttles this run" line is genuinely useful — it tells the operator "nothing was hidden". The current `src/report/markdown.ts` Run Quality section only emits when there *are* findings.

**Fix.** Run Quality always renders. When there are no transport / freshness findings, the section emits one line such as `0 transport error(s), 0 retry attempt(s), 0 freshness finding(s) across N evidence request(s); full cost-scope coverage.`

**Effort.** Implemented in `src/report/markdown.ts` and covered by report tests.

### §S4 — Throttle observations should land in `run.json` before they land in the report

**Status:** Shipped. `TransportSummaryEntry` lives in `src/schemas/transport.ts`, `EvidenceExecutor` fills it, `run.json` writes it, and `RunHistoryStore` indexes its rollup.

**Observation.** Today, the only place a 429 / retry attempt is *recorded* is the in-memory `DataQualityFinding`. There is no persistent transport-level summary in `run.json`. Without that, cross-run continuity (Gap 5) cannot reason about "this capability has been throttled for N consecutive runs".

**Fix.** Add a `transport_summary` block to `run.json` and to the `RunSummary` rollup that `RunHistoryStore` indexes. One entry is recorded per logical evidence request, with attempt count, retry count, final outcome, observed failure categories, backoff total, and scope subset where available. This is purely additive; existing readers ignore unknown fields.

**Effort.** Implemented across schema, executor, report artifact writer, markdown renderer, and history store.

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
