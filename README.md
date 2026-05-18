# Az-Pixiu

Az-Pixiu is a local, AI-powered Azure FinOps agent. It connects to Azure environments through the Azure Managed Grafana MCP server (AMG-MCP), gathers cost, resource, and telemetry signals, and produces actionable optimization recommendations.

The project is named after the Pixiu (貔貅), a creature in Chinese mythology associated with attracting and protecting wealth — a fitting metaphor for a tool focused on understanding and reducing cloud spend.

## What it does

Az-Pixiu is intended to:

- Connect to one or more Azure subscriptions through AMG-MCP.
- Collect and reason over cost, resource configuration, and telemetry data.
- Identify likely sources of waste and concrete optimization opportunities.
- Generate human-readable recommendations supported by the evidence used to produce them.
- Record every step of its reasoning so that recommendations can be reviewed, audited, and evaluated.

The agent is designed to run locally. Sensitive cloud telemetry stays inside the environment in which the agent runs.

## Why it exists

Az-Pixiu has two intertwined purposes.

First, it aims to be a genuinely useful tool for engineers and operators who want to understand Azure spending without manually navigating Cost Management, Azure Monitor, Resource Graph, and Grafana dashboards.

Second, it is an open exploration of AI observability. The project is intentionally built on top of Langfuse so that tracing, evaluations, datasets, prompt management, and experiments are first-class concerns rather than afterthoughts. The project is meant to make these capabilities legible to other engineers learning how to build observable AI systems.

## Project status

Az-Pixiu is in its earliest stage. This repository currently contains foundational documentation only. No implementation has been written. See the [roadmap](docs/roadmap.md) for the intended direction of travel.

## Documentation

- [Vision](docs/vision.md) — the long-term direction of the project.
- [Goals and non-goals](docs/goals.md) — what is and is not in scope.
- [Architecture principles](docs/architecture-principles.md) — the philosophy that will shape the system.
- [Use cases](docs/use-cases.md) — the scenarios the agent is intended to support.
- [Roadmap](docs/roadmap.md) — the phased plan for the project.
- [Langfuse learning goals](docs/langfuse-learning-goals.md) — the Langfuse capabilities the project intends to demonstrate.
- [AMG-MCP positioning](docs/amg-mcp-positioning.md) — why AMG-MCP sits at the boundary between the agent and Azure.

## Product requirements

- [Core agent PRD](docs/prd/core-agent.md) — the core Azure cost analysis AI agent.
- [Langfuse observability PRD](docs/prd/langfuse-observability.md) — telemetry, tracing, evaluations, experiments, and observability requirements.
- [AMG-MCP integration PRD](docs/prd/amg-mcp-integration.md) — requirements for the MCP integration boundary.
- [Reporting and recommendations PRD](docs/prd/reporting-and-recommendations.md) — requirements for reports and optimization suggestions.
- [Evaluation framework PRD](docs/prd/evaluation-framework.md) — requirements for evaluation datasets and quality measurement.
- [CLI experience PRD](docs/prd/cli-experience.md) — command-line and local developer experience requirements.
- [Future multi-agent platform PRD](docs/prd/future-multi-agent-platform.md) — long-term vision for multiple Azure operational agents.

## Audience

The project is written for two audiences at once. The first is engineers and operators who would use a local Azure FinOps agent to understand their own subscription spending. The second is engineers learning how to build, instrument, and evaluate AI systems in a disciplined way. The documentation, the codebase, and the evaluation artifacts are intended to serve both.

## License

MIT. See [LICENSE](LICENSE).
