# CLI Experience PRD

## Overview

The Az-Pixiu CLI is the primary local developer and operator experience for the project. It should let an enterprise engineer run Azure FinOps analyses from a controlled environment, understand what the agent will access, inspect outputs, and connect runs to observability and evaluation workflows.

The CLI is not a chat shell for arbitrary cloud questions. It is a command-oriented interface for scoped operational intelligence tasks: analyze a cost surprise, find underused resources, review tagging hygiene, produce a report, run evaluations, and inspect observability-linked run artifacts.

The experience should feel familiar to engineers who use Azure, Grafana, local development tools, and version-controlled review workflows.

## Current Implementation Status

The CLI currently exposes `pixiu analyze cost-surprise`, `pixiu analyze cost-summary`, `pixiu eval <dataset.json>`, and `pixiu diagnose`. Analyze supports explicit subscriptions, auto-discovery by top resource count, subscription-name filtering, time windows, resource groups, resource type filters, fixture replay, playbook mode, mock model mode, output directory selection, observability modes (`noop`, `memory`, `langfuse`, `ms-otel`), credential modes, and billing-access probes with cache. Eval supports fixture-root and output-dir overrides, offline mock runs, Langfuse publishing, dataset/experiment naming, and model sweeps. It does not currently include `review`, `calibrate`, interactive follow-up, or package-managed installation workflows.

## Problem Statement

Az-Pixiu is intentionally local-first. Without a thoughtful CLI, local-first can become difficult to operate: users may not know what configuration is required, what data will be accessed, why a run failed, where output went, or how to reproduce an analysis.

Enterprise users also need clear boundaries. A local agent that asks for broad credentials and produces opaque output will not be trusted. The CLI must make scope, read-only behavior, data access, observability, and result locations explicit.

The project needs a CLI that supports serious engineering use while staying small enough for an early-stage open-source project.

## Goals

- Provide a clear local entry point for running Az-Pixiu analyses.
- Make analysis scope, data access, and read-only behavior visible before or during execution.
- Produce Markdown reports and structured run artifacts suitable for review and evaluation.
- Support Langfuse-connected traces, experiments, and evaluations as normal developer workflows.
- Help users diagnose configuration, AMG-MCP connectivity, permission, and data availability issues.
- Keep the interface task-oriented rather than chatbot-oriented.
- Support enterprise developers who expect scriptable, reproducible command behavior.

## Non-Goals

- The initial CLI will not be a full graphical user interface.
- The CLI will not provide an unrestricted interactive chat mode as the primary experience.
- The CLI will not perform Azure remediation actions.
- The CLI will not hide credential, scope, or data-access assumptions for convenience.
- The first version will not cover every possible report workflow or deployment environment.
- The CLI will not require a hosted Az-Pixiu service.

## Personas

- Local operator: Runs the agent against an Azure scope from a workstation or controlled environment.
- Platform engineer: Wants repeatable commands for subscription or resource-group analysis.
- Maintainer: Runs evaluations, experiments, and regression checks during development.
- Enterprise security reviewer: Wants a clear view of configuration, data access, and local artifacts.
- New contributor: Needs quick feedback that the project is configured correctly.

## User Journeys

### First Local Run

A new user installs project prerequisites, configures access to AMG-MCP and Langfuse as desired, and runs a narrow analysis against a known Azure scope. The CLI checks configuration, reports missing dependencies or permissions clearly, and writes a report with trace identifiers.

### Run a Scoped Cost Analysis

A FinOps engineer runs a command for a specific subscription, resource group, and time window. The CLI confirms the effective scope, performs the analysis, streams meaningful progress, and produces a report plus structured metadata.

### Diagnose Connectivity

A platform engineer suspects the AMG-MCP server is not reachable or lacks required capabilities. The CLI runs a diagnostic workflow that reports connectivity, discovered capabilities, read-only assumptions, and missing requirements.

### Run Evaluations During Development

A maintainer changes a prompt or analysis behavior and runs evaluations from the CLI. The command records Langfuse experiment metadata, compares against a baseline, and reports quality changes in a concise local summary.

## Functional Requirements

- FR-1: The CLI must expose task-oriented commands for core analysis scenarios rather than relying on arbitrary natural-language chat.
- FR-2: The CLI must accept explicit scope inputs such as subscription, resource group, time window, baseline period, and analysis type where applicable.
- FR-3: The CLI must show the effective analysis scope before producing recommendations.
- FR-4: The CLI must provide configuration diagnostics for AMG-MCP connectivity, capability availability, Langfuse configuration, and local output paths.
- FR-5: The CLI must clearly state that Az-Pixiu is read-only with respect to Azure resources.
- FR-6: The CLI must produce Markdown reports for human review.
- FR-7: The CLI must produce structured run metadata that links reports to traces, prompts, datasets, evaluations, and experiment variants where relevant.
- FR-8: The CLI must present progress in a way that helps users understand major phases, such as capability discovery, evidence retrieval, analysis, report generation, and observability recording.
- FR-9: The CLI must distinguish configuration errors, authentication errors, authorization gaps, unsupported capabilities, data absence, and agent-quality failures.
- FR-10: The CLI must support non-interactive operation suitable for scripts and repeatable local workflows.
- FR-11: The CLI must support a safe way to preview or summarize intended data access for a run.
- FR-12: The CLI must support evaluation and experiment workflows for maintainers without requiring separate bespoke scripts.
- FR-13: The CLI must provide clear exit statuses for success, partial success, configuration failure, analysis failure, and evaluation failure.
- FR-14: The CLI must avoid logging secrets, credentials, or unnecessary raw Azure telemetry to terminal output.
- FR-15: The CLI should make it easy to find the generated report, trace identifier, and diagnostic summary after a run.
- FR-16: For analysis types that auto-discover subscriptions, the CLI must support selecting subscriptions by case-insensitive name pattern, in addition to explicit subscription identifiers and the default top-N-by-resource-count auto-discovery. The pattern must be matched against subscription display names as returned by AMG-MCP. The CLI must reject patterns combined with explicit subscription identifiers and must surface the matched subscriptions in the effective scope summary before analysis.

## Non-Functional Requirements

- Predictability: Commands should behave consistently and be safe to script.
- Transparency: Users should understand what scope is being analyzed and which external systems are involved.
- Security: The CLI must handle credentials and sensitive telemetry carefully and avoid accidental disclosure in logs.
- Usability: Error messages should be specific enough for engineers to fix configuration or permission issues.
- Portability: The local experience should not assume a single enterprise environment or hosted control plane.
- Observability: CLI runs must be connected to the same trace and evaluation model as other entry points.
- Performance feedback: Long-running operations should provide meaningful progress without noisy output.
- Documentation fit: The CLI should reinforce the project's reference-quality documentation and learning goals.

## Risks

- A too-flexible CLI may drift into generic chatbot behavior.
- A too-rigid CLI may make early exploration cumbersome.
- Configuration requirements for Azure, AMG-MCP, Langfuse, and model access may overwhelm first-time users.
- Poor error classification may cause users to distrust the agent when the real issue is permissions or missing data.
- Terminal output may accidentally expose sensitive resource names, costs, or tags.
- Evaluation commands may become detached from normal developer workflow if they are hard to run.
- Scriptability may conflict with interactive safety confirmations if not designed carefully.
- Name-pattern subscription selection may unintentionally widen scope if the operator's naming convention is ambiguous, or quietly drop subscriptions whose display names AMG-MCP cannot resolve. The CLI must always echo the matched subscriptions before running, and a no-match outcome must fail loudly rather than silently degrade.

## Open Questions

- What are the minimum commands required for the first usable release?
- Which configuration values should be explicit command flags versus environment or config-file settings?
- What default output directory and artifact layout will be easiest for local review?
- How much interactive confirmation is appropriate before a read-only analysis run?
- Should the CLI support a constrained follow-up question mode after a report is generated?
- What diagnostic output is safe by default for enterprise terminals and CI logs?
- How should CLI commands map to Langfuse experiment names and evaluation runs?

## Future Considerations

- Add a constrained interactive review mode for asking follow-up questions against a completed report and evidence set.
- Add richer local artifact browsing once report and trace formats stabilize.
- Support organization-specific profiles for common scopes, tagging policies, and output conventions.
- Add CI-friendly evaluation workflows for contributors.
- Support package-managed installation after early project structure stabilizes.
- Reuse the CLI command model for future reliability, capacity, and security posture agents.
- Explore optional integration with editor or notebook workflows after the core CLI is stable.

## Success Criteria

- A new technical user can configure and run a narrow local analysis with clear feedback.
- Users can see exactly what scope was analyzed and where the report and trace are recorded.
- The CLI supports repeatable, non-interactive analysis runs for enterprise workflows.
- Configuration and permission failures are clear enough to diagnose without reading source code.
- Evaluation and experiment commands become part of normal maintainer workflow.
- The CLI reinforces Az-Pixiu's identity as a local Azure operational intelligence agent, not a generic chatbot.
