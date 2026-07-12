# Use cases

This document describes the scenarios Az-Pixiu is intended to support. It is meant to ground design discussions in concrete situations and to make it easier to evaluate whether a proposed feature is in scope.

The scenarios below are written from the perspective of the people who might run the agent. They do not prescribe specific user interfaces or workflows. They are listed in roughly the order in which the project expects to address them.

## Investigating a cost surprise

A FinOps engineer notices that one subscription's monthly spend rose sharply against trend. They want to understand what changed: which resource groups, which services, which time windows, and whether the rise correlates with deployments or traffic events visible in Azure Monitor.

Az-Pixiu should be able to gather the relevant cost and telemetry data, surface the most likely contributors, and provide a starting set of hypotheses with the evidence to evaluate each one.

A related variant of this scenario is broader: a team lead sweeps every subscription owned by their team for recent cost anomalies rather than investigating a known one. The same analysis must therefore accept a name-pattern selection over the visible subscriptions, not only an explicit subscription identifier.

## Finding idle and underused resources

A platform engineer is reviewing a long-lived subscription that has accumulated resources over many years. They want a list of resources that appear unused, underused, or oversized relative to their telemetry, along with enough context to confirm the assessment before recommending any change.

Az-Pixiu should be able to identify candidates across common resource types and explain, per candidate, the signals that led it to flag them.

## Preparing for a quarterly cost review

An engineering manager prepares for a cross-team cost review and wants a structured summary of where money is going, what the largest changes were quarter over quarter, and which optimization opportunities are most likely to be worth pursuing.

Az-Pixiu should be able to produce a coherent report grounded in actual data, suitable as a starting point for a human-written narrative.

The review must keep three different quantities separate: cost observed in the billing evidence, list-price exposure estimated from a rate card, and savings that could actually be realized after discounts, meter attribution, resource age, and operational constraints are checked. A high-cost service is not by itself evidence that its resources are underused, and a list-price exposure range is not a savings commitment.

The scope of a cost review is often defined by naming convention rather than by enumerating subscription identifiers — for example, every subscription belonging to a business unit, every production-tier subscription, or every subscription owned by a particular team. Az-Pixiu should support selecting the in-scope subscriptions by a case-insensitive name pattern wherever subscriptions are auto-discovered, so the operator does not have to look up identifiers before running the analysis. The matched subscriptions must be echoed back as part of the effective scope before analysis begins.

## Running a recurring cleanup review

A platform team treats Azure waste as a backlog rather than a one-time scan. Once a week, the same scope is reviewed for orphaned IPs, unattached disks, stopped or failed clusters, "restored-*" database servers left behind by experiments, and unused container registries. Some items are cleaned up between runs; others persist. The team wants to know which candidates have not moved in N weeks (so they can escalate ownership), which clusters of similarly-named resources have recurred from a prior incident (so the root cause can be addressed instead of the symptom), and whether this week's totals look real or are likely a billing-API freshness artifact.

Az-Pixiu should be able to recognize the recurring shape of this work. A single run should produce a waste-candidates section grounded in evidence and calibrated weekly impact estimates. Across runs against the same scope, the agent should mark candidates as unchanged for N weeks, flag recurring naming patterns from prior runs, and identify recommendations that are carrying forward versus newly discovered. The continuity of the workflow is itself a signal: a backlog that does not change is qualitatively different from one that is being worked.

When structural candidate exposure and observed billed cost disagree, the report should preserve both values, explain that the rate-card figure is a review ceiling rather than realized savings, and make reconciliation part of the human validation path.

This use case is distinct from the quarterly cost review above: the quarterly review summarizes spend and lifecycle for a stakeholder narrative; the recurring cleanup review tracks an operational backlog that the platform team owns and works against between runs. The two share the same `cost-summary` analyzer surface but produce different report content.

## Correlating cost with reliability and performance

A site reliability engineer suspects that recent reliability work — added redundancy, larger SKUs, more aggressive autoscaling — has shifted the cost profile of a service. They want a view that places spend changes alongside telemetry changes for the same components.

Az-Pixiu should be able to ground a cost narrative in operational telemetry, treating cost as one signal among several rather than as an isolated concern.

## Auditing tagging and ownership hygiene

A platform team responsible for governance wants to understand how much spend lives under resources without clear ownership, environment, or cost-center tags, and where the biggest gaps are. They want this as an input to a tagging-improvement effort, not as a one-off lookup.

Az-Pixiu should be able to summarize tagging coverage and connect gaps to the cost they represent, so the team can prioritize remediation against impact rather than count.

## Building AI observability intuition

A developer who is learning how to instrument and evaluate AI systems wants a non-trivial, realistic project to study. They want to see how a working agent uses Langfuse for tracing, how it is evaluated against curated datasets, how its prompts are managed and versioned, and how experiments are run on real workloads.

Az-Pixiu is intended to be that project. The codebase, the Langfuse configuration, and the evaluation artifacts should all be readable as teaching material in addition to being functional.

## Exploring MCP-based agent architectures

An engineer evaluating the Model Context Protocol wants to see what a non-trivial agent looks like when built on top of an MCP server rather than directly against vendor SDKs. They are interested in the trade-offs and in how MCP shapes the design of the surrounding agent.

Az-Pixiu's use of AMG-MCP is intended to make these trade-offs visible in practice. The [AMG-MCP positioning](amg-mcp-positioning.md) document complements this use case. The [AMG-MCP capabilities](amg-mcp-capabilities.md) document records which capabilities the agent is expected to draw on for each scenario above.

## Out of scope

The following scenarios are explicitly outside the project's current focus:

- Acting on recommendations automatically by modifying Azure resources.
- Forecasting future spend at a level of rigor that would justify finance decisions.
- Serving as a real-time alerting system or incident response tool.
- Acting as a multi-cloud cost management product covering AWS, GCP, or other providers.
- Replacing Azure Cost Management, Grafana, or other tools the operator already uses.

These boundaries may be revisited as the project matures, but they should not be assumed to be on the path.
