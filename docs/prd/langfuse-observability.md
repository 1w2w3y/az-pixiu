# Langfuse Observability PRD

## Overview

Langfuse observability is a first-class product surface for Az-Pixiu. The project exists not only to build a useful Azure FinOps agent, but also to show how an AI operational intelligence system can be traced, evaluated, scored, and improved with discipline.

This PRD defines requirements for telemetry, tracing, evaluations, experiments, prompt management, and observability workflows around Az-Pixiu. These requirements apply to the core agent and to future agents that share the same foundation.

Observability is not an afterthought or a debugging feature for maintainers only. It is part of the trust contract with enterprise users. A recommendation that cannot be inspected, evaluated, or tied back to evidence is a product defect.

## Problem Statement

AI systems that operate over enterprise infrastructure can produce plausible but incorrect recommendations. Traditional application logs are insufficient because they do not capture prompt versions, model inputs and outputs, tool calls, intermediate reasoning structure, evidence selection, or quality scores.

For Az-Pixiu, weak observability would create three problems. Operators would not know why the agent made a recommendation. Maintainers would not know whether changes improved quality. Engineers studying the project would not learn how to build observable AI systems in practice.

The project needs Langfuse to be load-bearing: traces should explain individual runs, evaluations should measure quality over representative scenarios, experiments should compare meaningful alternatives, and scores should form a durable quality record.

## Current Implementation Status

Langfuse tracing is wired for analyze and eval runs when configured. Analyze runs can publish automated rubric scores to the trace. Eval runs can publish rubric and expectation scores, upsert local dataset items into Langfuse, attach traces to Dataset Run Items, group them under a Dataset Run / Experiment, and run model sweeps. Prompt loading is still file-backed (`prompts/planner.v1.md`, `prompts/reasoner.v1.md`, `prompts/reasoner.v2.md`), but every new run records the exact prompt content SHA-256 alongside the filename-derived version. Eval Dataset Run Items receive the stable versions and hashes, not an absolute local prompt path, and `--prompts-dir` supports content-attributable local prompt comparisons while managed prompts remain pending. Local JSON remains the CLI dataset source. Langfuse-backed prompt loading, Langfuse-as-source datasets, LLM-as-judge, human-review tooling, calibration reports, and configurable redaction remain planned.

## Goals

- Capture complete, useful traces for every meaningful agent run.
- Connect user-visible recommendations to the specific inputs, tool calls, prompts, model calls, evidence, and output assembly steps that produced them.
- Use Langfuse datasets and evaluations as part of normal product development, not as demonstration artifacts.
- Support prompt versioning and experiment comparison for changes that affect recommendation quality.
- Provide observability surfaces that help enterprise engineers review trust, reliability, cost, latency, and failure modes.
- Teach readers how AI observability and general software observability can operate together.
- Establish shared observability conventions that future Az-Pixiu agents can reuse.

## Non-Goals

- This work will not create a separate generic observability product.
- Langfuse integration will not be limited to logging final prompts and responses.
- Observability will not be used to justify opaque recommendations; it must make recommendations easier to challenge.
- The project will not require users to disclose Azure cost or telemetry data to a hosted service without an explicit operator choice.
- This PRD does not define model provider selection or implementation framework details.
- This work will not replace human review for high-impact recommendations.

## Personas

- Agent operator: Runs Az-Pixiu and needs to understand what data the agent accessed and why it reached a conclusion.
- Maintainer: Changes prompts, tools, or analysis logic and needs to know whether quality improved or regressed.
- Evaluation owner: Curates datasets, reviews quality scores, and turns failure modes into measurable checks.
- Enterprise reviewer: Assesses whether the agent is auditable enough for internal use.
- AI observability learner: Uses the project to understand Langfuse tracing, datasets, evaluations, experiments, and scoring in a realistic setting.

## User Journeys

### Inspect a Recommendation

An operator sees a recommendation about an underused resource. They open the associated trace and review the run scope, data retrieval steps, evidence selected, prompt version, model call, and output assembly. The trace gives them enough information to decide whether the recommendation deserves follow-up.

### Debug a Bad Output

A maintainer receives feedback that the agent cited an irrelevant metric. They locate the run in Langfuse, inspect the tool results and model output, identify whether the defect came from data retrieval, evidence selection, prompt wording, or output formatting, and create a targeted evaluation case.

### Compare Prompt Variants

A contributor proposes a prompt change to improve recommendation clarity. They run both prompt versions against a shared dataset, compare scores and qualitative examples, and document whether the change improved evidence quality, confidence calibration, and report usefulness.

### Monitor Agent Quality Over Time

The project reviews aggregate observability data across recent runs. Maintainers inspect latency, cost, failed tool calls, unsupported scenarios, recommendation acceptance signals, and evaluation score trends. The review informs the next product improvements.

## Functional Requirements

- FR-1: Every agent run must produce a Langfuse trace or an explicit local equivalent when Langfuse is unavailable by operator choice.
- FR-2: A trace must include run scope, user request, normalized analysis intent, tool calls, data retrieval results or summaries, model calls, prompt versions, output generation steps, errors, and final recommendations.
- FR-3: Traces must preserve the relationship between recommendations and the evidence used to support them.
- FR-4: Trace metadata must include enough identifiers to filter by analysis type, Azure scope, time window, resource type, prompt version, model configuration, experiment name, and run status.
- FR-5: Sensitive Azure data must be handled deliberately. The observability layer must support redaction, summarization, or local-only capture where necessary for enterprise use.
- FR-6: Prompt changes that affect agent behavior must be versioned and attributable in traces and evaluation results.
- FR-7: The project must support datasets of representative FinOps scenarios, including successful cases, ambiguous cases, partial-data cases, and known failure modes.
- FR-8: Evaluations must measure both structural correctness and recommendation quality.
- FR-9: Evaluation results must be connected back to the traces and dataset items that produced them.
- FR-10: Experiments must support comparison of prompts, model choices, analysis strategies, evidence-selection policies, or output formats against the same dataset.
- FR-11: Scores must distinguish dimensions such as evidence grounding, numerical consistency, confidence calibration, actionability, clarity, and format adherence.
- FR-12: Human review scores must be supported for judgments that automated checks cannot reliably determine.
- FR-13: Observability views must make it easy to find failed runs, partial runs, high-latency runs, high-cost runs, and low-quality outputs.
- FR-14: The system must make unsupported scenarios visible so that coverage gaps can become product backlog items.
- FR-15: The observability requirements must apply to future agents without requiring each agent to invent its own tracing vocabulary.
- FR-16: The trace pipeline must be additively pluggable. An operator who wants to evaluate a second OTel-compatible backend (Arize Phoenix, an OpenTelemetry collector, a tracing SaaS) must be able to enable it as a parallel sink via environment configuration, without weakening the Langfuse trace tree or moving any logic out of the local agent. Phoenix is the first such optional sink and is gated on `PHOENIX_BASE_URL` (see [phase-1 design](../design/phase-1.md#trace-span-vocabulary-shared)).
- FR-17: The OTel instrumentation layer (the libraries that monkey-patch the OpenAI SDK and the MCP SDK to auto-emit LLM and tool spans) must be swappable per process. Phase 1 supports two flavors: `langfuse` (`@langfuse/openai` + `@traceloop/instrumentation-mcp`) and `openinference` (`@arizeai/openinference-instrumentation-openai` + `@arizeai/openinference-instrumentation-mcp`). The chosen flavor must be recorded on the trace root span and in `RunMetadata` so every trace is self-describing about which attribute vocabulary it uses.

## Non-Functional Requirements

- Trustworthiness: Observability data must help reviewers challenge the agent, not merely confirm its output.
- Completeness: A trace should capture the meaningful steps required to understand a run while avoiding unnecessary raw data duplication.
- Privacy: Operators must understand what is captured, where it is stored, and how sensitive data can be minimized.
- Consistency: Trace structure, metadata names, and scoring dimensions should remain stable enough for longitudinal analysis.
- Usability: Langfuse views and artifacts should answer real engineering questions rather than showcasing generic dashboards.
- Cost awareness: Observability capture should not create uncontrolled cost growth through excessive payloads or unnecessary model-graded evaluations.
- Resilience: Agent execution should produce useful diagnostic records even when a tool call, model call, or Langfuse write fails.
- Educational value: The observability design should be clear enough for engineers to learn from without private context.

## Risks

- Capturing too little detail may make traces useless for audit and debugging.
- Capturing too much raw Azure data may create privacy, storage, or cost concerns.
- Evaluation scores may become vanity metrics if they are not tied to real user judgments and failure modes.
- Model-graded evaluations may reinforce incorrect assumptions unless calibrated with human review.
- Prompt experiments may optimize for benchmark performance while reducing usefulness on real workloads.
- Inconsistent metadata across runs may make aggregate analysis unreliable.
- Treating Langfuse as a demonstration checklist could weaken its role in day-to-day development.

## Open Questions

- What default redaction policy is appropriate for subscription identifiers, resource names, tag values, and cost figures?
- Which trace fields are mandatory for all agents, and which are specific to FinOps?
- How should the project represent intermediate reasoning without exposing unnecessary private or chain-of-thought style content?
- What minimum score set should gate prompt or model changes?
- How much raw evidence should be stored in Langfuse versus referenced from local run artifacts?
- What human review workflow should be used for disputed or high-impact recommendations?
- How should acceptance, rejection, and later validation of recommendations feed back into scores?

## Future Considerations

- Integrate OpenTelemetry conventions so AI traces can be correlated with local application telemetry.
- Add longitudinal quality reports that show how recommendation quality changes across releases.
- Support organization-specific evaluation datasets while keeping public examples safe and useful.
- Add review workflows for prompt approvals, experiment sign-off, and quality regressions.
- Extend shared trace vocabulary to reliability, capacity, and security posture agents.
- Explore privacy-preserving trace sharing for users who want help debugging without exposing sensitive cloud data.

## Success Criteria

- A reviewer can open a trace for any recommendation and understand the path from request to output.
- Maintainers can compare prompt or model changes against shared datasets before accepting them.
- Evaluation results catch meaningful regressions in evidence quality, format, numerical consistency, and confidence calibration.
- Langfuse artifacts are useful in normal development and not just present for documentation.
- The project teaches a clear, repeatable pattern for AI observability in operational systems.
- Enterprise users can reason about what telemetry is captured and make informed choices about privacy.
