# Vision

Az-Pixiu is an exploration of what it means to give engineering teams a small, focused, locally runnable AI agent that can reason carefully about their cloud environment.

The long-term vision rests on three observations.

## AI belongs in the operational loop

Cloud environments produce more signal than any single engineer can hold in their head. Cost reports, resource graphs, telemetry streams, and Grafana dashboards each tell part of the story, and the connections between them often require an engineer to sit down, pull data into a notebook, and reason carefully across systems.

There is real value in a tool that can do that reasoning continuously and surface the parts that matter, while leaving the final decisions to people. Az-Pixiu is intended to demonstrate what such a tool can look like for the specific problem of Azure cost optimization, and to leave room to grow into broader cloud operations analysis over time.

## Local-first agents matter

Most cloud cost and telemetry data is sensitive. Subscription identifiers, resource names, tag values, and usage patterns frequently leak information about an organization's structure, customers, and plans.

Az-Pixiu is meant to be run by the people whose data it sees. The agent should be deployable on a workstation or inside a customer-controlled environment, with model, storage, and integration choices that the operator controls. The project takes the position that this is a more sustainable pattern for AI in operations than centralizing telemetry in third-party services.

## AI systems must be observable

An AI agent that produces recommendations without showing its reasoning is difficult to trust and impossible to improve. The same observability practices that engineering teams apply to their services — tracing, structured telemetry, regression suites, deliberate evaluation — should apply to the agents that operate alongside them.

Az-Pixiu treats Langfuse as the project's substrate for AI observability. The agent is intended to be a useful case study for engineers learning how to instrument, evaluate, and iterate on AI systems in a disciplined way.

## Where this leads

In the long term, Az-Pixiu is expected to evolve into a small family of focused cloud operations agents that share the same observability foundation. FinOps is the entry point because the data is rich, the value is concrete, and the failure modes are forgiving. The same patterns are expected to apply to reliability investigation, capacity planning, security posture analysis, and other domains where the work today consists of pulling data from many systems and reasoning across it.

The project does not aim to become a platform, a product, or a replacement for any existing cloud management tool. It aims to be a clear, well-documented reference for how a particular class of agent can be built and operated.

## What success looks like

Success is not measured by feature count or by adoption metrics. The project will be successful if:

- An engineer who runs Az-Pixiu against their own Azure environment gets recommendations they would consider acting on.
- An engineer who reads the project comes away with a clearer mental model of how to build and operate an observable AI agent.
- The patterns the project develops outlive the specific tools, models, and protocols it relies on today.

These outcomes are slower to produce than features, and they are the ones the project intends to optimize for.
