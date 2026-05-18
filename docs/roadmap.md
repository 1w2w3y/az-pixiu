# Roadmap

This roadmap describes the order in which the project intends to develop capability. It is a direction of travel, not a schedule. Phases will be revisited as the project learns more about what is useful and what is hard.

The phases are cumulative. Earlier work is not discarded as later work begins; each phase builds on the foundations laid before it.

## Phase 0 — Foundations

The project is currently in this phase.

The goal is to establish a shared understanding of what Az-Pixiu is, what it is not, and the principles by which it will be built. The deliverables of this phase are documentation, not code: vision, goals, architecture principles, use cases, positioning of key dependencies, and this roadmap.

This phase ends when the documentation is sufficient for another engineer to read it and understand the project's intent without needing to ask the original authors.

## Phase 1 — Minimum viable agent

The goal of this phase is to bring an end-to-end agent into existence, even in a constrained form. The agent should be able to connect to AMG-MCP, retrieve a small but realistic set of Azure cost and telemetry signals, and produce a recommendation grounded in that data.

Scope is intentionally narrow. A small number of Azure resource types, a small number of optimization patterns, and a single deployment target are sufficient. The point of this phase is to validate the architecture and to give the project something concrete to evaluate.

Langfuse tracing is part of this phase from the start. The project does not introduce observability later; the first runs of the agent are already instrumented.

## Phase 2 — Langfuse depth

With a working agent in place, the focus shifts to exercising Langfuse capabilities in earnest. Datasets of representative scenarios are curated. Evaluations are defined against those datasets. Prompts move into managed versions. Experiments compare alternative strategies on real workloads. Scoring — both automated and human — becomes part of the development loop.

The aim is for the project's day-to-day work to genuinely depend on Langfuse rather than to demonstrate its features in isolation. The [Langfuse learning goals](langfuse-learning-goals.md) document describes what this looks like in more detail.

## Phase 3 — Optimization breadth

Once the development loop is solid, the project expands the range of Azure scenarios it can reason about. New resource types are added. More optimization patterns are introduced. The agent's reports become richer and its evidence more comprehensive.

This phase is governed by the use cases in the [use cases](use-cases.md) document and by the evaluations established in Phase 2. New capabilities are admitted when they improve those evaluations, not because they are interesting in isolation.

## Phase 4 — Beyond FinOps

When the project has demonstrated that the pattern works for cost analysis, it is expected to extend into adjacent cloud operations domains. Reliability investigation, capacity planning, and security posture analysis are natural candidates because they share the same shape: pull rich data from many systems, reason across it, and present a grounded narrative to a human operator.

This phase is the realization of the project's longer-term vision. It will only be undertaken when the foundations are strong enough that new domains can be added without weakening what came before.

## What is not on the roadmap

The roadmap deliberately omits items that the project has decided not to pursue, even if they are common in adjacent products. These include destructive remediation actions, hosted multi-tenant deployments, real-time alerting, and multi-cloud coverage. They are recorded in the [goals](goals.md) document under non-goals.

## How the roadmap is meant to be used

This document is a planning aid, not a commitment. Changes to the roadmap should be expected as the project learns. The intent is that anyone reading the roadmap can answer two questions: where the project is now, and what the next sensible step looks like. If a proposed piece of work cannot be placed against the phases above, that is a signal worth examining before the work begins.
