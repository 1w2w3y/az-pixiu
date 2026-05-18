# AMG-MCP positioning

This document explains why Az-Pixiu uses the Azure Managed Grafana MCP server (AMG-MCP) as its primary boundary with Azure, and how that choice shapes the agent's architecture. It is a position document, not an implementation guide; it argues for a design decision rather than describing how to wire it up.

## What AMG-MCP is

The Model Context Protocol is a specification that defines how AI agents discover and use external capabilities through a standard server interface. An MCP server exposes tools, resources, and prompts in a uniform shape, regardless of what those things connect to underneath.

Azure Managed Grafana's MCP server brings the Azure observability and resource surface that Grafana already integrates with into that uniform shape. Cost data, resource metadata, and telemetry that an engineer might today retrieve through Grafana dashboards or directly through Azure APIs become consumable by an agent through a single, documented protocol.

## Why a protocol boundary matters

The most direct way to build a cloud agent is to call vendor SDKs from inside the agent process. That approach works, and many agents are built this way. It has costs that compound over time.

Vendor SDKs evolve at their own pace. Each new capability requires custom integration code inside every agent that wants to use it. Authentication, retries, pagination, and rate limiting are reimplemented per agent. Different agents end up with subtly different views of the same underlying data, depending on which calls each one happened to make.

A protocol-based boundary inverts this. The agent learns to speak one protocol. The capabilities behind that protocol can grow without the agent having to grow with them. Other agents — written in different languages, built by different teams, for different purposes — can share the same boundary and the same data shape.

For a project whose long-term direction is to extend beyond FinOps into broader cloud operations analysis, this kind of boundary is structural. It is what makes future agents related to Az-Pixiu rather than parallel to it.

## Why Azure Managed Grafana specifically

Grafana is already a focal point for many Azure operators. Dashboards, data sources, and query patterns built around Grafana represent operational knowledge that has been refined over years. An MCP server that fronts that ecosystem inherits much of that refinement.

Using AMG-MCP means Az-Pixiu does not need to rebuild a separate view of Azure. It can consume the same kinds of signals that a human operator would consume through Grafana, but in a shape designed for programmatic reasoning. This keeps the agent's mental model close to the operator's mental model, which makes its outputs easier to review and trust.

The choice also reduces duplication. Improvements to AMG-MCP — new tools, better authentication flows, broader resource coverage — benefit Az-Pixiu without changes inside the agent. Improvements Az-Pixiu would otherwise drive into a bespoke Azure client can instead be proposed upstream, where they benefit the wider ecosystem.

## How this shapes the agent

Adopting AMG-MCP as the boundary has several consequences for Az-Pixiu's design.

It pushes data acquisition out of the agent and into a component with a clear, narrow responsibility. The agent does not own the question of how to authenticate to Azure or how to format a Resource Graph query. It owns the question of what to ask for and what to do with the answer.

It makes the agent's external surface narrower and easier to reason about. The boundary is a protocol, not a vendor SDK, and protocols are easier to mock, replay, and trace than networked SDK calls.

It aligns the agent's observability story with the project's broader principles. Calls across the boundary are uniform and can be traced uniformly. The same telemetry that captures the agent's reasoning also captures the agent's interactions with Azure.

## Trade-offs the project accepts

A protocol boundary is not free.

The agent depends on what AMG-MCP exposes. Capabilities the server does not surface require either patience, upstream contribution, or a clearly scoped local extension that does not erode the boundary. The project prefers the first two over the third.

The protocol adds a layer between the agent and the underlying data. For most cases this is an acceptable cost in exchange for uniformity and reusability. Where it is not, the project will record the reasoning before working around the boundary, so that any exceptions remain visible.

The MCP ecosystem is still maturing. The project accepts that some details — schemas, transport behaviors, server capabilities — will change. The principle that motivated the choice is more durable than any current version of the protocol, and the project intends to follow the protocol as it evolves rather than to freeze against a specific revision.

## How this fits the broader picture

The project takes the position that MCP is a meaningful architectural pattern for AI agents in operational settings, not just a convenient SDK alternative. The protocol provides a place to put concerns — authentication, capability discovery, schema definition, audit — that would otherwise be smeared across every agent that needs them.

Az-Pixiu uses AMG-MCP for Azure today. The project expects to interact with other MCP servers as its scope expands, and to benefit from the same separation of concerns each time. Other projects that need to reach the same Azure surface should be able to share AMG-MCP rather than build their own integration, in the same way that many tools share Grafana itself.

This is the reasoning that supports treating AMG-MCP as a first-class part of the architecture rather than as an implementation detail. The [architecture principles](architecture-principles.md) document records the underlying preference for protocol-driven integration more generally.
