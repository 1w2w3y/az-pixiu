# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

Phase 1 ("minimum viable agent") is complete; the project is in **Phase 2 — Langfuse depth** with **Phase 2.5 shipped** and the first **Phase 3 cost-summary slice** live (see `docs/roadmap.md`). The agent runs end-to-end against live AMG-MCP and Azure AI Foundry or LiteLLM, produces Markdown, HTML, and `run.json` artefacts per invocation, and can land Langfuse traces when configured. The evaluation surface has the Phase 1 dataset (`eval/phase-1.json`, 4 items), a Phase 3 waste dataset (`eval/phase-3-waste.json`, 1 item), six active automated rubrics (structural correctness, citation completeness, confidence consistency, read-only adherence, `estimated_impact_calibrated`, and `waste_classification_grounding`), and Langfuse score / Dataset Run / Experiment publishing for eval runs when credentials are present.

Current shipped foundations: `pixiu analyze` uses a filesystem-backed `RunHistoryStore`, injects a synthetic `prior_run_context` evidence record when matching prior runs exist, records `recommendation_signature`, writes transport summaries, surfaces transport- and freshness-level findings under a top-level "Run Quality" section, adds deterministic Executive Summary coverage disclosure, retries retriable evidence calls with capped backoff and pacing, and detects payload-embedded `amgmcp_cost_analysis` 429/auth/authz errors. **Phase 3 — cost-summary analyzer breadth** is partially shipped: the first waste lane (`orphan_public_ip`) is live with calibrated weekly impact estimates from `pricing/azure-rate-card.json`, and `reasoner.v2` is loaded for `analysis_type=cost_summary`. Still pending: additional waste lanes, naming-pattern clustering, reasoner use of `prior_run_context` for continuity markers, uniform-drop freshness detection, Langfuse-backed prompt loading, Langfuse-as-source datasets, LLM-as-judge, human-review tooling, and configurable redaction.

The code is TypeScript / Node 22 with `tsc` for build and `vitest` for tests. Useful commands: `npm run build`, `npm run dev`, `npm test`, `npm run typecheck`. Per-run artefacts land in timestamped subdirectories under `runs/`; eval-runner output goes under `runs/eval/<item-id>/<timestamped-run-dir>/`. The CLI surface is `pixiu analyze` (cost-surprise / cost-summary), `pixiu eval <dataset.json>`, and `pixiu diagnose`.

## What this project is

Az-Pixiu is a **local**, **read-only**, **observability-first** Azure FinOps agent. It will reach Azure exclusively through the Azure Managed Grafana MCP server (AMG-MCP), reason over cost/resource/telemetry signals, and produce explainable recommendations for human review. It is intentionally also a reference implementation for building observable AI systems on Langfuse.

## Documentation map

The docs are the source of truth in this phase. When working on any task, ground decisions in these files rather than defaulting to common patterns from other agent projects.

**Foundational (read first to orient):**
- `docs/vision.md` — long-term direction.
- `docs/goals.md` — goals AND non-goals; consult before scoping any new capability.
- `docs/architecture-principles.md` — the principles that should outlast any specific implementation choice.
- `docs/roadmap.md` — phased plan; check current phase before suggesting work.
- `docs/use-cases.md` — concrete scenarios the agent must support.
- `docs/amg-mcp-positioning.md` — why MCP is the Azure boundary, not vendor SDKs.
- `docs/langfuse-learning-goals.md` — which Langfuse capabilities must be load-bearing.

**Product requirements (`docs/prd/`):**
- `core-agent.md` — the analysis agent itself (FR-1 through FR-15).
- `amg-mcp-integration.md` — the MCP boundary contract.
- `langfuse-observability.md` — tracing/eval/prompt requirements.
- `reporting-and-recommendations.md` — output shape and evidence discipline.
- `evaluation-framework.md` — dataset + scoring requirements.
- `cli-experience.md` — local developer/operator UX.
- `future-multi-agent-platform.md` — long-term multi-agent direction (NOT current scope).

## Hard constraints (architecturally load-bearing)

These come from `architecture-principles.md` and `goals.md`. Treat them as defaults that should only be revisited explicitly.

- **Local-first.** No hosted Az-Pixiu service. The agent runs in the operator's environment; sensitive cloud telemetry stays there. Any optional external service (e.g. a hosted model provider, Langfuse Cloud) must be explicit to the operator.
- **Read-only against Azure.** No delete/scale/modify/restart of Azure resources, ever — not even behind a flag. Remediation guidance is framed as human-reviewed options, not autonomous action.
- **AMG-MCP is the Azure boundary.** Do not introduce direct Azure SDK calls inside the agent for cost/resource/telemetry data. If AMG-MCP lacks a capability, prefer patience or an upstream contribution over a local workaround that erodes the boundary. Record any exception.
- **Evidence over assertion.** Every recommendation must cite the resources, time windows, and metrics that justify it. An uncited recommendation is a defect.
- **Observable by construction.** Langfuse instrumentation is part of the first implementation, not a later addition. Tracing, evaluations, datasets, prompt versioning, and experiments are intended to be load-bearing in day-to-day development — not demo features.
- **Reversible decisions over premature commitments.** Languages, frameworks, model providers, storage layers, packaging, and deployment topology are deliberately undecided. When implementation begins, prefer choices that can be revisited.
- **Calibrated uncertainty.** The agent must distinguish observed facts, inferred hypotheses, and recommendations; surface incomplete or contradictory data as first-class findings rather than silently omitting them.

## Documentation style

The existing docs share a recognizable voice — match it when extending them:
- Position documents argue for a design decision and explain reasoning; they don't prescribe implementation (no languages, frameworks, file layouts in principle/positioning docs).
- PRDs use explicit, numbered functional requirements (FR-N), separate Goals from Non-Goals, and name trade-offs and open questions rather than papering over them.
- Prose is unhurried, lowercase headings, no marketing tone, no emoji. Sentences explain *why* before *what*.

## When editing docs

- Cross-reference related docs with relative markdown links (the existing files do this consistently — keep the web of references intact).
- If the README's documentation list changes (`README.md` lines 33–49), update it.
- Avoid expanding non-goals casually; treat the Goals/Non-Goals lists in `docs/goals.md` as deliberately scoped.
- New PRDs go in `docs/prd/` and follow the existing template shape (Overview, Problem Statement, Goals, Non-Goals, Personas, User Journeys, Functional Requirements, Non-Functional Requirements, Risks, Open Questions, Future Considerations, Success Criteria).

## Working in the code

- Anchor implementation work to a specific PRD requirement, design-doc section, or roadmap phase. Bare "this would be nice" changes get rejected.
- Honor the hard constraints above by default; flag explicitly if a proposal pushes against one.
- Langfuse tracing is wired into the orchestrator (`src/observability/`, `src/run/orchestrator.ts`). Every new span/event should join the existing §14 vocabulary in `docs/design/phase-1.md`, not invent fresh attribute names.
- The Azure boundary is `MCPTransport` (`src/mcp/`). Don't add Azure SDK calls inside the agent for cost / resource / telemetry data; if AMG-MCP lacks something, prefer an upstream contribution.
- The fixture-replay seam (`FixtureMCPTransport` + `scripts/seed-*.ts`) is how tests, the eval runner, and offline operator demos work without paid Azure / Foundry calls. New analysis types should ship with a seeded fixture and a dataset item.
- Tests live next to the modules in `tests/` mirroring `src/`. End-to-end coverage is in `tests/integration/end-to-end.test.ts` and `tests/evaluation/runner.test.ts`. One test (`tests/mcp/live.test.ts > listCapabilities propagates network errors`) hits a real endpoint and times out in network-isolated environments — that failure is pre-existing and unrelated to local changes.
