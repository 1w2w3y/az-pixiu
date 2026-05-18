# Goals and non-goals

Distinguishing goals from non-goals early makes it easier to evaluate proposed changes and to resist scope drift. This document records both at a level of detail appropriate for the project's earliest stage. Both lists are expected to be revisited as the project matures, but they should not be expanded casually.

## Goals

### Build a working Azure FinOps agent

Az-Pixiu should be able to connect to a real Azure environment, gather the data necessary to reason about spending, and produce concrete optimization recommendations that an engineer would consider acting on. The agent should be useful enough that the people building it would willingly run it against their own subscriptions.

### Demonstrate Langfuse capabilities end to end

The project intends to exercise the Langfuse feature set in a realistic context, not as isolated examples. Tracing, evaluations, datasets, prompt management, experiments, scoring, and OpenTelemetry integration should each have a clear role in how the agent is developed and operated. The [Langfuse learning goals](langfuse-learning-goals.md) document expands on what this looks like in practice.

### Treat AMG-MCP as a first-class integration point

The Azure Managed Grafana MCP server is the agent's primary boundary with Azure. The project is meant to show what it looks like to build an agent on top of a Model Context Protocol server rather than directly against cloud SDKs. The [AMG-MCP positioning](amg-mcp-positioning.md) document explains the reasoning behind this choice.

### Be honest about uncertainty

The agent's outputs should be paired with the evidence used to produce them. Recommendations should be reviewable. Confidence should be expressed in calibrated terms rather than asserted. The project should make it easier, not harder, for an operator to disagree with the agent.

### Be a clear reference for other engineers

The codebase, documentation, and evaluation artifacts should be readable by an engineer who has not seen the project before. Choices should be motivated. Trade-offs should be named. The project should be useful to read even by people who never run it.

### Stay extensible toward broader cloud operations

The project's initial scope is Azure FinOps, but the architecture and operational patterns should not foreclose the possibility of extending into adjacent domains such as reliability investigation or capacity planning. Extensibility is a goal in the sense that decisions which would close off this direction should be avoided.

## Non-goals

### Replace human FinOps practitioners

Az-Pixiu is not a substitute for the judgement of an engineer or finance partner who understands their organization's context. The agent will not own decisions; it will surface, structure, and explain.

### Become a hosted service or commercial product

The project is intentionally a local tool and an open-source learning artifact. There is no roadmap toward a hosted offering, a paid tier, or a managed service. Anyone is free to build such a thing on top of the work, but the upstream project will not.

### Take destructive actions on Azure resources

The agent is read-only by design. It will not delete, scale, modify, or otherwise mutate Azure resources. Any change that would alter a customer environment is left to the human operator, who may use the agent's recommendations as input to their own tooling.

### Cover every Azure service from day one

The initial scope is deliberately bounded to the services most relevant to common cost optimization scenarios. Coverage will expand as the project matures, guided by concrete use cases rather than by completeness for its own sake.

### Generalize prematurely

The project is interested in patterns that generalize across cloud providers and operational domains, but it will not abstract for the sake of it. Generalization will follow concrete second and third use cases rather than anticipate them.

### Be production-ready in its early phases

Az-Pixiu starts as an exploratory project. It will harden over time, but documentation, packaging, and deployment maturity should not be confused with project status. Early users should expect to read the source.

### Compete with existing FinOps or observability products

The project is not positioning itself against Azure Cost Management, third-party FinOps suites, or general-purpose observability vendors. It is an exploration of a different shape of tool — local, AI-driven, observability-first — and is meant to complement rather than substitute for those products.
