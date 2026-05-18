# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

Az-Pixiu is in **Phase 0 — Foundations** (see `docs/roadmap.md`). The repository currently contains documentation only. There is no source code, no build system, no tests, and no package manifest. Do not invent build/lint/test commands; if asked to "run the tests" or similar, first confirm that the implementation phase has begun.

Phase 1 ("Minimum viable agent") is expected to introduce the first code: an end-to-end agent that connects to AMG-MCP, retrieves a small set of Azure cost and telemetry signals, and produces an evidence-backed recommendation. Langfuse tracing is in scope from the first run — observability is not added later.

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

## When implementation begins (Phase 1+)

This section will need to be replaced with real commands once code lands. Until then, when proposing implementation work:
- Anchor it to a specific PRD requirement or roadmap phase.
- Honor the hard constraints above by default; flag explicitly if a proposal pushes against one.
- Assume Langfuse instrumentation from the first commit, not as a follow-up.
