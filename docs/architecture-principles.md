# Architecture principles

This document describes the philosophy that will shape Az-Pixiu's architecture. It deliberately avoids specific implementation choices — frameworks, languages, file layouts, and component boundaries belong in later, more detailed documents. The principles below are intended to outlast any of those decisions.

## Local-first

Az-Pixiu is designed to run where its operator chooses to run it, not in a hosted environment owned by the project. Sensitive telemetry, credentials, and Azure responses should remain within the environment the operator controls. Hosted services are an option for an operator, not a requirement for the agent.

## Read-only by default

The agent reads from Azure and writes to its own state. It does not modify Azure resources. This boundary is part of the project's design contract with its operators and is expected to remain stable even as capabilities grow.

## Observable by construction

Every meaningful step the agent takes should be traceable. The project treats observability of AI behavior as a first-class concern: it should be possible to inspect what the agent did, why, with what inputs, against which prompt version, and with what evidence. Observability is not retrofitted; it is part of the design from the beginning.

## Evidence over assertion

Recommendations should be accompanied by the data that justifies them. The agent is expected to cite the resources, time windows, and metrics it relied on. A recommendation that cannot be traced back to evidence is treated as a defect, not as a feature.

## Modular components with stable contracts

The project will be composed of clearly separated concerns: data acquisition, reasoning, evaluation, presentation, and observability. Each concern should be replaceable without forcing changes elsewhere. The contracts between components matter more than the components themselves; they are what allow the project to evolve without rewrites.

## Protocol-driven integration

External systems are reached through well-defined protocols, with the Model Context Protocol playing a central role at the Azure boundary. The project favors integration points that are documented, versioned, and reusable by other tools over bespoke client code. The reasoning behind this position is expanded in the [AMG-MCP positioning](amg-mcp-positioning.md) document.

## AI as a participant, not an oracle

The agent is one collaborator in a workflow that includes humans, dashboards, and existing tooling. It should be possible to disagree with the agent, override it, or ignore it without breaking anything. Outputs should be structured to support review rather than to demand trust.

## Reversible decisions over premature commitments

Where the project has not yet learned enough to choose well, it will defer. Concrete decisions about model providers, storage layers, packaging, and deployment will be made when the project has enough information to make them well, and revisited when that information changes. Reversibility is more valuable than early certainty.

## Extensibility through composition

The project's intended growth path — from FinOps into broader cloud operations analysis — depends on being composable rather than monolithic. New capabilities should be expressible as additional components that participate in the same observability and evaluation surfaces, not as parallel agents that diverge from the shared substrate.

## Operator transparency

The operator running the agent should be able to understand what it will do before it runs and what it did after it ran. This applies to data access, model usage, prompt content, and output structure. The project does not aim to be magical; it aims to be legible.

## A short note on what is not here

This document does not prescribe a language, a framework, a model provider, a storage system, a deployment topology, or a user interface. Those decisions are deferred. When they are made, they will be made in documents that are easier to revise than this one, and they will be expected to honor the principles recorded here.
