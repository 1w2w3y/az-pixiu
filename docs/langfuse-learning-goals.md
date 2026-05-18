# Langfuse learning goals

One of Az-Pixiu's explicit purposes is to provide a realistic context in which to learn and demonstrate the Langfuse platform. This document describes which Langfuse capabilities the project intends to exercise, what they are expected to do for the project, and what an engineer reading the project should be able to learn from each.

The intent is for these capabilities to be load-bearing in the project's own development. They should not feel grafted on for demonstration purposes; they should be the way the project's authors actually work.

## Tracing

Az-Pixiu is built around an agent that reasons over data, calls tools, and produces structured outputs. Without tracing, the agent's behavior is difficult to inspect after the fact and impossible to debug systematically.

The project intends to use Langfuse tracing to make every meaningful step of agent execution visible: which inputs were received, which tools were invoked, which model calls were made, what they returned, and how the final output was assembled. A trace should be enough to reproduce, or at least account for, any decision the agent has ever made.

An engineer studying the project should be able to learn how to model an agent's execution as a structured trace and how to make those traces useful for both debugging and longer-term analysis.

## Observability

Tracing produces individual records of execution. Observability is the broader practice of being able to ask questions about agent behavior across many executions: how often a particular step fails, how latency varies by input shape, which prompts produce which classes of output, how cost per recommendation evolves over time.

The project intends to use Langfuse's observability surfaces to make these questions answerable as a normal part of operating the agent. Dashboards, filters, and aggregate views should reflect questions the project's authors actually want to ask, not generic templates.

## Evaluations

A recommendation agent that cannot be evaluated cannot be improved with any rigor. The project intends to define evaluations that capture what good output looks like for Az-Pixiu and to run those evaluations both during development and as part of ongoing operation.

Evaluations are expected to combine automated checks — does the recommendation cite valid evidence, is the format well formed, are the numbers internally consistent — with judgements that require human review or model-graded scoring. The combination matters more than any single mechanism.

## Datasets

Evaluations are only as honest as the data they run on. The project intends to maintain curated datasets of representative scenarios drawn from realistic Azure environments. These datasets should evolve as the project learns which situations are common, which are difficult, and which expose interesting failure modes.

Studying the project should give an engineer a clear sense of how to construct evaluation datasets that are useful rather than convenient, and how to extend them as new failure modes emerge.

## Prompt management

Prompts are part of the agent's contract with its underlying models. Treating them as untracked strings inside source files makes them difficult to evolve safely. The project intends to manage its prompts through Langfuse so that changes are versioned, comparable, and tied to the traces and evaluations they affect.

The project should make it easy to see how a prompt changed, when it changed, and what the effect of the change was on the evaluations the project cares about.

## Experiments

The agent is expected to face genuine design choices: different prompts, different model choices, different reasoning structures, different evidence-gathering strategies. The project intends to use Langfuse experiments to compare these options on real workloads rather than to choose between them on intuition.

The aim is for the project's significant design decisions to leave a paper trail of experiments behind them, so that future contributors can understand not just what was chosen but why.

## Scoring

Scores express how good an output is. Some scores are automated and produced by evaluations; some come from human reviewers; some come from downstream signals such as whether a recommendation was acted on. The project intends to use scoring as the connective tissue between traces, evaluations, and experiments — the surface against which the agent's quality is actually measured over time.

## OpenTelemetry integration

Az-Pixiu is an AI agent, but it is also a piece of software that runs in an environment alongside other software. The project intends to use Langfuse's OpenTelemetry integration so that AI-specific observability lives in the same telemetry ecosystem as the rest of an operator's stack.

This matters for two reasons. The first is practical: operators should not need a separate observability silo for the agent. The second is illustrative: the project is meant to show that AI observability and general-purpose service observability are not separate disciplines, and that treating them as one produces better tooling and better operations.

## What an engineer should learn

Taken together, these capabilities are intended to teach a particular way of working with AI systems: instrument before you guess, evaluate against curated data, manage prompts as artifacts, compare options through experiments, and measure quality through scores that mean something. Az-Pixiu's contribution is to show what that way of working looks like in a project that is doing real work, not a project built to demonstrate the platform.
