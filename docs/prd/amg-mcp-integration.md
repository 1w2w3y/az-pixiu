# AMG-MCP Integration PRD

## Overview

AMG-MCP is the primary protocol boundary between Az-Pixiu and Azure operational data. The integration must allow the agent to discover and use Azure cost, resource, and telemetry capabilities through a Model Context Protocol server rather than building a bespoke Azure SDK surface inside the agent.

This PRD defines the product requirements for that boundary. It focuses on capability expectations, trust, error handling, evidence provenance, and enterprise review concerns. It does not prescribe client libraries, transports, or implementation structure. A snapshot of the capabilities AMG-MCP currently exposes — and how they map to Az-Pixiu's use cases — lives separately in [AMG-MCP capabilities](../amg-mcp-capabilities.md).

The integration should make Az-Pixiu a strong example of an MCP-based operational agent: the agent asks for the right evidence, the server exposes data access capabilities in a controlled shape, and every interaction is traceable.

## Current Implementation Status

The current integration uses `MCPTransport` with live and fixture implementations, discovers capabilities before analysis, asserts required read-only capabilities, and rejects mutating capabilities from the allowed operating set. Deterministic playbooks use the discovered live parameter contracts for Cost Analysis, Activity Log, and ARG rather than internal scope field names. Evidence retrieval records per-request transport summaries, classifies user-meaningful failures, retries `rate_limit` and `timeout` categories with capped backoff and pacing, and detects protocol-level or payload-embedded `amgmcp_cost_analysis` 429/auth/authz/schema-mismatch failures before they can become false-success evidence. Fixture replay remains the default path for tests and evals, with response digests keyed from the same live parameter shapes.

## Problem Statement

Cloud agents can become tightly coupled to vendor APIs when each agent implements authentication, query construction, paging, retries, and resource-specific data mapping for itself. That approach makes agents hard to audit, hard to extend, and difficult to compare across teams.

Az-Pixiu intentionally uses AMG-MCP as the Azure boundary so that Azure data access is protocol-driven, discoverable, and reusable. The product challenge is to make this boundary strong enough for serious FinOps analysis without letting the agent silently depend on undocumented assumptions or arbitrary direct Azure access.

The integration must also handle the reality of enterprise Azure environments: partial permissions, inconsistent resource metadata, large subscriptions, rate limits, changing server capabilities, and sensitive telemetry.

## Goals

- Treat AMG-MCP as the first-class Azure integration surface for Az-Pixiu.
- Support discovery of available tools, resources, prompts, and server capabilities relevant to FinOps analysis.
- Retrieve cost, resource metadata, and telemetry evidence needed for core agent scenarios.
- Preserve provenance for all evidence returned across the MCP boundary.
- Make permission, capability, schema, and data availability issues visible to users and evaluators.
- Keep the agent read-only with respect to Azure resources.
- Provide a stable enough integration contract for testing, replay, tracing, and future agents.

## Non-Goals

- The integration will not bypass AMG-MCP with direct Azure SDK calls for convenience without an explicit, documented exception.
- The integration will not require AMG-MCP to expose every Azure service before Az-Pixiu is useful.
- The integration will not mutate Azure resources or request write permissions for optimization actions.
- This PRD does not define AMG-MCP's internal implementation.
- The integration will not hide server capability gaps behind fabricated or inferred data.
- The integration will not make Az-Pixiu dependent on a single deployment topology for AMG-MCP.

## Personas

- Az-Pixiu operator: Needs to connect to Azure data through a controlled and understandable boundary.
- Platform engineer: Reviews what capabilities the agent can access and what permissions are required.
- AMG-MCP contributor: Needs clear feedback about capability gaps that limit agent usefulness.
- Agent maintainer: Needs predictable tool semantics, schemas, and failure modes.
- Enterprise security reviewer: Needs assurance that access is read-only, auditable, and scoped.

## User Journeys

### Establish an Analysis Boundary

An operator configures Az-Pixiu to use an AMG-MCP server. The agent discovers available capabilities and reports whether the server can support the requested analysis. If required capabilities are missing, the agent explains the limitation before attempting unsupported work.

### Retrieve Evidence for a Cost Investigation

The core agent requests cost, resource metadata, and relevant telemetry for a subscription and time window. AMG-MCP returns structured evidence with provenance. The agent uses this evidence to form recommendations and records the MCP interactions in observability traces.

### Handle Partial Permissions

An enterprise operator has access to cost data but limited access to certain telemetry or resource groups. The agent still produces bounded analysis where possible, but clearly identifies inaccessible data and how those gaps affect confidence.

### Adapt to Server Capability Changes

AMG-MCP adds a new capability or changes a schema version. Az-Pixiu detects the available capability set and either uses the new capability through a stable contract or reports incompatibility in a way that can be tested and documented.

## Functional Requirements

- FR-1: Az-Pixiu must use AMG-MCP as the default and preferred boundary for Azure cost, resource, and telemetry retrieval.
- FR-2: The agent must discover available AMG-MCP capabilities before relying on them for an analysis.
- FR-3: The integration must expose whether required capabilities for a requested analysis are available, unavailable, partially available, or failed.
- FR-4: The integration must support evidence retrieval for core scenarios: cost trend analysis, service and resource breakdowns, resource metadata, tagging information, utilization telemetry, operational metrics needed for cost correlation, management-plane history (such as Activity Log events) used to explain what changed, and resource availability transitions where they affect cost interpretation.
- FR-5: Every result used by the agent must carry provenance sufficient to identify source capability, query intent, scope, time window, and data freshness.
- FR-6: The integration must classify failures in user-meaningful terms, such as authentication failure, authorization gap, unsupported capability, invalid scope, timeout, rate limit, schema mismatch, and empty result.
- FR-7: The agent must include MCP interaction summaries in observability traces, including capability names, request purpose, status, latency, and data volume indicators.
- FR-8: The integration must make read-only assumptions explicit. Any capability that could mutate Azure state — or modify the broader operational environment that the MCP server controls, such as Grafana dashboards — must be rejected or excluded from the agent's allowed operating set.
- FR-9: The integration must support bounded analysis when some data is unavailable, provided the output clearly reflects reduced confidence.
- FR-10: The integration must avoid treating stale, partial, or aggregated data as exact without caveats.
- FR-11: The agent must not infer unsupported server capabilities from natural-language descriptions alone; capability use must be grounded in discovered MCP metadata or documented contracts.
- FR-12: The integration must support replay or fixture-based testing of representative MCP responses for evaluations and regression analysis.
- FR-13: Capability gaps that block useful analysis must be captured as product feedback, not buried in generic errors.
- FR-14: The integration must be compatible with future non-FinOps Azure operational agents that need the same protocol boundary.
- FR-15: The integration should support a local usage-stable full-month billing cache for Cost Management evidence retrieved through AMG-MCP. Cached records must preserve AMG-MCP provenance, must not be written for current or not-yet-stabilized billing periods, must not be described as invoice-finalized without an invoice-backed signal, and must be disclosed as cached evidence in reports and traces.

## Non-Functional Requirements

- Auditability: MCP interactions must be visible in traces and reviewable after a run.
- Security: The integration must operate with least-privilege, read-only access appropriate for cost and telemetry analysis.
- Resilience: Timeouts, rate limits, and partial responses must degrade into clear output rather than incorrect recommendations.
- Compatibility: The integration should tolerate additive server capabilities and clearly report incompatible changes.
- Performance: The agent should minimize unnecessary data retrieval and communicate when broad scopes may produce long-running analysis.
- Back-pressure awareness: AMG-MCP and the Azure APIs it fronts apply their own rate limits — for example, the Cost Management QPU budget and the ARM token bucket throttling documented in the server's built-in scanner. The agent should plan query patterns that respect these limits, such as serializing across subscriptions where the budget is uncertain, batching metric queries when the underlying tool supports it, and scoping scans deliberately, rather than fanning out blindly and relying on retries to recover.
- Cache correctness: Local billing-cache reads must be limited to usage-stable full-month periods and must never cause the agent to present recent, partial, or merely usage-stable Cost Management data as invoice-finalized.
- Privacy: Retrieved evidence should be minimized to what the analysis requires and handled according to the local-first product posture.
- Testability: Representative MCP responses should be usable in datasets and evaluation fixtures without requiring live Azure access.
- Legibility: Operators should understand what Azure data categories are accessed for each analysis type.

## Risks

- AMG-MCP may not initially expose all data needed for high-quality FinOps recommendations.
- Capability schemas may evolve while the MCP ecosystem matures.
- Large subscriptions may create performance, pagination, or data-volume challenges.
- Permission gaps may be common in enterprise environments and could reduce recommendation quality.
- The agent may accidentally become coupled to a specific server behavior rather than the protocol contract.
- Users may expect AMG-MCP to imply data completeness when the server only exposes a subset of Azure signals.
- Pressure to bypass AMG-MCP could weaken the architectural boundary if not governed carefully.
- Built-in MCP capabilities — such as the server's `pulse_check` health scanner — may duplicate or compete with agent-side reasoning for the same scenarios. Choosing the wrong boundary could either leak server-side logic into the agent or fragment what should be a coherent analysis.

## Open Questions

- What AMG-MCP capabilities are required for the first minimum viable FinOps analysis?
- How should Az-Pixiu represent server capability versions in traces and evaluations?
- What is the acceptable behavior when cost data is available but utilization telemetry is missing?
- Which Azure identity and permission assumptions should be documented for enterprise operators?
- How should fixture data be sanitized while preserving realistic failure modes?
- What process should be used to propose upstream AMG-MCP enhancements discovered through Az-Pixiu?
- Are there specific categories of data that should never be captured in Langfuse traces even if returned by AMG-MCP?
- How should Az-Pixiu relate to AMG-MCP's built-in operational scanner (`pulse_check`), which already implements multi-resource health scenarios that overlap with the core agent's idle and underused resource review? The agent could wrap it, compose around it, or duplicate it; each option carries different implications for evidence shape, observability, and the boundary between MCP-server logic and agent logic.

## Future Considerations

- Contribute capability feedback upstream to AMG-MCP as Az-Pixiu discovers missing FinOps needs.
- Support additional MCP servers for adjacent operational domains while preserving a common integration contract.
- Add richer capability compatibility checks for future agent families.
- Support operator-facing data access summaries before each run.
- Develop sanitized fixture libraries based on realistic MCP responses for public evaluations.
- Explore shared governance patterns for MCP tool allowlists in enterprise deployments.
- Complete the usage-stable-month billing cache described in [local billing cache](../design/local-billing-cache.md), including cache warm/status CLI workflows and detailed report disclosure.

## Success Criteria

- Az-Pixiu can perform its core FinOps analyses through AMG-MCP without direct Azure SDK dependence.
- Operators can see which capabilities were used and what data gaps affected the output.
- Permission and capability failures produce clear, actionable explanations.
- MCP interactions are consistently represented in Langfuse traces and evaluation artifacts.
- The integration remains read-only and auditable.
- Capability gaps become visible roadmap inputs for Az-Pixiu and AMG-MCP rather than hidden defects.
