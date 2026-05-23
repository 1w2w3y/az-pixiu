# Core Agent PRD

## Overview

The Az-Pixiu core agent is a local Azure operational intelligence agent focused on FinOps analysis. It helps engineering teams understand Azure cost behavior by gathering cost, resource, and telemetry evidence through approved integration boundaries, reasoning over that evidence, and producing explainable recommendations for human review.

The agent is not a general-purpose chatbot. It is a disciplined analysis system for Azure cost and operational signals. Its primary output is a structured, evidence-backed assessment of what changed, what appears wasteful or risky, what the agent believes is worth investigating, and how confident it is in each conclusion.

The agent must be useful to operators and legible to engineers studying observable AI systems. Every meaningful step should be traceable, evaluable, and reproducible enough for a reviewer to understand why a recommendation was made.

## Problem Statement

Azure cost analysis often requires engineers to move between Azure Cost Management, Azure Resource Graph, Azure Monitor, Grafana dashboards, deployment records, tagging systems, and team-specific context. This work is repetitive, time-consuming, and hard to make consistent across subscriptions or review cycles.

Existing cost tools can show spend, trends, and anomalies, but they rarely produce a coherent engineering narrative that connects cost changes to resource configuration and operational telemetry. General-purpose AI assistants can summarize data, but they often lack a reliable data boundary, evidence discipline, and observability needed for enterprise use.

Az-Pixiu needs a core agent that narrows this problem: read from Azure-related operational sources, reason carefully about FinOps scenarios, expose uncertainty, and produce recommendations that an engineer can inspect rather than blindly trust.

## Goals

- Analyze Azure spending in the context of resource metadata and operational telemetry.
- Produce recommendations grounded in explicit evidence, including resources, metrics, time windows, and assumptions.
- Support common FinOps workflows such as cost surprise investigation, idle resource discovery, tagging hygiene review, and cost review preparation.
- Run locally or in an operator-controlled environment with no requirement for a hosted Az-Pixiu service.
- Treat every agent run as observable from the beginning, with traceable inputs, tool calls, intermediate reasoning structure, outputs, and quality signals.
- Make agent output suitable for enterprise engineering review, including caveats, confidence, and suggested next steps.
- Provide a stable foundation for later evaluation datasets, prompt experiments, and broader Azure operational agents.

## Non-Goals

- Az-Pixiu will not be a generic conversational chatbot for arbitrary Azure questions.
- The core agent will not modify, delete, resize, restart, or reconfigure Azure resources.
- The agent will not claim autonomous remediation or closed-loop optimization.
- The agent will not replace Azure Cost Management, Grafana, existing FinOps platforms, or human governance processes.
- The first versions will not attempt exhaustive coverage of every Azure service, cost meter, or discount instrument.
- The agent will not produce finance-grade forecasting suitable for budget commitments without human validation.
- The agent will not require a centralized SaaS control plane operated by the project.

## Personas

- FinOps engineer: Investigates spend changes, prepares optimization backlogs, and needs defensible evidence for recommendations.
- Platform engineer: Owns shared Azure infrastructure and wants prioritized signals about waste, tagging gaps, and risky cost patterns.
- Site reliability engineer: Needs to understand how reliability or performance changes may have shifted cost.
- Engineering manager: Needs an executive-readable cost narrative for team reviews without losing the engineering basis.
- AI systems engineer: Studies the agent to learn how to build observable, evaluable AI systems.

## User Journeys

### Investigate a Cost Surprise

A FinOps engineer notices that a subscription's monthly spend increased materially. They run Az-Pixiu for the affected subscription and time range. The agent identifies the major cost contributors, compares them to a prior baseline, correlates the increase with relevant resource and telemetry changes, and produces hypotheses ranked by evidence strength.

The user receives a report that distinguishes observed facts from possible explanations. Each hypothesis includes supporting data, gaps in evidence, confidence, and recommended human follow-up.

### Find Idle or Underused Resources

A platform engineer runs the agent against a subscription or resource group before a cleanup review. The agent identifies resources that appear idle, underused, oversized, or unowned. It shows the telemetry signals used for each candidate and avoids presenting deletion as an automatic action.

The user receives a prioritized list of review candidates, with enough context to validate whether each resource is genuinely safe to change.

### Prepare a Cost Review

An engineering manager needs a quarterly cost review. The agent summarizes spend by service, resource group, owner, and major change drivers. It highlights optimization opportunities and unresolved data quality issues, such as missing tags or telemetry gaps.

The user receives a review-ready narrative that can be edited by a human and backed by detailed evidence if challenged.

### Review Agent Reasoning

An engineer disagrees with a recommendation. They inspect the agent output and corresponding observability trace. They can see the input scope, data collected, prompts used, tool calls made, and evidence selected for the final output.

The review produces either acceptance, rejection, or a quality issue that can be added to the evaluation backlog.

## Functional Requirements

- FR-1: The agent must accept an explicit analysis scope, including Azure subscription or resource grouping, time window, comparison baseline where relevant, and requested analysis type.
- FR-2: The agent must clearly state the effective scope used for a run before presenting conclusions.
- FR-3: The agent must retrieve cost, resource, and telemetry evidence through the approved Azure integration boundary rather than relying on user-provided free text alone.
- FR-4: The agent must preserve the provenance of evidence used in conclusions, including data source, query intent, resource identifiers, metric names, and time windows.
- FR-5: The agent must distinguish observed facts, inferred hypotheses, recommendations, and missing data.
- FR-6: The agent must produce structured recommendations with severity or priority, estimated impact where supported, confidence, supporting evidence, assumptions, and recommended human action.
- FR-7: The agent must avoid recommending destructive action as an autonomous step. Any remediation guidance must be framed as human-reviewed options.
- FR-8: The agent must support at least the initial FinOps scenarios documented for the project: cost surprise investigation, idle or underused resource review, quarterly cost review, telemetry-cost correlation, and tagging hygiene audit.
- FR-9: The agent must surface uncertainty when evidence is incomplete, contradictory, stale, or outside the requested scope.
- FR-10: The agent must ask for clarification or fail with a useful message when the requested scope is ambiguous enough to produce misleading output.
- FR-11: The agent must generate outputs that are suitable for both human reading and downstream evaluation.
- FR-12: The agent must record enough run metadata to connect user-visible output to observability traces, evaluations, prompt versions, and experiment variants.
- FR-13: The agent must expose data access failures, partial results, rate limits, and unsupported resource types as first-class findings rather than silently omitting them.
- FR-14: The agent must support repeat runs over the same scenario so output changes can be compared across prompt, model, and data-collection changes.
- FR-15: The agent must maintain a clear separation between user-supplied context and evidence retrieved from Azure operational sources.
- FR-16: The agent must support enumeration of waste candidates by category (orphaned, unattached, deallocated, stopped, failed, expired-by-naming-convention, unused) where the category can be defined by an unambiguous evidence predicate. Each candidate must be backed by the specific evidence that classified it and must carry the false-positive considerations relevant to its category.
- FR-17: The agent must, where supported by an evidence-cited rate source, attach an estimated weekly cost impact to each waste candidate or candidate cluster. Estimates must be rendered as calibrated ranges with the rate source identified, never as point figures presented with implicit certainty. Candidates whose SKU is not covered by the rate source must be marked as "rate unavailable" rather than silently omitted or zeroed.
- FR-18: The agent must recognize when cost evidence is likely incomplete due to data-source posting lag (for example, a cost-analysis window ending within the cost API's known late-posting window, or a cross-subscription uniform drop pattern that does not match plausible workload behaviour) and caveat any hypothesis or recommendation that depends on the affected totals.
- FR-19: The agent must be able to consult its own prior runs against the same scope and analysis type when available, and use prior-run context as evidence to mark waste candidates whose IDs persist across runs (continuity markers), to recognize recurring patterns whose names match a previously resolved cluster, and to label recommendations as new or carrying forward across runs. Where prior-run context is not available, the agent must operate without it rather than fabricate continuity claims.
- FR-20: The agent must produce a stable, deterministic identifier for each recommendation that survives LLM rewriting of the recommendation text, so the same recommendation can be recognized across runs for de-duplication, continuity tracking, and longitudinal evaluation.

## Non-Functional Requirements

- Accuracy: Recommendations must be based on retrieved evidence and must not fabricate resource names, costs, metric values, or capabilities.
- Explainability: Every recommendation must be reviewable by following evidence references back to the data collected during the run.
- Observability: Runs must be traceable at a level that supports debugging, quality review, and experiment comparison.
- Security: The agent must assume Azure cost and telemetry data are sensitive and must avoid unnecessary disclosure outside the operator-controlled environment.
- Privacy: Local-first operation must remain a product constraint. Any optional external model or telemetry service must be explicit to the operator.
- Reliability: Partial failure must degrade into bounded analysis with clear caveats rather than unsupported conclusions.
- Performance: Analysis latency should remain acceptable for interactive engineering workflows, while recognizing that deeper subscription-wide reviews may take longer.
- Usability: Output should be concise enough to review but detailed enough to defend. The agent should prefer engineering-specific language over generic assistant phrasing.
- Extensibility: New analysis types should be addable without weakening the evidence, observability, or read-only constraints.

## Risks

- The agent may overstate confidence when Azure telemetry is incomplete, delayed, or aggregated differently than cost data.
- Enterprise environments may have inconsistent tagging and ownership metadata, making attribution difficult.
- Cost data and telemetry may use different time grains, dimensions, or resource identities, creating correlation errors.
- Users may misinterpret recommendations as approved remediation plans unless language is carefully bounded.
- LLM output quality may vary across providers, prompt versions, and data shapes.
- Excessively verbose evidence could make reports hard to use, while insufficient evidence could make them hard to trust.
- The agent may become too broad if it accepts arbitrary chat-style questions outside the FinOps operational intelligence scope.

## Open Questions

- What minimum Azure resource types should define the first useful agent release?
- What confidence taxonomy is most understandable to enterprise operators?
- How should the agent represent cost impact when exact savings cannot be computed from available data?
- Which user-provided business context should the agent accept, and how should it distinguish that context from retrieved evidence?
- What output schema is stable enough for evaluations without prematurely constraining the product?
- How should repeated recommendations be de-duplicated across runs or review periods? *(FR-19 / FR-20 commit to a deterministic `recommendation_signature` plus a `RunHistoryStore`; substrate choices are designed in [cost-summary depth](../design/cost-summary-depth.md) §Gap 5.)*
- What level of local state is needed to support comparison over time without creating a hidden data store requirement? *(Phase 2.5 starts with a filesystem index over the existing `runs/` artefacts; the interface is shaped so SQLite or Langfuse Datasets can be swapped in later.)*
- How aggressive should waste-classification heuristics be when the underlying predicate is structural (provisioning state, ipConfiguration emptiness) versus naming-convention-based ("restored-*", "test-*"), given that structural predicates have a clearer false-positive boundary?
- How should scope drift between runs (a subscription becomes inaccessible, a resource group is added) interact with cross-run continuity matching?

## Future Considerations

- Expand from initial FinOps scenarios into reliability and capacity analysis while preserving the same observability foundation.
- Support richer comparison workflows across subscriptions, environments, teams, and business units.
- Add human feedback loops that connect accepted, rejected, or modified recommendations back into evaluation datasets.
- Support organization-specific policy context, such as tagging standards, reserved instance strategy, or approved SKU guidance.
- Provide richer report variants for engineering, management, and audit audiences.
- Enable multi-agent coordination only after the core agent's evidence and evaluation contracts are mature.

## Success Criteria

- An enterprise engineer can run the agent against a real Azure scope and receive at least one recommendation they would seriously review.
- Every recommendation includes traceable evidence, explicit assumptions, and calibrated confidence.
- A reviewer can inspect an agent run and understand how the final output was produced.
- The agent reliably avoids autonomous remediation claims and keeps humans in control.
- Early evaluation datasets can measure the quality of core-agent outputs without requiring major changes to the product contract.
- The core agent demonstrates Langfuse learning value through observable, comparable, and evaluable runs.
