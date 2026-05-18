# Future Multi-Agent Platform PRD

## Overview

Az-Pixiu begins as a focused Azure FinOps agent. The long-term vision is to grow into a small family of Azure operational intelligence agents that share the same local-first posture, AMG-MCP-style protocol boundaries, Langfuse observability foundation, evaluation framework, and evidence-backed reporting discipline.

This PRD describes future platform requirements, not immediate implementation work. It exists to guide architectural choices so the FinOps agent can mature without closing the door on adjacent agents for reliability investigation, capacity planning, security posture review, governance hygiene, and other operational domains.

The future platform should not become a generic agent marketplace or autonomous operations system. It should remain serious, auditable, read-oriented, and useful to enterprise engineering teams.

## Problem Statement

Many Azure operational workflows share the same shape: collect signals from multiple systems, correlate them across time and ownership boundaries, reason about likely causes or risks, and present a grounded narrative to human operators. FinOps is one instance of this pattern.

If each future agent is built separately, the project will duplicate integration, tracing, evaluation, reporting, and configuration concerns. If the project generalizes too early, it risks building an abstract platform before proving that the FinOps agent works.

Az-Pixiu needs a future-facing product direction that preserves focus now while allowing disciplined expansion later.

## Goals

- Define the principles that should govern expansion beyond the core FinOps agent.
- Reuse shared foundations for observability, evaluation, evidence provenance, reporting, and local operation.
- Support multiple focused Azure operational agents without turning Az-Pixiu into a generic chatbot.
- Preserve read-only, human-reviewed recommendations across all future domains.
- Allow domain-specific agents to use specialized evidence, rubrics, and report formats while sharing common contracts.
- Make cross-domain reasoning possible where evidence supports it, such as cost versus reliability trade-offs.
- Keep Langfuse learning value central as the agent family grows.

## Non-Goals

- This is not a near-term commitment to implement multiple agents.
- The project will not become a hosted multi-tenant agent platform.
- The future platform will not perform autonomous remediation across Azure resources.
- The platform will not attempt broad multi-cloud coverage as part of this vision.
- Future agents will not be accepted merely because they are interesting; they must fit the operational intelligence pattern.
- The platform will not require all agents to use identical report content or evaluation rubrics.
- This PRD does not define implementation architecture or plugin APIs.

## Personas

- Platform engineering lead: Wants consistent analysis patterns across cost, reliability, capacity, and governance work.
- Domain agent owner: Builds or maintains a specialized operational agent while reusing Az-Pixiu foundations.
- Enterprise operator: Runs multiple focused agents locally and needs consistent safety, output, and observability behavior.
- AI observability owner: Compares quality across agents and ensures shared tracing and evaluation discipline.
- Engineering manager: Wants connected operational narratives, such as why a reliability improvement increased spend.

## User Journeys

### Add a Reliability Investigation Agent

After the FinOps agent proves useful, a team proposes a reliability-focused agent. The new agent uses the same local execution posture, protocol-driven Azure data access, trace vocabulary, and evaluation framework, but introduces reliability-specific datasets and report sections.

The project can add the agent without duplicating observability or weakening the FinOps product.

### Compare Cost and Capacity Signals

A platform team wants to understand whether a service is overprovisioned or intentionally scaled for traffic. A future capacity agent and the FinOps agent share evidence conventions, allowing a combined report that distinguishes waste from justified redundancy.

The user receives a cross-domain narrative without either agent pretending to own remediation.

### Govern Agent Quality Across Domains

Maintainers review quality dashboards for FinOps, reliability, and governance agents. Each agent has domain-specific scores, but all share common dimensions such as evidence grounding, confidence calibration, safety boundary adherence, and trace completeness.

The team can identify whether a regression is domain-specific or a shared platform issue.

### Run a Local Agent Suite

An enterprise operator runs selected agents against a subscription before a quarterly platform review. The suite produces separate domain reports and a concise cross-domain summary with trace links and caveats.

The operator remains in control of which scopes and agents run.

## Functional Requirements

- FR-1: Future agents must be focused on specific Azure operational intelligence domains rather than arbitrary conversation.
- FR-2: All agents must follow shared principles: local-first, read-only, observable by construction, evidence over assertion, and human-reviewed recommendations.
- FR-3: All agents must produce traces using a common baseline vocabulary for run scope, evidence retrieval, model calls, recommendations, scores, and errors.
- FR-4: All agents must support evaluation datasets and scoring dimensions appropriate to their domain.
- FR-5: All agents must preserve evidence provenance in a way that supports cross-agent review.
- FR-6: Shared reporting conventions must allow users to compare outputs across agents without forcing every domain into the same template.
- FR-7: Cross-agent summaries must distinguish which agent produced which finding and what evidence supports cross-domain conclusions.
- FR-8: Agents must be able to declare required capabilities and data categories before running.
- FR-9: The platform direction must support protocol-driven integrations, with MCP boundaries preferred for external operational systems.
- FR-10: Future agents must not request write access to Azure resources for remediation.
- FR-11: Agent-specific recommendations must include confidence, assumptions, evidence, and human validation steps.
- FR-12: The platform must support shared configuration concepts without hiding domain-specific permissions or data access.
- FR-13: Quality governance must allow shared regression checks across all agents and domain-specific checks per agent.
- FR-14: The system must avoid cross-agent amplification of weak evidence. One agent's unsupported hypothesis must not become another agent's assumed fact.
- FR-15: The platform must allow agents to remain useful independently; multi-agent orchestration should not be required for the FinOps agent to work.

## Non-Functional Requirements

- Focus: Expansion must preserve the clarity and usefulness of each individual agent.
- Trust: Shared platform behavior must make agent outputs easier to audit and challenge.
- Extensibility: New agents should reuse common contracts where they create real consistency, not where they obscure domain needs.
- Safety: Read-only operation and human decision authority must remain stable platform expectations.
- Observability: Langfuse traces, datasets, experiments, and scores must remain central across agents.
- Maintainability: Shared components should reduce duplication without creating a rigid platform that slows domain iteration.
- Privacy: Local-first and operator-controlled data handling must remain default expectations.
- Enterprise fit: The platform should match how engineering organizations review operations: by domain, ownership, evidence, and risk.

## Risks

- Expanding too early could weaken the FinOps agent before it proves value.
- A platform abstraction may become too generic and reduce domain quality.
- Cross-agent summaries may create misleading conclusions if evidence quality differs by domain.
- Users may infer autonomous operations capability from the phrase multi-agent platform unless boundaries are explicit.
- Shared observability schemas may become either too rigid for new domains or too loose for useful comparison.
- Maintenance cost may increase faster than user value if too many agents are added.
- Domain agents may compete for attention, making project documentation harder to navigate.

## Open Questions

- What maturity threshold must the FinOps agent meet before the project accepts a second agent?
- Which adjacent domain is the best next candidate: reliability, capacity, governance, or security posture?
- What shared trace fields are truly platform-level versus FinOps-specific?
- How should cross-agent conflicts be represented when agents produce different interpretations of the same evidence?
- What governance process should approve new domain agents?
- How should evaluation datasets be organized across shared and domain-specific cases?
- What language should the project use to avoid implying autonomous remediation or hosted platform ambitions?

## Future Considerations

- Define an agent admission checklist covering domain fit, evidence availability, evaluation plan, and observability requirements.
- Add shared quality dashboards across agents once at least two agents exist.
- Create cross-domain report patterns for cost-reliability, cost-capacity, and governance-risk trade-offs.
- Explore additional MCP integrations beyond AMG-MCP where operational data lives outside Azure Managed Grafana.
- Support local suite runs for quarterly platform reviews or architecture assessments.
- Build teaching material that compares how different agents use the same observability and evaluation foundations.
- Revisit packaging and configuration once multiple agents make the local experience more complex.

## Success Criteria

- The FinOps agent can mature without being distorted by premature platform work.
- Future agents can reuse observability, evaluation, evidence, and reporting conventions without duplicating foundations.
- Multi-agent outputs remain explainable, scoped, and human-reviewed.
- Cross-domain narratives improve operational understanding without converting hypotheses into unsupported facts.
- Langfuse remains a central learning and quality platform across the agent family.
- Enterprise readers can understand the future direction while seeing that near-term scope remains disciplined.
