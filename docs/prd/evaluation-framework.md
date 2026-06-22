# Evaluation Framework PRD

## Overview

The Az-Pixiu evaluation framework defines how the project measures agent quality. It provides datasets, scoring dimensions, review workflows, and regression checks for an Azure FinOps operational intelligence agent whose outputs must be evidence-backed and trustworthy.

Evaluation is not a later hardening task. It is part of the product contract because Az-Pixiu's value depends on whether its recommendations are grounded, useful, and appropriately cautious. The framework must help maintainers improve the agent without relying on isolated anecdotes or subjective impressions.

The framework should also serve the project's Langfuse learning goals by showing how datasets, evaluations, experiments, and scoring work together in a realistic AI system.

## Current Implementation Status

The repository currently ships `eval/phase-1.json` with four items and `eval/phase-3-waste.json` with the first orphan-public-IP waste-lane item. Automated scoring includes structural correctness, citation completeness, confidence consistency, read-only adherence, estimated-impact calibration, and waste-classification grounding. The CLI eval runner can run fully offline with fixture replay and mock credentials; when Langfuse credentials are present it can publish rubric and expectation scores, upsert dataset items, attach traces to a Dataset Run / Experiment, and sweep multiple models. LLM-as-judge, human review, calibration reporting, continuity-specific eval items, and `continuity_grounded` remain planned.

## Problem Statement

LLM-based agents can regress in subtle ways. A prompt change may improve clarity while weakening evidence grounding. A new model may format reports better while hallucinating resource attributes. A broader data retrieval strategy may improve recall while increasing latency and noise.

Without a formal evaluation framework, Az-Pixiu cannot know whether changes improve real FinOps usefulness. Enterprise users also need confidence that the agent is tested against scenarios that resemble their operational reality, including ambiguous data and failure modes.

The project needs a durable way to define representative scenarios, compare outputs, measure quality, capture human judgment, and turn defects into future tests.

## Goals

- Maintain curated evaluation datasets for representative Azure FinOps scenarios.
- Measure recommendation quality across grounding, correctness, confidence, clarity, actionability, and safety boundaries.
- Support both automated checks and human review.
- Use Langfuse experiments and scores to compare prompt, model, tool, and analysis-strategy changes.
- Include negative, ambiguous, and partial-data cases, not only clean success examples.
- Create a feedback loop from real defects and user review into new evaluation items.
- Keep evaluations understandable to engineers who are learning how to build observable AI systems.

## Non-Goals

- The framework will not claim to prove financial correctness in all Azure billing scenarios.
- Evaluations will not replace expert human review for high-impact recommendations.
- The framework will not optimize the agent for benchmark scores at the expense of real usefulness.
- Initial datasets will not cover every Azure service, pricing model, or enterprise architecture pattern.
- Model-graded scoring will not be treated as inherently authoritative.
- The framework will not require live Azure access for every evaluation run.

## Personas

- Maintainer: Needs confidence that a product change does not regress agent behavior.
- Evaluation owner: Curates datasets, scoring rubrics, and review outcomes.
- Contributor: Wants to understand the quality bar before changing prompts or agent behavior.
- Enterprise reviewer: Wants evidence that the agent has been tested against realistic cases.
- AI observability learner: Studies how Langfuse datasets and evaluations are applied in practice.

## User Journeys

### Validate a Prompt Change

A contributor modifies a prompt to improve report clarity. They run the evaluation suite against the current and proposed prompt versions. The framework compares grounding, structure, confidence calibration, and human readability scores before the change is accepted.

### Add a Regression Case

A user reports that the agent recommended investigating a resource based on stale telemetry. A maintainer converts the case into a dataset item with expected quality criteria. Future runs must detect or caveat stale telemetry correctly.

### Compare Model Choices

The project evaluates two model configurations on the same dataset. The framework shows differences in recommendation quality, cost, latency, formatting consistency, and unsupported-claim rate.

### Review Dataset Coverage

The team inspects evaluation coverage by scenario type, resource type, data quality condition, and failure mode. Gaps become roadmap inputs rather than hidden assumptions.

## Functional Requirements

- FR-1: The framework must define dataset items with scenario description, analysis scope, available evidence, expected behavior, known pitfalls, and review criteria.
- FR-2: Datasets must include at least core FinOps scenarios: cost surprise, idle resources, underused resources, tagging hygiene, quarterly review, and cost-telemetry correlation.
- FR-3: Datasets must include partial-data and failure-mode cases, such as missing telemetry, permission gaps, stale data, inconsistent tags, unsupported resource types, and ambiguous cost drivers.
- FR-4: The framework must support sanitized or synthetic evidence so evaluations can run without exposing private Azure data.
- FR-5: Evaluation outputs must be linked to Langfuse traces, prompt versions, model configurations, and experiment identifiers.
- FR-6: Automated checks must verify structural output requirements, required sections, evidence references, unsupported remediation claims, and basic numerical consistency where applicable.
- FR-7: Grounding checks must verify that recommendations cite evidence present in the dataset or retrieved run evidence.
- FR-8: Scoring must include dimensions for evidence grounding, recommendation usefulness, confidence calibration, clarity, actionability, safety boundary adherence, and format consistency.
- FR-9: Human review workflows must be supported for dimensions that require domain judgment.
- FR-10: Evaluation runs must support comparison between baseline and candidate variants.
- FR-11: The framework must record failure explanations, not only aggregate pass or fail scores.
- FR-12: Evaluation results must be usable to block or challenge changes that degrade critical quality dimensions.
- FR-13: Dataset items must be versioned or otherwise stable enough for meaningful historical comparison.
- FR-14: The framework must support adding new cases from production-like traces or user feedback after sanitization.
- FR-15: The evaluation framework must be reusable by future Az-Pixiu agents with domain-specific additions.
- FR-16: As the agent gains analyzer capabilities beyond Phase 1's descriptive surface, the framework must add rubrics that measure those capabilities specifically — at minimum a waste-classification grounding rubric that each waste candidate cites the evidence that classified it, a calibrated-impact rubric that each estimated weekly cost impact renders as a range with a cited rate source, and a continuity-grounded rubric that each cross-run marker cites the prior-run evidence that justifies it. These are additive to the Phase 1 structural rubrics, not replacements; the Phase 2 score taxonomy continues to apply.
- FR-17: Evaluation datasets should include billing-cache cases once the cache lands: cache-only finalized months, mixed cached-plus-live windows, not-yet-mature months that must not be cached, and corrupt or missing cache records that should degrade into explicit data-quality findings.

## Non-Functional Requirements

- Representativeness: Datasets should reflect realistic enterprise Azure conditions, including messy ownership and incomplete telemetry.
- Reproducibility: Evaluation runs should be repeatable enough to compare changes over time.
- Interpretability: Scores and failure reports should be understandable without reading model internals.
- Safety: Evaluations must explicitly check that the agent does not claim autonomous remediation authority.
- Cost control: Evaluation design should avoid unnecessary expensive model calls while preserving quality signal.
- Privacy: Dataset construction must prevent accidental disclosure of sensitive subscription, resource, or business information.
- Maintainability: The framework should make it easy to add new scenarios as the product discovers failure modes.
- Balance: Automated and human scores should complement each other rather than pretending one can replace the other.

## Risks

- Datasets may become too small or too clean, creating false confidence.
- Synthetic data may miss important patterns from real Azure environments.
- Human reviewers may apply inconsistent standards without clear rubrics.
- Model-graded evaluations may reward polished language over correct analysis.
- Regression gates may become too rigid and slow useful iteration.
- Overfitting to evaluation cases may reduce generalization to real customer environments.
- Sensitive data may leak into public or shared evaluation artifacts if sanitization is weak.

## Open Questions

- What should be the minimum dataset size before evaluations become required for prompt changes?
- Which scoring dimensions should be considered release-blocking?
- How should the project calibrate model-graded scores against human review?
- What sanitization standard is sufficient for sharing realistic Azure examples publicly?
- How should evaluation cases represent pricing constructs such as reservations, savings plans, and negotiated discounts?
- How should the framework score cases where the correct answer is to refuse or ask for more data?
- What level of statistical rigor is appropriate for early-stage experiments?

## Future Considerations

- Build a public benchmark of sanitized Azure FinOps scenarios.
- Add longitudinal quality dashboards that track scores across project phases.
- Incorporate user disposition signals from real recommendations.
- Support organization-private evaluation packs for enterprise adopters.
- Expand evaluations to reliability, capacity, and security posture agents.
- Add adversarial tests for prompt injection, misleading user context, and conflicting evidence.
- Develop calibration reports that compare confidence labels against human-reviewed correctness.

## Success Criteria

- Maintainers can evaluate prompt, model, and analysis changes before accepting them.
- Evaluation datasets include realistic successful, ambiguous, and failure-mode scenarios.
- The framework catches regressions in grounding, safety boundaries, numerical consistency, and report structure.
- Human review is incorporated where automated checks are insufficient.
- Evaluation artifacts are connected to Langfuse traces, experiments, and scores.
- The framework produces learning value for engineers studying observable AI development.
