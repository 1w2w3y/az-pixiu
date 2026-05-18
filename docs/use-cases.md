# Use cases

This document describes the scenarios Az-Pixiu is intended to support. It is meant to ground design discussions in concrete situations and to make it easier to evaluate whether a proposed feature is in scope.

The scenarios below are written from the perspective of the people who might run the agent. They do not prescribe specific user interfaces or workflows. They are listed in roughly the order in which the project expects to address them.

## Investigating a cost surprise

A FinOps engineer notices that one subscription's monthly spend rose sharply against trend. They want to understand what changed: which resource groups, which services, which time windows, and whether the rise correlates with deployments or traffic events visible in Azure Monitor.

Az-Pixiu should be able to gather the relevant cost and telemetry data, surface the most likely contributors, and provide a starting set of hypotheses with the evidence to evaluate each one.

## Finding idle and underused resources

A platform engineer is reviewing a long-lived subscription that has accumulated resources over many years. They want a list of resources that appear unused, underused, or oversized relative to their telemetry, along with enough context to confirm the assessment before recommending any change.

Az-Pixiu should be able to identify candidates across common resource types and explain, per candidate, the signals that led it to flag them.

## Preparing for a quarterly cost review

An engineering manager prepares for a cross-team cost review and wants a structured summary of where money is going, what the largest changes were quarter over quarter, and which optimization opportunities are most likely to be worth pursuing.

Az-Pixiu should be able to produce a coherent report grounded in actual data, suitable as a starting point for a human-written narrative.

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
