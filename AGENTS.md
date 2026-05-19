# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Repository status

Phase 1 ("minimum viable agent") is complete; the project is moving into **Phase 2 — Langfuse depth** (see `docs/roadmap.md`). The agent runs end-to-end against live AMG-MCP and Azure AI Foundry, produces a markdown report plus a `run.json` artefact per invocation, lands a Langfuse trace for every run, and has a first evaluation dataset (`eval/phase-1.json`, 3 items) plus four scoring rubrics. The next concrete work is wiring eval results back to Langfuse as Scores, migrating prompts to Langfuse Prompts, and standing up Langfuse Datasets / Experiments.

The code is TypeScript / Node 22 with `tsc` for build and `vitest` for tests. Useful commands: `npm run build`, `npm run dev`, `npm test`, `npm run typecheck`. Per-run artefacts land in `runs/<run-id>/`; eval-runner output goes under `runs/eval/<item-id>/<run-id>/`. The CLI surface is `pixiu analyze` (cost-surprise / cost-summary), `pixiu eval <dataset.json>`, and `pixiu diagnose`.

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
