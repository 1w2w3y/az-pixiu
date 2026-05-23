# Cost-Summary Depth

> **Status (2026-05):** Proposal. This design captures the gap between Az-Pixiu's current `cost-summary` analyzer (single-window, descriptive snapshot, no waste classification) and what a recurring real-world cost-review workflow produces. It is the planning document for a cluster of work that lands in two roadmap slots: foundational cross-run state in [Phase 2.5](../roadmap.md#phase-25--cross-run-continuity-foundations), and feature breadth in [Phase 3](../roadmap.md#phase-3--optimization-breadth). The work is admissible against the [hard constraints](../../CLAUDE.md#hard-constraints-architecturally-load-bearing) without modification — read-only, AMG-MCP-bounded, evidence-cited.

## Context

The Phase 1 `cost-summary` playbook ([`src/playbooks/cost-summary.ts`](../../src/playbooks/cost-summary.ts)) is deliberately narrow: six deterministic AMG-MCP capability calls per scope (subscription list, per-subscription cost analysis, top resource types overall, top type × location cross-cut, tag-coverage roll-up, per-subscription activity log), no baseline comparison, no result-driven follow-ups. The reasoner describes top services, regional distribution, cost concentration, tagging gaps, and period-defining lifecycle events. The output is one Markdown report plus one `run.json` per invocation, with no awareness of any prior run.

A reference workflow — an external Claude-Code cron that has been producing weekly Azure cost reports for ~12 runs against 8 subscriptions (the report this design is grounded in lives at `claw-context/cron-azure-cost-analysis/report.md`) — demonstrates that real recurring cost-review output looks different from what the current Az-Pixiu `cost-summary` produces in six distinct ways. This document characterizes those differences, justifies which of them should become Az-Pixiu features, and locks the design choices that close each gap without weakening the project's evidence and observability discipline.

This is not a critique of the existing playbook. Phase 1's narrowness was a deliberate validation choice ([phase-1 design](phase-1.md) §"What Phase 1 deliberately leaves to later") and the resulting agent is sound. The work here extends the analyzer surface; it does not rewrite it.

---

## Hard constraints recap

The same constraints that shaped Phase 1 and Phase 2 still apply:

- **Read-only against Azure.** Waste detection enumerates candidate resources and frames remediation as human-reviewed options. The agent never deletes, scales, or modifies.
- **AMG-MCP is the Azure boundary.** Every new signal (zombie classification, naming-pattern clustering, freshness heuristic) must be derivable from `amgmcp_query_resource_graph`, `amgmcp_cost_analysis`, `amgmcp_query_activity_log`, and the other capabilities AMG-MCP already exposes. If a useful signal genuinely requires a capability AMG-MCP does not provide, the response is patience or an upstream contribution, not a direct Azure SDK call.
- **Evidence over assertion.** Every waste candidate, every estimated weekly impact, every "unchanged for N weeks" marker must cite the evidence (and, for cross-run markers, the prior run) that justifies it.
- **Calibrated uncertainty.** Estimated weekly waste is a *calibrated estimate* with a stated rate source and assumption. It is never presented as a known cost figure.
- **Local-first.** Cross-run state (§"Cross-run continuity foundations") lives in the operator's local environment. Langfuse Datasets are a deliberate option for the substrate, but offline operation must continue to work end-to-end.
- **Reversible decisions.** The state substrate, the pricing-rate source, and the naming-pattern heuristics are all wrapped behind interfaces so that any of them can be swapped without rewriting the analyzer.

---

## The six gaps

Each gap names the observation, the rough size of the work, and the slot in the roadmap where it lands.

### Gap 1 — Zombie / waste detection as a separate analysis lane

**Observation.** The reference report enumerates specific zombie categories — orphaned public IPs, "restored-*" PostgreSQL servers, stopped or failed AKS clusters, unattached disks, deallocated VMs, unused container registries — naming individual resources, counting them per subscription, and presenting them as a cleanup backlog. The current `cost-summary` playbook only fetches "top 15 resource types overall" and has no concept of "this resource looks like waste."

**Design.** Introduce a `waste-detection` evidence lane within the `cost-summary` playbook. Each lane is one ARG query targeting a specific waste pattern, returning resource IDs plus the few fields needed to defend the classification (SKU, region, provisioning state, age, ipConfiguration, etc.). The reasoner receives the lane outputs as `EvidenceRecord`s with a new `intent: 'waste_candidate'` so it can group them in the report under a dedicated "Waste Candidates" section.

Initial lanes, each anchored to an unambiguous ARG predicate:

| Lane | Predicate | Cited evidence |
|---|---|---|
| orphaned public IPs | `microsoft.network/publicipaddresses` with empty `ipConfiguration` | ID, SKU, location, allocation method |
| unattached managed disks | `microsoft.compute/disks` with `diskState == 'Unattached'` | ID, size GB, SKU, location, age |
| deallocated VMs | `microsoft.compute/virtualmachines` with power state `deallocated` for ≥7d | ID, SKU, location, deallocation timestamp |
| stopped or failed AKS | `microsoft.containerservice/managedclusters` with provisioning state `Stopped` or `Failed` | ID, region, agent pool count, last operation |
| "restored-*" Postgres | `microsoft.dbforpostgresql/flexibleservers` with name starting `restored-` | ID, SKU, region, create timestamp |
| empty container registries | `microsoft.containerregistry/registries` with no repositories in last 90d | ID, SKU, region, last push timestamp |

The lane list is **extensible by configuration**, not hardcoded. Each lane is a small object with a name, an ARG query, and a renderer for the per-candidate evidence record. New lanes admit when the use case is documented and the predicate is unambiguous.

**Trade-off named, not resolved: how aggressive is the "restored-*" heuristic?** The reference report treats name-prefix-only matching as sufficient. That's pragmatic but fragile — a legitimately named production server starting with `restored-` would be a false positive. The lane carries this as an explicit `false_positive_considerations` field on every candidate, which feeds the reasoner's `false_positive_considerations` field on the recommendation (reporting PRD FR-13).

**Roadmap slot.** Phase 3.

### Gap 2 — Naming-pattern detection inside a single run

**Observation.** The reference report flags clusters of similarly-named orphans — `ipv6-pe-pool-test-vhx-{inbound,inbound-pe,outbound}-st-ip-pool-rg`, `ip-pool-test-voq-{inbound,outbound}-st-ip-pool-rg` — and treats the cluster as one likely cause ("a test rig spawned this") rather than 24 independent leaks. It also attributes ownership by name prefix (`xichen-*` → `xichen`).

**Design.** Add a single pure-function step in the waste-detection lane that, given a set of candidate resource names, groups them by structural similarity. The grouping is deterministic and cheap — tokenize on `-`, find common prefixes of length ≥2 tokens that cover ≥3 resources, emit a cluster record with member IDs and the shared prefix. No LLM call.

The cluster records flow to the reasoner as `EvidenceRecord`s with `intent: 'waste_cluster'`. The reasoner is prompted (via a small addition to `reasoner.v1.md`) to prefer recommending "investigate the source of cluster X" over "delete the 24 individual resources" when a cluster covers most of a lane's candidates.

Ownership inference from prefixes is a separate pass that produces `intent: 'ownership_hint'` records. The reasoner uses these as *hypotheses* (low confidence) rather than facts. The prompt explicitly forbids citing a username as the resource owner in the recommendation body without a corroborating tag.

**Trade-off rejected: LLM-driven clustering.** Cheaper to delegate to the reasoner directly, but it produces unstable clusters across runs and makes the cross-run continuity work harder (§"Cross-run continuity foundations"). A deterministic clusterer produces stable cluster IDs that survive across runs, which is what makes "this cluster recurred from run N" possible.

**Roadmap slot.** Phase 3.

### Gap 3 — Estimated weekly waste impact, calibrated

**Observation.** The reference report attaches dollar figures to each waste category ("~$87/week for 182 orphan IPs", "~$700/week for 7 restored PG servers"). The current reasoner can only emit qualitative `impact: 'material' | 'moderate' | 'minor'` tags.

**Design.** Introduce a `PricingRateSource` interface with a single default implementation that loads from a versioned in-repo JSON file (`pricing/azure-rate-card.json`) covering only the SKUs that the waste lanes can produce. Each entry is `{sku, region, list_price_weekly_usd, source_url, captured_at}` so the source of every estimate is traceable in evidence.

For each waste candidate the lane attaches an estimated weekly impact computed from `count × matched_rate`. The reasoner sees the per-candidate estimate and rolls it up per lane and per cluster. The report renders impact as a *range* (e.g., "~$83–$91/week, list-price estimate") not a point figure, with a footnote citing the rate source and the calculation.

Three guardrails keep this honest:

1. **Estimates are list-price only.** The rate card does not attempt to model reservations, savings plans, negotiated discounts, or hybrid-benefit credits. The footnote says so. The reporting PRD non-goal "Estimated savings may be misleading if based on incomplete pricing, reservations, discounts, or business context" is honored by making this limitation explicit on every estimate.
2. **An unknown SKU produces "estimate unavailable", not zero.** Silent omission would distort lane totals. A waste candidate without a matching rate is rendered as `(rate unavailable for SKU X)` and excluded from the lane total.
3. **The rate card is small and updateable.** Phase 3 ships ~20 SKUs covering the waste lanes listed in Gap 1. Expansion happens when new lanes need it, not speculatively. The capture date and source URL on each entry make staleness visible.

**Trade-off rejected: query Azure Retail Prices API at runtime.** Tempting (always-fresh rates), but it adds a non-AMG-MCP Azure dependency, makes offline operation harder, and turns rate lookup into a network call per candidate. A versioned in-repo card is sufficient for the calibrated-estimate framing this design commits to.

**Trade-off named, not resolved: should the rate card live in Langfuse Prompts as a structured asset?** Possibly — it would give the Phase 2 prompt-management surface a stress test against non-prompt content. Phase 3 ships the in-repo version; the Langfuse-asset option is revisited if Phase 2's prompt surface generalizes.

**Roadmap slot.** Phase 3.

### Gap 4 — Data-freshness reasoning

**Observation.** The reference report's Run 8 and Run 9 changelog entries call out "Likely data-freshness artifact" when every subscription's spend drops uniformly by 30–55%. The pattern is recognizable: cost-analysis windows ending on or near "today" haven't fully posted, so the totals look artifactually low. The current reasoner has no concept of "this looks artifactual."

**Design.** Add a pre-reasoning freshness check in the orchestrator that operates on the cost-analysis evidence records. It flags two conditions:

1. **Period-end is within the cost-API's known posting lag window.** AMG-MCP's `amgmcp_cost_analysis` response includes the analysis window. If `time_window.end_utc > now() - lag_threshold` (Phase 3 default: 48h), emit a `DataQualityFinding` of category `freshness_partial_window`.
2. **Cross-subscription uniform drop.** If the analysis includes a baseline comparison (cost-surprise) or a comparable prior run (§"Cross-run continuity foundations"), and every subscription in scope shows a drop of >25% with a tight standard deviation, emit `DataQualityFinding` of category `freshness_suspected_lag`. The threshold is conservative — real workload drops are rarely that uniform across heterogeneous subscriptions.

The reasoner is prompted to caveat hypotheses and recommendations that depend on the affected totals when these findings are present, and to suppress the "every sub is down WoW" narrative when the cross-sub uniform-drop signal fires.

**Trade-off named, not resolved: the lag-threshold default.** 48h is a starting heuristic, not a derived constant. The right answer probably depends on the operator's subscription mix and the cost-API's actual lag behavior in their region, neither of which Az-Pixiu can observe directly. Phase 3 ships 48h as a configurable default and notes the open question for later calibration against real recurring runs.

**Roadmap slot.** Phase 3.

### Gap 5 — Cross-run continuity (UNCHANGED week N, recurring-pattern recall)

**Observation.** The reference report's most distinctive feature is its memory: "7 `restored-*` PostgreSQL servers UNCHANGED week 10", "DevRP orphan IPs 103 → 115 (+12) — first movement in 10 weeks", "Same naming pattern as the `ipv6-pool-test-vgc-*` leak from Run 8". These markers turn a backlog into a workflow — items that haven't moved for N weeks become escalation flags, recurring patterns get root-cause attention rather than another cleanup. The current Az-Pixiu cost-summary report from `runs/00fc06.../report.md` is amnesiac; it does not know that a prior run produced the same conclusion.

This is the architecturally interesting gap. [`docs/prd/core-agent.md`](../prd/core-agent.md) lines 120–121 already lists this as an open question: "How should repeated recommendations be de-duplicated across runs or review periods?" and "What level of local state is needed to support comparison over time without creating a hidden data store requirement?" This design proposes a concrete answer.

**Design.** Introduce a `RunHistoryStore` interface and a default local-filesystem implementation that indexes prior `run.json` artefacts under `runs/`. The store exposes one operation:

```
findPriorRuns(scope_signature, analysis_type, lookback) → RunSummary[]
```

A `scope_signature` is a deterministic hash of `(sorted_subscription_ids, sorted_resource_groups, analysis_type)` — *not* the time window, since the whole point is to compare across windows.

For a given run, the orchestrator queries the store for matching prior runs in the lookback (default 12 weeks). For each prior run, it extracts:

- The set of waste candidate IDs by lane (e.g., the orphan-IP IDs present in run N-1).
- The set of cluster prefixes by lane (e.g., `ipv6-pool-test-vgc-*` from run N-2).
- The recommendation set, identified by a stable `recommendation_signature` (lane + cluster prefix + dominant SKU, *not* the recommendation text, which the LLM rewrites).

This becomes a new `EvidenceRecord` with `intent: 'prior_run_context'` flowing to the reasoner. The reasoner is prompted to:

- Mark a waste candidate as "UNCHANGED week N" when its ID has appeared in N consecutive prior runs.
- Flag a cluster as "RECURRING" when its prefix matches a prior run's cluster prefix that was previously resolved (i.e., absent in the run after it was first flagged).
- Mark a recommendation as "first appearance" or "carrying forward week N" using the stable signature.

The cross-run markers are surfaced as report content (§"Cross-run continuity markers" in [reporting PRD](../prd/reporting-and-recommendations.md) FR-16) and as Langfuse trace attributes (`recommendation.continuity_weeks`, `waste_lane.unchanged_count`) so the maintainer journey "monitor agent quality over time" gets a continuity dimension.

**Stable recommendation identity.** The reasoner output schema gains a `recommendation_signature` field. The reasoner computes it deterministically from the lane + cluster prefix + dominant SKU; the LLM is prompted not to use it as the recommendation title, only as an attribute. This is what makes "same recommendation surfaced again in run N" tractable across LLM-rewritten output.

**Substrate options, named not chosen.**

| Substrate | Pros | Cons |
|---|---|---|
| **Local filesystem index over `runs/`** (default) | No new dependency; runs are already persisted; trivially diffable | Slow when `runs/` accumulates; indexing on every run is wasteful |
| **Local SQLite at `state/run-history.sqlite`** | Fast lookups; queryable; survives operator-local | New dependency; backup/restore semantics; needs migrations |
| **Langfuse Datasets as the substrate** | Single source of truth; aligns with [Phase 2 design](phase-2.md) §"Dataset migration"; remote backup for free | Requires Langfuse for cross-run continuity; offline operation must still work via local fallback |

Phase 2.5 ships **option 1** (filesystem index over `runs/`) because it is the only one compatible with offline-first operation as a default. It exposes the `RunHistoryStore` interface so option 2 or 3 can be swapped in later without changing the analyzer or the reasoner.

**Trade-off accepted: cross-run continuity is a Phase 2.5 prerequisite for Phase 3, not a Phase 3 sub-item.** Several Phase 3 features (UNCHANGED markers, recurring-pattern detection, "no action taken since week N" recommendations) read from `RunHistoryStore`. Building those features first and bolting on state later would produce a worse interface, because the state-write call sites are inside the analyzer and reasoner. The cleaner sequence is: ship `RunHistoryStore` and `recommendation_signature` first as a foundational Phase 2.5 increment, then build the Phase 3 waste-detection features against that interface.

**Trade-off named, not resolved: scope-drift handling.** When the operator runs the same `analysis_type` with a slightly different subscription list (e.g., a sub was lost to RBAC denial), the `scope_signature` does not match a prior run's. Three options: (a) require an exact match (conservative — no false continuity claims, but loses signal when scopes drift slightly), (b) match on a *subset* relationship (more useful but introduces ambiguity), (c) make the operator opt in with `--prior-run <run-id>` (explicit but burdensome). Phase 2.5 ships (a) plus a documented `--prior-run` override for (c); option (b) is a Phase 3+ research item once real recurring use surfaces the patterns.

**Roadmap slot.** Foundational layer in [Phase 2.5](../roadmap.md#phase-25--cross-run-continuity-foundations); first user-visible features in Phase 3.

### Gap 6 — Run-quality observations surfaced in the report

**Observation.** The reference report ends most weekly entries with a one-line operational footer: "1 throttle on Jenkins (120s backoff cleared)", "All 8 cost-analysis queries succeeded with 0 throttles this run". This treats run quality as a first-class observation, not a backstage diagnostic.

**Design.** Promote a small subset of `DataQualityFinding`s to a new "Run Quality" report section (rendered by the markdown report writer between "Scope & Data Sources" and "Executive Summary"). The promotion criterion: findings whose `affected_capability` is `network` or `transport`, plus any `freshness_*` finding emitted by Gap 4. Other findings (tag coverage gaps, partial cost coverage from missing aggregations) continue to render in the existing "Data Quality" section.

The Langfuse trace already emits enough information to produce these — Phase 1's §14 vocabulary covers `mutating_capabilities_excluded`, transport-level retries, and HTTP status codes. Gap 6 is mostly a report-writer change with a tiny normalizer addition. No new evidence lanes.

**Roadmap slot.** Phase 2 (current). This is small enough to land alongside Phase 2's existing Langfuse work without disrupting it, and it is what makes the recurring-run experience legible without waiting for Phase 3.

---

## Cross-cutting design choices

### Playbook structure: extend, not fork

The `cost-summary` playbook gains the waste-detection lane group, the prior-run-context evidence injection (§Gap 5), and the freshness check (§Gap 4). It does *not* fork into a separate `cost-summary-deep` analyzer. The reasons:

- Keeping the analyzer surface stable means the [evaluation framework PRD](../prd/evaluation-framework.md) FR-13 ("dataset items versioned or stable enough for historical comparison") continues to apply across the Phase 3 expansion. Existing `cost-summary-001` and `cost-summary-002` dataset items remain valid; new fixtures get added for the new lanes.
- The reasoner's contract is unchanged: facts → hypotheses → recommendations, with citations. New lane outputs are just new `EvidenceRecord`s; the reasoner already knows how to consume them. The §14 trace vocabulary gets new attribute names (listed below) but no structural change.
- A forked analyzer would double the eval surface and the Langfuse prompt surface (planner + reasoner per fork), which would conflict with [Phase 2 design](phase-2.md) §"Prompt management" and §"Dataset migration".

The orchestrator gains a `WasteDetectionExecutor` (parallel to `EvidenceExecutor`) that runs the waste lanes after the cost-summary evidence plan completes. This keeps the lane code separable from the playbook code, so the lane registry can evolve without touching playbook structure.

### Reasoner prompt changes

The `reasoner.v1.md` prompt gains four small additions:

1. A `<waste_candidate_block>` section that fences waste-candidate evidence as data the same way `<evidence_block>` does today. Same prompt-injection guardrails.
2. Rules for the new evidence intents: `waste_candidate`, `waste_cluster`, `ownership_hint`, `prior_run_context`.
3. A rule that recommendations must compute and emit a deterministic `recommendation_signature` (§Gap 5).
4. A rule that estimated weekly impact must be rendered as a range with a cited rate source, never as a single dollar figure (§Gap 3).

These are additive. The prompt is versioned as `reasoner.v2.md` (or `reasoner@phase-3` in Langfuse Prompts terms once Phase 2's prompt-management work has landed). Evaluations of v1 against the existing dataset items stay valid; v2 evaluations against the existing items should produce equal-or-better grounding/clarity scores before the prompt is promoted.

### Trace vocabulary additions

Following the [phase-1 design](phase-1.md) §14 convention, new span attributes and events:

| Name | Kind | Description |
|---|---|---|
| `waste_lane.name` | span attribute | which waste lane produced the evidence |
| `waste_lane.candidate_count` | span attribute | number of resources matched by the lane |
| `waste_lane.cluster_count` | span attribute | number of name clusters within the lane |
| `waste_lane.estimated_weekly_usd_low` / `_high` | span attribute | calibrated estimate range |
| `waste_lane.rate_source` | span attribute | rate-card commit hash + capture date |
| `freshness.partial_window` | event | period-end within lag threshold |
| `freshness.uniform_drop` | event | cross-sub uniform-drop heuristic fired |
| `prior_run.matched_count` | span attribute | how many prior runs the store returned |
| `recommendation.signature` | score / attribute | deterministic ID, written as a Langfuse string attribute |
| `recommendation.continuity_weeks` | score | how many consecutive runs this signature has appeared in |

The names join the existing §14 vocabulary; they do not invent fresh attribute namespaces.

### Evaluation surface

Phase 3 requires new dataset items and new rubrics — the existing rubrics measure grounding, citation completeness, confidence consistency, and read-only adherence, but say nothing about whether a waste candidate is correctly classified or whether an estimated impact range is honest.

New evaluation items, landing in Phase 3 (not Phase 2.5):

- `cost-summary-waste-001` — single subscription with 5 orphan IPs, 1 unattached disk, 0 restored-PG. Expects: waste-candidate section emitted, all 6 candidates surfaced, estimated weekly impact present and within ±20% of the rate-card derivation.
- `cost-summary-waste-cluster-001` — single subscription with 24 orphan IPs sharing a `test-rig-*` prefix. Expects: cluster recommendation emitted, individual recommendations *not* emitted.
- `cost-summary-freshness-001` — cost-analysis evidence whose `time_window.end_utc` is within 24h of `now`. Expects: `freshness_partial_window` finding present, hypotheses caveated.
- `cost-summary-continuity-001` — a pair of fixture runs where the second run's `RunHistoryStore` returns the first run's output. Expects: "UNCHANGED week 2" markers on candidates that persist; "RECURRING" marker on a cluster that re-appears after being absent.

New rubrics:

- `rubric.waste_classification_grounding` — every waste candidate cites the lane evidence and the predicate that classified it.
- `rubric.estimated_impact_calibrated` — every estimated weekly impact renders as a range with a cited rate source.
- `rubric.continuity_grounded` — every "UNCHANGED week N" or "RECURRING" marker cites the prior-run-context evidence that justifies it.

These get the same booleans-plus-detail treatment as the Phase 1 rubrics ([phase-2 design](phase-2.md) §"Score taxonomy"). They flow through the Phase 2 score-publishing pipeline without further plumbing.

---

## What this design deliberately leaves to later

- **Automatic resolution detection.** The reference report tracks "✅ DONE" and "PARTIAL PROGRESS" by hand. Phase 3 does not attempt to detect resolution automatically — it can mark a candidate as "absent in the latest run" but cannot tell whether it was deleted, moved out of scope, or just temporarily invisible to ARG. Resolution attribution is a Phase 3+ research item.
- **Cost-allocation modelling.** Reservations, savings plans, hybrid benefit, negotiated discounts — none of these are modelled. Estimates remain list-price. A serious cost-allocation surface would conflict with the "agent will not produce finance-grade forecasting" non-goal ([core-agent PRD](../prd/core-agent.md) Non-Goals).
- **Owner notification.** The reference report identifies likely owners by name prefix but does not contact them. Az-Pixiu generates ownership *hypotheses* in the report; routing them anywhere is an explicit out-of-scope concern, consistent with the local-first and read-only constraints.
- **Real-time alerting.** The recurring-run pattern is weekly or daily, not minute-level. Real-time alerting remains a [roadmap.md](../roadmap.md) §"What is not on the roadmap" item.
- **Cross-tenant or cross-org reporting.** Each Az-Pixiu run operates in one operator's tenant. Aggregating across operators is a hosted-service shape, which is explicitly non-goal.

---

## Implementation sequencing

Each step independently shippable, in roadmap-phase order.

**Phase 2.5 — Cross-run continuity foundations.**

1. **`recommendation_signature` field.** Add to the reasoning output schema. Update `reasoner.v1.md` to compute it deterministically. No behaviour change yet — the field is written to `run.json` and to Langfuse trace attributes but no UI reads it.
2. **`RunHistoryStore` interface + filesystem implementation.** Reads `runs/<run-id>/run.json` files, indexes by `scope_signature`, returns `RunSummary[]` for a query. Tested against a folder of fixture runs.
3. **`prior_run_context` evidence injection.** Orchestrator queries the store on every run and injects matching prior runs as `EvidenceRecord`s. Reasoner ignores them initially (until Phase 3 prompts use them).
4. **Run Quality report section.** Promotes transport / freshness findings to a top-of-report section (§Gap 6). This step lands Gap 6 ahead of the rest.

**Phase 3 — Optimization breadth (depends on Phase 2.5).**

5. **`pricing/azure-rate-card.json` seed.** ~20 SKUs covering the initial waste lanes. Captured from public list-price pages with `source_url` and `captured_at` recorded.
6. **`WasteDetectionExecutor` + initial lane registry.** Six lanes (orphan IP, unattached disk, deallocated VM, stopped/failed AKS, restored-PG, empty registry). Each lane is a small object with an ARG query and a candidate renderer.
7. **Naming-pattern clusterer.** Deterministic, pure function. Tests cover the cluster examples from the reference report.
8. **Estimated-impact calculator.** Joins candidates to rate card; produces range estimates with cited sources; emits the `rate_source` trace attribute.
9. **Freshness check.** Pre-reasoning step in the orchestrator that emits `freshness_partial_window` and `freshness_uniform_drop` findings.
10. **`reasoner.v2.md` prompt.** Adds rules for waste candidates, clusters, ownership hints, prior-run context, calibrated impact rendering, and continuity markers. Promotion follows the Phase 2 prompt-management workflow.
11. **Markdown report extensions.** New "Waste Candidates" section, continuity markers on recommendations, estimated impact range rendering with footnoted rate-card citation.
12. **New eval items + rubrics.** Four dataset items, three rubrics, wired through the Phase 2 score-publishing pipeline.

Steps 1–4 are independently useful: with just the Run Quality section and the `RunHistoryStore` interface in place, the operator can already start seeing run-to-run continuity metadata in `run.json` even before the reasoner uses it. Steps 5–12 progressively realize the user-visible Phase 3 features.

---

## Verification

The design is satisfied when each item below holds:

- **A `pixiu analyze cost-summary` run against a scope with known orphan resources produces a "Waste Candidates" section listing them, with per-candidate evidence citations.**
- **Each waste candidate carries an estimated weekly impact as a range or "rate unavailable for SKU X" — never a silent zero.**
- **A run executed twice against the same scope produces, on the second run, "UNCHANGED week 2" markers on waste candidates that persist, sourced from `RunHistoryStore` evidence.**
- **A run whose cost-analysis time window ends within the lag threshold produces a `freshness_partial_window` data-quality finding, and the reasoner caveats hypotheses that depend on the affected totals.**
- **The Run Quality section appears at the top of every report, even when nothing of note happened ("0 throttles, all capabilities returned evidence").**
- **A waste-cluster fixture (24 names sharing a prefix) produces one cluster recommendation, not 24 individual recommendations.**
- **The three new rubrics fire on every eval item; their booleans + detail strings are filterable in Langfuse.**
- **Phase 1 and Phase 2 invariants continue to hold.** No new direct Azure SDK call; no destructive recommendation language; every fact still cites evidence; offline `pixiu eval --mock-model` still passes.

---

## Critical files

The documents that ground every choice above:

- [Architecture principles](../architecture-principles.md) — local-first, read-only, AMG-MCP boundary, evidence over assertion, calibrated uncertainty.
- [Use cases](../use-cases.md) — including the new "Recurring cleanup review" use case this design adds.
- [Roadmap](../roadmap.md) — Phase 2.5 and Phase 3 entries this design slots into.
- [Core agent PRD](../prd/core-agent.md) — FRs added for estimated impact, waste candidates, freshness reasoning, and cross-run continuity.
- [Reporting and recommendations PRD](../prd/reporting-and-recommendations.md) — FRs added for waste-candidate section, calibrated impact, run-quality section, continuity markers.
- [Evaluation framework PRD](../prd/evaluation-framework.md) — note added on rubrics for waste classification, calibrated impact, and continuity.
- [Phase 1 design](phase-1.md) — §14 trace vocabulary that the new attributes join.
- [Phase 2 design](phase-2.md) — prompt management, dataset migration, and score taxonomy this design plugs into.

The source surface this design will add or change (forward-looking — no code change in this commit):

- **Playbook.** `src/playbooks/cost-summary.ts` gains lane invocation; lane code lives under `src/playbooks/waste-lanes/`.
- **New orchestrator step.** `src/run/waste-detection.ts` runs the lanes and computes estimated impact.
- **New orchestrator step.** `src/run/freshness.ts` emits freshness findings.
- **Run-history.** `src/history/store.ts` (interface) + `src/history/filesystem-store.ts` (default impl).
- **Reasoner.** Prompt template moves to `prompts/reasoner.v2.md` (or Langfuse `reasoner@phase-3` post-Phase-2). Output schema adds `recommendation_signature`.
- **Report writer.** `src/report/markdown.ts` gains "Run Quality" and "Waste Candidates" sections and continuity-marker rendering.
- **Rate card.** `pricing/azure-rate-card.json` (new in-repo data file).
- **Eval items + rubrics.** New items under `eval/`, new rubrics under `src/evaluation/scoring.ts`.

Files this design does **not** touch: the `MCPTransport` interface, the failure taxonomy, the read-only allowlist, the `Scope` schema, the existing four Phase 1 rubrics. Those contracts were designed to outlive their original phases; this design honours that.
