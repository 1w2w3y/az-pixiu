# Roadmap

This roadmap describes the order in which the project intends to develop capability. It is a direction of travel, not a schedule. Phases will be revisited as the project learns more about what is useful and what is hard.

The phases are cumulative. Earlier work is not discarded as later work begins; each phase builds on the foundations laid before it.

## Phase 0 — Foundations (complete)

The goal was to establish a shared understanding of what Az-Pixiu is, what it is not, and the principles by which it will be built. The deliverables of this phase were documentation, not code: vision, goals, architecture principles, use cases, positioning of key dependencies, and this roadmap. These remain the source of truth for everything that follows.

## Phase 1 — Minimum viable agent (complete)

The goal was to bring an end-to-end agent into existence, even in a constrained form. That bar has been met. The agent connects to AMG-MCP, retrieves a small but realistic set of Azure cost and telemetry signals, produces a recommendation grounded in that data, lands a Langfuse trace for every run, and ships with a first evaluation dataset (`eval/phase-1.json`, 4 items) and six scoring rubrics (the four Phase 1 rubrics — structural correctness, citation completeness, confidence consistency, read-only adherence — plus the Phase 3 additions `estimated_impact_calibrated` and `waste_classification_grounding`).

Scope stayed intentionally narrow: two analysis types (`cost_surprise`, `cost_summary`), a handful of AMG-MCP capabilities, and a single deployment target (clone-and-run TypeScript / Node 22). The point of this phase was to validate the architecture and to give the project something concrete to evaluate; both are done.

The full Phase 1 design lives in [phase-1 design](design/phase-1.md); its implementation sequencing and verification checklist record what was delivered.

## Phase 2 — Langfuse depth (current, partially shipped)

With a working agent in place, the focus shifts to exercising Langfuse capabilities in earnest. The first half of this phase has shipped: `pixiu analyze` can publish automated rubric Scores to the run trace, and `pixiu eval` can publish rubric and expectation Scores, upsert local dataset items, group per-item traces into a Langfuse Dataset Run / Experiment, and sweep multiple model ids through the same local dataset.

The remaining Phase 2 work is still deliberate and not yet implemented: prompts still load from versioned files in `prompts/`; local JSON datasets remain the source for CLI eval; LLM-as-judge scoring, human-review tooling, calibration reports, and configurable redaction are still planned surfaces. The intended direction remains that prompts can move into Langfuse-managed prompts, datasets can be sourced from Langfuse when desired, and experiments compare alternative prompts, models, and analysis strategies against the same dataset without breaking offline operation.

The aim is for the project's day-to-day work to genuinely depend on Langfuse rather than to demonstrate its features in isolation. The [Langfuse learning goals](langfuse-learning-goals.md) document describes what this looks like in more detail; the [Langfuse observability PRD](prd/langfuse-observability.md) FRs 6–12 are the concrete checklist; the [Phase 2 design](design/phase-2.md) records the design choices and sequencing.

## Phase 2.5 — Cross-run continuity foundations (complete)

Phase 2.5 is a small, foundational increment that sits between the Langfuse-depth work of Phase 2 and the analyzer breadth of Phase 3. The motivation is that several Phase 3 features — flagging waste candidates that have not moved for N runs, recognizing a name pattern that recurred from a prior run, tracking whether a recommendation is new or carried forward — depend on the agent having any awareness of prior runs at all. The current agent is amnesiac: every `pixiu analyze` run starts from zero. The [core agent PRD](prd/core-agent.md) Open Questions explicitly flag this: "How should repeated recommendations be de-duplicated across runs or review periods?" and "What level of local state is needed to support comparison over time without creating a hidden data store requirement?"

Phase 2.5 has landed in the codebase. It introduces a `RunHistoryStore` interface with a default local-filesystem implementation that indexes the existing `runs/*/run.json` artefacts; a deterministic `recommendation_signature` field on the reasoner's output so the same recommendation can be recognized across runs even when the LLM rewrites its wording; and a `prior_run_context` evidence record that the orchestrator injects when matching prior runs exist. The substrate is deliberately a filesystem index over what the agent already persists — no SQLite, no remote store, no new infrastructure — so that offline operation continues to work end-to-end. The interface, however, is shaped so SQLite or a Langfuse Datasets backing can be swapped in later without changing the analyzer or the reasoner.

Phase 2.5 also lands the small "Run Quality" report section that promotes transport-level and freshness-related data-quality findings to a first-class report surface. That piece is independent of cross-run state but small enough to ship in the same increment.

The full design lives in [cost-summary depth](design/cost-summary-depth.md) §Gap 5 and §Gap 6. The user-visible part is intentionally small: Run Quality now appears in reports, transport summaries are persisted into `run.json`, and prior-run context is available to the reasoner. The reasoner does not yet render continuity markers from that context; that remains Phase 3 work.

## Phase 3 — Optimization breadth (started)

Once the development loop is solid and the cross-run foundations are in place, the project expands the range of Azure scenarios it can reason about. New resource types are added. More optimization patterns are introduced. The agent's reports become richer and its evidence more comprehensive.

The first concrete Phase 3 cluster, designed in [cost-summary depth](design/cost-summary-depth.md), extends the existing `cost-summary` analyzer with a waste-detection lane group, calibrated weekly impact estimates, freshness checks, and user-visible cross-run markers. The first vertical slice has shipped: the `orphan_public_ip` lane runs through `WasteDetectionExecutor`, estimates weekly list-price impact from `pricing/azure-rate-card.json`, renders a deterministic Waste Candidates section, and is covered by `eval/phase-3-waste.json`. `reasoner.v2` is loaded for cost-summary, and the active rubric set now includes `waste_classification_grounding` and `estimated_impact_calibrated`.

The rest of this cluster is still pending: unattached disks, deallocated VMs, stopped or failed AKS clusters, "restored-*" PostgreSQL servers, empty container registries, deterministic naming-pattern clustering, uniform-drop freshness detection, and reasoner-rendered continuity markers such as UNCHANGED week N and RECURRING. The planned `continuity_grounded` rubric should land with those continuity markers, not before.

A companion improvement note — [cron-comparison-improvements](design/cron-comparison-improvements.md) — grounds these Phase 3 commitments against a live cross-comparison with a long-running reference cron, and adds **§Gap 7 (429 / rate-limit handling)** plus four smaller report-tightening items that the original cost-summary-depth design did not enumerate. That prerequisite has largely shipped: retry-with-backoff, per-capability pacing, payload-embedded rate-limit detection, transport summaries, Run Quality enrichment, and deterministic cost-coverage disclosure are in code. Proactive QPU-aware throttling remains upstream-dependent and out of scope for the current client.

The next cost-evidence foundation is a local finalized-month billing cache, designed in [local billing cache](design/local-billing-cache.md). It should cache per-subscription monthly Cost Management evidence on local disk only after a conservative stabilization day (default: the 5th day of the following month), then let later analyses reuse those finalized months without spending AMG-MCP / Azure Cost Management rate-limit budget. This is a Phase 3 enabler for quarterly reviews, recurring cleanup, and model comparison runs over historical windows; it is not a replacement for live retrieval of recent or partial periods.

This phase is governed by the use cases in the [use cases](use-cases.md) document — particularly the new "Recurring cleanup review" use case that motivates the cross-run work — and by the evaluations established in Phase 2. New capabilities are admitted when they improve those evaluations, not because they are interesting in isolation.

## Phase 4 — Beyond FinOps

When the project has demonstrated that the pattern works for cost analysis, it is expected to extend into adjacent cloud operations domains. Reliability investigation, capacity planning, and security posture analysis are natural candidates because they share the same shape: pull rich data from many systems, reason across it, and present a grounded narrative to a human operator.

This phase is the realization of the project's longer-term vision. It will only be undertaken when the foundations are strong enough that new domains can be added without weakening what came before.

## What is not on the roadmap

The roadmap deliberately omits items that the project has decided not to pursue, even if they are common in adjacent products. These include destructive remediation actions, hosted multi-tenant deployments, real-time alerting, and multi-cloud coverage. They are recorded in the [goals](goals.md) document under non-goals.

## How the roadmap is meant to be used

This document is a planning aid, not a commitment. Changes to the roadmap should be expected as the project learns. The intent is that anyone reading the roadmap can answer two questions: where the project is now, and what the next sensible step looks like. If a proposed piece of work cannot be placed against the phases above, that is a signal worth examining before the work begins.
