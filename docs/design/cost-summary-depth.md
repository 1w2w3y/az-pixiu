# Cost-Summary Depth

> **Status (2026-07):** Living design, partially implemented. Phase 2.5's cross-run state, Run Quality section, transport summary, and recommendation signatures have shipped. Early Phase 3 has shipped the first waste lane (`orphan_public_ip`), calibrated weekly impact estimates, `reasoner.v2`, the two active Phase 3 rubrics, and two cost-judgment eval cases. Complete non-empty waste lanes now emit a citable deterministic `lane_summary` record so aggregate counts and impact ranges survive the same numeric-grounding guard as per-candidate facts; incomplete enumeration deliberately withholds that summary. The July live-contract gate has also shipped: MCP `isError` is terminal before parsing; real MCP text envelopes are replayed in fixtures; both deterministic playbooks use the live Cost Analysis and Activity Log parameter schemas; ARG scope is normalized, carried in supported KQL, and retained as internal provenance; first-lane rows are validated for subscription/RG/ARM type/association/type-filter consistency; partial rows fail closed; exact duplicate-free candidate recall is bound to a successfully completed named lane; and unsafe zero, missing-total, malformed, or wrong-scope cost evidence is quarantined from reasoning, coverage, arithmetic, and cache admission. The next product increment is the bounded, cost-guided second pass. PostgreSQL is the first planned service evidence pack, followed by Log Analytics, AKS, Cosmos DB, and ACR. Additional waste lanes, naming-pattern clustering, uniform-drop freshness detection, and reasoner-rendered continuity markers remain planned work.

## Context

The Phase 1 `cost-summary` playbook ([`src/playbooks/cost-summary.ts`](../../src/playbooks/cost-summary.ts)) started deliberately narrow: deterministic AMG-MCP capability calls per scope (subscription list, per-subscription cost analysis, top resource types overall, top type x location cross-cut, tag-coverage roll-up, per-subscription activity log), no baseline comparison, and no result-driven follow-ups. That base still exists, but the current implementation now adds a Phase 2.5/Phase 3 layer around it: prior-run context can be injected, retrieval quality is summarized in the report, and `WasteDetectionExecutor` runs the `orphan_public_ip` lane for cost-summary. The reasoner describes top services, regional distribution, cost concentration, tagging gaps, period-defining lifecycle events, and, when the lane finds candidates, can frame the deterministic Waste Candidates section. The output is Markdown, HTML, and `run.json` per invocation.

A reference workflow — an external Claude-Code cron that has been producing weekly Azure cost reports for ~12 runs against 8 subscriptions (the report this design is grounded in lives at `claw-context/cron-azure-cost-analysis/report.md`) — demonstrates that real recurring cost-review output looks different from what the current Az-Pixiu `cost-summary` produces in six distinct ways. This document characterizes those differences, justifies which of them should become Az-Pixiu features, and locks the design choices that close each gap without weakening the project's evidence and observability discipline.

This is not a critique of the existing playbook. Phase 1's narrowness was a deliberate validation choice ([phase-1 design](phase-1.md) §"What Phase 1 deliberately leaves to later"). The work here extends the analyzer surface; it does not rewrite it.

A July 2026 investigation performed directly through the live AMG-MCP surface adds a second grounding source. It confirmed the intended evidence chain — portfolio cost to ARG configuration to raw metrics, logs, and activity — and exposed where the current implementation can overstate certainty. The most important example was a valid ARG response wrapped in MCP `content` text blocks: the orphan-public-IP lane counted the envelope as one unparsed row, produced zero candidates, and the report rendered that partial parse as "No matching resources." The same investigation found a complete historical cost window returning zero while an adjacent current window carried material spend. Neither observation proves the upstream data is wrong; both prove that a structurally successful call is not sufficient evidence for an authoritative zero. The additions below turn those lessons into product contracts without embedding tenant-specific costs or resource names in the design.

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

## The original six gaps and live-investigation additions

The first six gaps come from the recurring reference workflow. The two additions after them come from live AMG-MCP investigation and now gate further Phase 3 breadth.

> **2026-05-23 follow-up note.** A live cross-comparison against the same reference workflow, captured in [cron-comparison-improvements.md](cron-comparison-improvements.md), confirms that the six original gaps below are the right gaps. The follow-up adds a **§Gap 7 (429 / rate-limit handling)** that this document only assumes happens, plus four smaller report-tightening items (§S1–§S4). Retry, pacing, payload-embedded failure detection, and transport summaries have since largely shipped. The evidence-contract gate added here is distinct: it governs successful responses whose wire shape, scope, or zero value does not justify the conclusion drawn from them.

### Gap 1 — Zombie / waste detection as a separate analysis lane

**Observation.** The reference report enumerates specific zombie categories — orphaned public IPs, "restored-*" PostgreSQL servers, stopped or failed AKS clusters, unattached disks, deallocated VMs, unused container registries — naming individual resources, counting them per subscription, and presenting them as a cleanup backlog. The current `cost-summary` playbook only fetches "top 15 resource types overall" and has no concept of "this resource looks like waste."

**Design.** Introduce a `waste-detection` evidence lane within the `cost-summary` playbook. Each lane is one ARG query targeting a specific waste pattern, returning resource IDs plus the few fields needed to defend the classification (SKU, region, provisioning state, age, ipConfiguration, etc.). The reasoner receives the lane outputs as `EvidenceRecord`s with a new `intent: 'waste_candidate'` so it can group them in the report under a dedicated "Waste Candidates" section.

Planned lanes, each anchored to an unambiguous ARG predicate. Only the first row, orphaned public IPs, is enabled in code today:

| Lane | Predicate | Cited evidence |
|---|---|---|
| unassociated public IP candidates (`orphan_public_ip`) | `microsoft.network/publicipaddresses` with empty `ipConfiguration` and no NAT Gateway association | ID, SKU, location, allocation method, NAT association, age |
| unattached managed disks | `microsoft.compute/disks` with `diskState == 'Unattached'` | ID, size GB, SKU, location, age |
| deallocated VMs | `microsoft.compute/virtualmachines` with power state `deallocated` for ≥7d | ID, SKU, location, deallocation timestamp |
| stopped or failed AKS | `microsoft.containerservice/managedclusters` with `properties.powerState.code == 'Stopped'` or failed provisioning | ID, region, power state, provisioning state, agent pool count, last operation |
| "restored-*" Postgres | `microsoft.dbforpostgresql/flexibleservers` with name starting `restored-`, outside a configurable creation grace period | ID, SKU, region, create timestamp, recent activity |
| empty container registries | `microsoft.containerregistry/registries` with no pull, push, or material storage activity in the review window | ID, SKU, region, age, replication count, pull/push/storage metrics |

The lane list is **extensible by configuration**, not hardcoded. Each lane is a small object with a name, an ARG query, and a renderer for the per-candidate evidence record. New lanes admit when the use case is documented and the predicate is unambiguous. A structural match is still a *review candidate*, not proof of waste: public-IP pools, private-link NICs, stopped disaster-recovery capacity, and security controls can all be intentionally idle.

**Trade-off resolved conservatively: name-only and state-only matches are insufficient.** A legitimately named production server starting with `restored-`, a newly created restore under investigation, or a reserved public-IP pool would be a false positive. Each candidate therefore carries lifecycle context and an explicit `false_positive_considerations` field, which feeds the reasoner's corresponding field (reporting PRD FR-13). The report can recommend an owner or TTL review before a grace period expires; it cannot recommend deletion or attach a savings estimate as though the resource were confirmed waste.

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

For each waste candidate the lane attaches an estimated weekly impact computed from `count × matched_rate`. The deterministic executor rolls complete non-empty lanes up and emits a separate `record_kind = lane_summary` EvidenceRecord containing the exact candidate count, the candidate evidence IDs it summarizes, priced/unpriced coverage, impact range, and pricing provenance. The reasoner cites that record rather than recomputing aggregate numbers from several candidate records. If parsing or scope validation is incomplete, the summary is withheld so a partial enumeration cannot become an authoritative total. The report renders impact as a *range* (e.g., "~$83–$91/week, list-price exposure estimate") not a point figure, with a footnote citing the rate source and the calculation.

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

Phase 2.5 shipped **option 1** (filesystem index over `runs/`) because it is the only one compatible with offline-first operation as a default. It exposes the `RunHistoryStore` interface so option 2 or 3 can be swapped in later without changing the analyzer or the reasoner.

**Trade-off accepted: cross-run continuity is a Phase 2.5 prerequisite for Phase 3, not a Phase 3 sub-item.** Several Phase 3 features (UNCHANGED markers, recurring-pattern detection, "no action taken since week N" recommendations) read from `RunHistoryStore`. Building those features first and bolting on state later would produce a worse interface, because the state-write call sites are inside the analyzer and reasoner. The cleaner sequence is: ship `RunHistoryStore` and `recommendation_signature` first as a foundational Phase 2.5 increment, then build the Phase 3 waste-detection features against that interface.

**Trade-off named, not resolved: scope-drift handling.** When the operator runs the same `analysis_type` with a slightly different subscription list (e.g., a sub was lost to RBAC denial), the `scope_signature` does not match a prior run's. Three options: (a) require an exact match (conservative — no false continuity claims, but loses signal when scopes drift slightly), (b) match on a *subset* relationship (more useful but introduces ambiguity), (c) make the operator opt in with `--prior-run <run-id>` (explicit but burdensome). The shipped implementation uses (a). A `--prior-run` override and subset matching remain future options once real recurring use surfaces the patterns.

**Roadmap slot.** Foundational layer in [Phase 2.5](../roadmap.md#phase-25--cross-run-continuity-foundations-complete); first user-visible features in Phase 3.

### Gap 6 — Run-quality observations surfaced in the report

**Observation.** The reference report ends most weekly entries with a one-line operational footer: "1 throttle on Jenkins (120s backoff cleared)", "All 8 cost-analysis queries succeeded with 0 throttles this run". This treats run quality as a first-class observation, not a backstage diagnostic.

**Design.** Promote a small subset of `DataQualityFinding`s to a new "Run Quality" report section (rendered by the markdown report writer between "Scope & Data Sources" and "Executive Summary"). The promotion criterion: findings whose `affected_capability` is `network` or `transport`, plus any `freshness_*` finding emitted by Gap 4. Other findings (tag coverage gaps, partial cost coverage from missing aggregations) continue to render in the existing "Data Quality" section.

The Langfuse trace already emits enough information to produce these — Phase 1's §14 vocabulary covers `mutating_capabilities_excluded`, transport-level retries, and HTTP status codes. Gap 6 is mostly a report-writer change with a tiny normalizer addition. No new evidence lanes.

**Roadmap slot.** Phase 2 (current). This is small enough to land alongside Phase 2's existing Langfuse work without disrupting it, and it is what makes the recurring-run experience legible without waiting for Phase 3.

### Live prerequisite A — Evidence-contract correctness

**Observation.** AMG-MCP tools return a `ToolCallResult`, not a domain object. A common successful shape is `content: [{ type: 'text', text: '<JSON>' }]`, while fixture tests often hand the consumer an already-decoded object. The first orphan-public-IP lane accepted both a bare array and a decoded `data` array in tests, but did not decode the live text envelope. It then treated the envelope as an unparseable ARG row. The renderer allowed `candidate_count == 0` to become "No matching resources" even though `unparsed_row_count > 0` proved the enumeration was incomplete.

Scope has a separate version of the same problem. The live `query_resource_graph` schema accepts the query (and, where configured, a datasource selector), not an arbitrary `subscription_ids` field. A client can therefore believe it requested a narrow scope while the server ignores the unsupported field. Request intent is not effective scope; the response must carry enough subscription identity to validate where each row came from.

**Design.** Evidence consumers share one wire-decoding boundary and fail closed after it:

1. Decode MCP content blocks with the shared JSON-content decoder before inspecting domain rows. Wire-shaped fixture responses are the default contract-test shape; already-decoded objects remain a convenience only for focused parser unit tests.
2. Construct parameters from the discovered capability schema. When ARG exposes no separate subscription parameter, embed the subscription predicate in KQL and project `subscriptionId` in every returned row. Reject or quarantine rows outside the intended scope.
3. Distinguish `zero_matches` from `incomplete_enumeration`. Only a successfully decoded response with an upstream count of zero, zero parsed candidates, zero unparsed rows, and validated scope may render "No matching resources." Any decode failure, schema mismatch, missing scope identity, or unparsed row makes the lane partial or failed and produces a Run Quality finding.
4. Apply the same rule to cost evidence. MCP `isError` is terminal before domain parsing. A zero total is valid only when the payload is internally consistent and no available adjacent-window or dimensional evidence contradicts it. A missing or malformed numeric total/dimension or unrecognized successful shape emits `zero_unresolved`; a contradictory zero emits `cost_zero_suspected`; and a structured response whose returned subscription set does not exactly match the request emits `cost_scope_mismatch`, even when its total is non-zero. All three quarantine states stay partial, are excluded from reasoning, coverage, trend, and savings arithmetic, and are never admitted to or replayed from the [local billing cache](local-billing-cache.md).

This is not a new Azure dependency and does not broaden the read-only allowlist. It makes the existing AMG-MCP boundary explicit at the point where wire evidence becomes product evidence.

**Evaluation.** The orphan-IP dataset gains a wire-shaped MCP envelope, exact expected candidate IDs, an attached and a NAT-associated exclusion, effective-subscription assertions, and a maximum unparsed-row expectation of zero. Separate cost fixtures cover a legitimate zero and a structurally successful but contradictory zero. Candidate recall, scope confinement, and parse completeness are deterministic expectations; LLM rubrics do not substitute for them.

**Roadmap slot.** Phase 3 correctness gate, before additional waste lanes or service evidence packs.

### Live addition B — Bounded service evidence packs

**Observation.** The live portfolio investigation found that material cost and actionable evidence did not align one-to-one with structural waste predicates. PostgreSQL required SKU, age, high availability, and CPU, memory, I/O, and connection distributions; AKS required node-pool configuration and per-pool metrics because a cool cluster average hid a hot pool; Log Analytics required table-level ingestion attribution; Cosmos DB required provisioned-throughput and collection lifecycle; ACR required pull, push, storage, age, and replication context. A static top-resource query can name these services but cannot defend an optimization recommendation about them.

**Design.** Extend `cost_summary` with a bounded two-pass flow:

1. **Portfolio pass.** Discover visible scope, retrieve cost one subscription at a time, disclose intended versus cost-covered scope, rank material services, and gather only the broad ARG summaries needed to choose a follow-up. This pass remains deterministic and can finish as a useful partial report when RBAC or throttling removes subscriptions.
2. **Evidence-pack pass.** Select from an allowlisted registry of service packs using deterministic materiality and capability-availability rules. Each pack has a declared call budget, required and optional signals, supported resource types, metric definitions, time windows, dimensionality, minimum sample coverage, and a stop condition. A pack returns facts, hypotheses, lifecycle context, and data-quality findings through the existing evidence model. The reasoner never invents a follow-up outside that registry.

The first packs, in implementation order:

| Pack | Required evidence | Guardrail |
|---|---|---|
| PostgreSQL rightsizing | cost materiality; ARG SKU, HA, storage, age; 7/30-day hourly and full-window CPU, memory, I/O, connections; recent activity | require a mature observation window; preserve p95/max and recent-change context; no SKU recommendation from average CPU alone |
| Log Analytics ingestion | workspace cost; billable ingestion by workspace, table, and day; DCR/diagnostic configuration where exposed | attribute ingestion before recommending retention or sampling; overlapping table names are a review signal, not proof of duplication |
| AKS node-pool efficiency | cluster and pool size/SKU/autoscaler bounds; pool-level CPU and memory distributions; unschedulable and reliability signals | reason per pool, not from cluster average; `min == max` is a configuration fact, not automatic proof of excess |
| Cosmos DB throughput | account and child collection throughput mode; RU, throttling, requests, data size, regions, age | isolated maximum RU does not justify expansion; near-zero test collections need a lifecycle window before cleanup framing |
| ACR inactivity / replication | SKU, age, replication topology, 30/90-day pull, push, and storage activity | distinguish an unused registry from a low-traffic distribution or disaster-recovery registry |

Every pack shares `lifecycle_context`: creation time and age, owner and purpose evidence, recent management activity, grace-period state, and prior-run persistence. Name prefixes and tags can supply ownership or purpose *hints*, never facts without corroboration. Where a required child-resource or configuration surface is absent from AMG-MCP — detailed Cosmos collection enumeration is the likely first case — the pack reports the capability gap and waits for an upstream addition rather than calling an Azure SDK.

`pulse_check` is allowed as a candidate generator when its capability is present, but its severity thresholds and instantaneous peaks are not final recommendation evidence. The selected pack still retrieves raw metric definitions and time series, records aggregation and dimensionality, and validates the hypothesis against averages, p95 or an equivalent distribution, maxima, and sample coverage. This prevents boundary-condition warnings, brief spikes, and cluster-level aggregation from being promoted into rightsizing advice.

**Roadmap slot.** Phase 3, after Evidence-contract correctness. PostgreSQL is the first vertical slice; the remaining packs follow in the order above unless live materiality changes the priority.

---

## Cross-cutting design choices

### Playbook structure: extend, not fork

The `cost-summary` playbook is extended by the waste-detection lane group, prior-run-context evidence injection (§Gap 5), freshness checks (§Gap 4), and the bounded service-pack pass. It does *not* fork into a separate `cost-summary-deep` analyzer. The reasons:

- Keeping the analyzer surface stable means the [evaluation framework PRD](../prd/evaluation-framework.md) FR-13 ("dataset items versioned or stable enough for historical comparison") continues to apply across the Phase 3 expansion. Existing `cost-summary-001` and `cost-summary-002` dataset items remain valid; new fixtures get added for the new lanes.
- The reasoner's contract is unchanged: facts → hypotheses → recommendations, with citations. New lane outputs are just new `EvidenceRecord`s; the reasoner already knows how to consume them. The §14 trace vocabulary gets new attribute names (listed below) but no structural change.
- A forked analyzer would double the eval surface and the Langfuse prompt surface (planner + reasoner per fork), which would conflict with [Phase 2 design](phase-2.md) §"Prompt management" and §"Dataset migration".

The orchestrator now has a `WasteDetectionExecutor` (parallel to `EvidenceExecutor`) that runs the enabled waste lanes after the cost-summary evidence plan completes. This keeps the lane code separable from the playbook code, so the lane registry can evolve without touching playbook structure.

The service-pack pass follows the same separation. A deterministic selector receives normalized portfolio cost evidence, effective coverage, and the discovered read-only catalog; it returns zero or more named packs within a run-level call budget. Each pack constructs an ordinary `EvidencePlan` or delegates to a bounded executor and emits ordinary evidence and data-quality records. This keeps replay and evaluation possible: fixture datasets know which pack was selected and which finite calls it is permitted to make. The LLM planner does not control the number of iterations and cannot turn `cost_summary` into an unbounded exploratory loop.

### Reasoner prompt changes

The `reasoner.v2.md` prompt carries the first set of additions:

1. Rules for waste-candidate evidence (`query_intent = 'waste_candidate'`, `source_capability = 'az_pixiu_waste_lane'`) with the same prompt-injection guardrails as ordinary evidence.
2. A rule that recommendations must compute and emit a stable `recommendation_signature` (§Gap 5).
3. A rule that estimated weekly impact must be rendered as a range with a cited rate source, never as a single dollar figure (§Gap 3).
4. A rule that lane outputs should usually produce one lane-scoped recommendation rather than one recommendation per candidate.
5. A rule that service-pack recommendations cite configuration, utilization distribution, lifecycle context, and effective scope together; absence of any required signal downgrades the output to a hypothesis or data-quality finding.
6. A rule that `pulse_check`, name patterns, low averages, and isolated maxima are candidate hints rather than sufficient optimization evidence.

Cluster, ownership-hint, and prior-run continuity rules remain future additions to v2. Once Phase 2's Langfuse prompt-management work lands, the same prompt should be promoted as a Langfuse-managed `reasoner` version rather than only as an in-repo file.

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
| `evidence_contract.unparsed_count` | span attribute | decoded rows that could not be admitted as domain evidence |
| `evidence_contract.scope_validated` | span attribute | whether returned subscription identity matched intended scope |
| `cost.zero_suspected` | event | a structurally successful all-zero response contradicted available evidence |
| `service_pack.name` | span attribute | bounded service evidence pack selected for the second pass |
| `service_pack.call_budget` / `.calls_used` | span attribute | declared and consumed read-only call budget |
| `service_pack.sample_coverage` | span attribute | usable metric samples versus the pack's requested observation window |

The names join the existing §14 vocabulary; they do not invent fresh attribute namespaces.

### Evaluation surface

Phase 3 requires new dataset items and new rubrics — the existing rubrics measure grounding, citation completeness, confidence consistency, and read-only adherence, but say nothing about whether a waste candidate is correctly classified or whether an estimated impact range is honest.

Evaluation items:

- `cost-summary-waste-001` — **shipped in `eval/phase-3-waste.json`** for the orphan public-IP vertical slice. It expects the waste lane to surface 5 orphan public IPs, exclude an attached IP, preserve the rate-unavailable Basic/Dynamic case, and invoke `az_pixiu_waste_lane`.
- `cost-summary-cost-only-001` — **shipped in `eval/phase-3-cost-reasoning.json`** for a PostgreSQL-heavy cost concentration with no utilization evidence. It expects a `missing_telemetry` disclosure and permits investigation, but rejects an unsupported underutilization, concrete rightsizing, or savings claim.
- `cost-summary-pip-reconciliation-001` — **shipped in `eval/phase-3-cost-reasoning.json`** for a public-IP lane whose list-price exposure is materially above the same-window billed public-IP cost. It expects exact lane totals and candidate recall, then requires the recommendation to distinguish observed cost, list-price exposure, and unknown realizable savings.
- `cost-summary-partial-coverage-429-001` — eight requested subscriptions with only five usable Cost Analysis responses after retry exhaustion. Expects every portfolio total and ranking to be labelled as a covered-scope lower bound, with the three uncovered subscriptions named rather than extrapolated away.
- `cost-summary-supported-no-op-001` — complete evidence with no supported optimization opportunity. Expects zero recommendations and an explicit statement that the available evidence does not justify action, countering the dataset bias toward always producing advice.
- `cost-summary-conflicting-utilization-001` — low average utilization but high peak or connection pressure. Expects the peak fact to appear as counter-evidence and withholds downsizing. This item lands with the first metrics-backed PostgreSQL service pack rather than pretending the current analyzer retrieved signals it does not yet collect.
- `cost-summary-waste-cluster-001` — single subscription with 24 orphan IPs sharing a `test-rig-*` prefix. Expects: cluster recommendation emitted, individual recommendations *not* emitted.
- `cost-summary-freshness-001` — cost-analysis evidence whose `time_window.end_utc` is within 24h of `now`. Expects: `freshness_partial_window` finding present, hypotheses caveated.
- `cost-summary-continuity-001` — a pair of fixture runs where the second run's `RunHistoryStore` returns the first run's output. Expects: "UNCHANGED week 2" markers on candidates that persist; "RECURRING" marker on a cluster that re-appears after being absent.
- `cost-summary-waste-wire-001` — a wire-shaped ARG response in MCP text-content blocks with in-scope, attached, NAT-associated, and out-of-scope rows. Expects exact candidate IDs, zero unparsed rows, and no scope leakage.
- `cost-summary-zero-suspected-001` — a full-month zero that contradicts adjacent non-zero cost evidence. Expects `cost_zero_suspected`, partial outcome, no trend or savings arithmetic, and no cache write.
- `cost-summary-missing-total-001` — a successful MCP envelope whose cost payload has no numeric aggregate. Expects `zero_unresolved`, partial outcome, no zero-cost fact, and no cache write.
- `cost-summary-scope-mismatch-001` — a structurally successful, non-zero cost response whose returned subscription set differs from the request. Expects `cost_scope_mismatch`, partial outcome, no cost fact, and no cache write or replay.
- `cost-summary-zero-valid-001` — an internally consistent zero for a genuinely empty scope. Expects a valid zero without a false warning.
- `cost-summary-postgres-rightsizing-001` — mature and newly created PostgreSQL resources with similar low averages but different age and peak behavior. Expects a review candidate only for the mature, distribution-supported case.

New rubrics:

- `rubric.waste_classification_grounding` — every waste candidate cites the lane evidence and the predicate that classified it.
- `rubric.estimated_impact_calibrated` — every estimated weekly impact renders as a range with a cited rate source.
- `rubric.continuity_grounded` — **pending**; every "UNCHANGED week N" or "RECURRING" marker cites the prior-run-context evidence that justifies it.

These get the same booleans-plus-detail treatment as the Phase 1 rubrics ([phase-2 design](phase-2.md) §"Score taxonomy"). They flow through the Phase 2 score-publishing pipeline without further plumbing.

The two cost-judgment items use dataset-level semantic expectations rather than globally active rubrics. `require_utilization_evidence_for_optimization_claims` follows each recommendation's fact/hypothesis citation closure and rejects assertive optimization language — including target SKU, tier, vCore, and dollar-reduction language — when no raw utilization evidence supports it. `require_waste_cost_reconciliation` fails closed unless the named lane completed, its estimated range exceeds a same-window billed resource-type amount, and at least one recommendation cites the aggregate lane summary plus billed-cost evidence, reports the exact lane range and either the exact billed total or every billed component, and explicitly treats exposure as distinct from realized savings. These expectations publish as independent Langfuse Scores, so model and prompt experiments can compare the behaviors without adding mostly-vacuous scores to unrelated runs.

The reasoning post-processor's numeric-grounding boundary covers only trusted fields of each cited EvidenceRecord: `scope_subset`, `time_window`, inline `payload_ref.data`, and `payload_summary`. This lets scoped subscription IDs, declared dates, explicit zero-row summaries, and deterministic lane totals survive validation without treating numbers in evidence IDs, caveats, or capability metadata as proof. The boundary remains citation-driven; widening it is not a relaxation into arbitrary model arithmetic.

Dataset expectations also become stricter. A waste-lane item names exact expected and excluded resource IDs, intended subscriptions, maximum unparsed rows, and whether a no-match claim is permitted. A service-pack item names the expected selected pack, required capability set, maximum call count, minimum sample coverage, and candidates that must be withheld because lifecycle or telemetry evidence is incomplete. These deterministic checks close a gap that prose-quality rubrics cannot: a well-written report must still fail evaluation when it silently missed the resources it was meant to enumerate.

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

1. **`recommendation_signature` field.** **Shipped.** The reasoning output schema requires it, and the value is written to `run.json`.
2. **`RunHistoryStore` interface + filesystem implementation.** **Shipped.** Reads `runs/*/run.json` files, indexes by `scope_signature`, and returns `RunSummary[]` for a query.
3. **`prior_run_context` evidence injection.** **Shipped as a foundation.** The orchestrator queries the store and injects matching prior runs as `EvidenceRecord`s. Reasoner-rendered continuity markers are still pending.
4. **Run Quality report section.** **Shipped.** Promotes transport / freshness findings to a top-of-report section (§Gap 6), includes a run-outcome line, and always renders a quantified baseline.

**Phase 3 — Optimization breadth (depends on Phase 2.5).**

5. **Live evidence-contract gate.** **Shipped across both deterministic playbooks, the first waste lane, and the cost-zero path.** Cost Analysis and Activity Log use their discovered camelCase/ARM-scope wire parameters; ARG calls use supported query-only parameters; KQL carries subscription/resource-group/type scope while `intended_scope_subset` preserves provenance outside the wire call; and the first lane validates returned subscription plus ARM identity before admission.
6. **Fail-closed rendering and deterministic contract evaluation.** **Shipped for `orphan_public_ip`.** A lane renders "No matching resources" only after a complete, scope-validated enumeration. Wire-shaped fixtures bind expectations to the named lane, require it to complete without failure, assert exact candidate IDs/count, and require zero unparsed/rejected rows.
7. **Cost evidence quarantine.** **Shipped as the first conservative state machine.** `valid_zero`, `cost_zero_suspected`, `zero_unresolved`, and `cost_scope_mismatch` are distinguished; contradictory zeros, malformed/missing numeric aggregates or dimensions, unrecognized successful payloads, and structured returned-scope mismatches become partial, quarantined provenance, are withheld from reasoning and coverage, and cannot enter or be replayed from the cache. See [local billing cache](local-billing-cache.md) §"Cache admission gate".
8. **`pricing/azure-rate-card.json` seed.** **Shipped for the first waste lane.** Captured rates include source and capture metadata; coverage will expand as new lanes need SKUs.
9. **`WasteDetectionExecutor` + lane registry.** **Partially shipped.** The executor and registry are live with one enabled lane, `orphan_public_ip`, and its live-contract completion bar is satisfied. Additional lanes remain planned.
10. **Bounded portfolio-to-service selector.** Pending. Rank material services from normalized cost evidence, select only allowlisted packs within a declared call budget, and preserve intended-versus-effective coverage.
11. **PostgreSQL rightsizing pack.** Pending, first service vertical slice. Ship a seeded fixture and an eval item covering age, recent changes, averages, p95/max, and missing-metric withholding.
12. **Log Analytics, AKS, Cosmos DB, and ACR packs.** Pending, in that order. Each admits only after its required evidence and false-positive guardrails are fixture-replayable; missing AMG-MCP surfaces become visible capability gaps.
13. **Naming-pattern clusterer.** Pending. Deterministic, pure function. Tests should cover the cluster examples from the reference report.
14. **Estimated-impact calculator.** **Shipped for lane candidates.** Joins candidates to the in-repo rate card, produces range estimates, and marks rate-unavailable candidates explicitly.
15. **Freshness check.** **Partially shipped.** The `freshness_partial_window` heuristic and suspicious-zero quarantine are implemented; `freshness_uniform_drop` remains pending.
16. **`reasoner.v2.md` prompt.** **Partially shipped.** v2 adds structural review-candidate, false-positive, calibrated-impact, and quarantined-zero rules and is loaded for `cost_summary`. Service-pack, cluster, ownership-hint, and prior-run continuity rules remain follow-up work.
17. **Markdown report extensions.** **Partially shipped.** The "Waste Candidates" section, fail-closed no-match rendering, partial lower-bound labeling, and estimated-impact rendering are live. Service-pack disclosure and continuity markers remain pending.
18. **New eval items + rubrics.** **Partially shipped.** `eval/phase-3-waste.json` covers the orphan-IP lane, and two rubrics are active: `waste_classification_grounding` and `estimated_impact_calibrated`. Wire-contract, valid/suspicious-zero, service-pack, and continuity eval items remain pending.

Steps 1–4 are independently useful: with just the Run Quality section and the `RunHistoryStore` interface in place, the operator can already start seeing run-to-run continuity metadata in `run.json` even before the reasoner uses it. Steps 5–7 are a correctness gate, not optional hardening. Steps 8–18 progressively realize the user-visible Phase 3 features after that gate holds.

---

## Verification

The design is satisfied when each item below holds:

- **A `pixiu analyze cost-summary` run against a scope with known orphan resources produces a "Waste Candidates" section listing the exact in-scope candidates, with per-candidate evidence citations.** The same fixture delivered through a real MCP text envelope produces the same candidates as its decoded parser fixture.
- **A lane with any undecoded content, missing effective-scope identity, or unparsed row never renders "No matching resources."** It renders partial or failed status and a Run Quality finding instead.
- **An unsupported out-of-band ARG scope parameter is never relied upon.** Scope is present in supported parameters or query text, projected into returned rows, and validated before the rows become evidence.
- **A contradictory all-zero cost payload emits `cost_zero_suspected`; a missing or malformed aggregate/dimension emits `zero_unresolved`; and an exact returned-subscription mismatch emits `cost_scope_mismatch`. All three make the cost outcome partial, are excluded from reasoning, coverage, trend and savings arithmetic, and are neither cached nor replayed from a legacy cell.** A separate genuinely empty fixture remains a valid zero.
- **Each waste candidate carries an estimated weekly impact as a range or "rate unavailable for SKU X" — never a silent zero.**
- **A run executed twice against the same scope injects prior-run context on the second run.** User-visible "UNCHANGED week 2" markers sourced from that context remain a Phase 3 follow-up.
- **A run whose cost-analysis time window ends within the lag threshold produces a deduplicated `freshness_partial_window` data-quality finding, and the reasoner caveats hypotheses that depend on the affected totals.**
- **The Run Quality section appears at the top of every report, even when nothing of note happened ("0 throttles, all capabilities returned evidence").**
- **A waste-cluster fixture (24 names sharing a prefix) produces one cluster recommendation, not 24 individual recommendations.** Pending until the clusterer lands.
- **The PostgreSQL service-pack fixture selects one bounded pack, stays within its declared call budget, recommends review only for the mature candidate with distribution-supported underuse, and withholds a SKU recommendation for a new or peak-constrained server.** Pending until the first service pack lands.
- **`pulse_check` findings alone never satisfy a utilization recommendation's evidence requirements.** Raw metrics, aggregation, dimensions, and sample coverage must be present in the same evidence chain.
- **The active Phase 3 rubrics fire on eval items; their booleans + detail strings are filterable in Langfuse when score publishing is enabled.** `continuity_grounded` lands with continuity markers.
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

The source surface this design has added or still plans to change:

- **Playbook / lanes.** Lane code lives under `src/playbooks/waste-lanes/`; the current registry enables `orphan_public_ip`.
- **MCP content decoder.** `src/mcp/content.ts` is the shared boundary for decoding JSON carried in MCP content blocks; lane-specific parsers should not reimplement the envelope.
- **Waste executor.** `src/run/waste-detection.ts` runs enabled lanes and computes estimated impact.
- **Service packs.** A bounded pack registry and PostgreSQL implementation are planned under the playbook/run boundary; exact paths should follow the existing `EvidencePlan` and executor separation rather than introducing a second analyzer.
- **Freshness.** `src/run/freshness.ts` emits deduplicated `freshness_partial_window` findings; `freshness_uniform_drop` remains pending.
- **Run-history.** `src/history/store.ts` (interface) + `src/history/filesystem-store.ts` (default impl) are shipped.
- **Reasoner.** `prompts/reasoner.v2.md` is loaded for `cost_summary`; output schema includes `recommendation_signature`. Continuity-marker prompt rules remain pending.
- **Report writer.** `src/report/markdown.ts` renders "Run Quality" and "Waste Candidates"; continuity-marker rendering remains pending.
- **Rate card.** `pricing/azure-rate-card.json` is the in-repo list-price source for the first waste lane.
- **Eval items + rubrics.** `eval/phase-3-waste.json` and two Phase 3 rubrics are shipped; continuity-specific evals and rubric remain pending.

Files this design does **not** touch: the `MCPTransport` interface, the failure taxonomy, the read-only allowlist, the `Scope` schema, the existing four Phase 1 rubrics. Those contracts were designed to outlive their original phases; this design honours that.
