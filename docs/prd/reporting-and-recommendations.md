# Reporting and Recommendations PRD

## Overview

Az-Pixiu reports are the primary way users consume the agent's analysis. Reports must turn Azure cost, resource, and telemetry evidence into a clear engineering narrative without overstating certainty or implying autonomous action.

Recommendations are not casual chatbot advice. They are review artifacts for enterprise FinOps and platform engineering workflows. Each recommendation must explain what was observed, why it matters, what evidence supports it, what assumptions remain, and what a human operator could investigate next.

The reporting experience should support both interactive local use and reusable review outputs. The agent should help engineers move faster while preserving the discipline expected in cost governance, architecture review, and operational decision-making.

## Current Implementation Status

Each analysis run currently writes `report.md`, `report.html`, and `run.json`. Reports include Scope & Data Sources, Run Quality, Cost Summary Overview for `cost_summary`, Executive Summary, Recommendations, Hypotheses, Observed Facts, Data Quality, and Run Metadata. When waste lanes run, the report renders a deterministic Waste Candidates section; today that section is implemented for `orphan_public_ip` only. Run Quality is always rendered and is fed by `transport_summary`, freshness findings, run outcome, and cost-scope coverage. Continuity markers such as "unchanged for N weeks" remain planned even though prior-run context is already available to the reasoner.

## Problem Statement

Cost data is often available but hard to turn into a trustworthy optimization plan. Raw tables show where money was spent, but they do not explain whether the spend is expected, whether a resource is underused, whether a cost increase was tied to operational change, or which issue deserves attention first.

AI-generated recommendations can make this worse if they sound confident without evidence. Enterprise users need recommendations that can be inspected, challenged, copied into existing review workflows, and tied back to source data.

Az-Pixiu needs a reporting and recommendation model that prioritizes explainability, evidence, confidence, and human decision-making over dramatic automation claims.

## Goals

- Produce reports that synthesize Azure cost, resource, and telemetry evidence into a coherent operational narrative.
- Provide recommendations that are evidence-backed, prioritized, and reviewable.
- Distinguish observed facts, inferred causes, optimization options, and open validation steps.
- Make uncertainty and missing data visible.
- Support enterprise review contexts such as cost reviews, cleanup planning, tagging governance, and incident-adjacent cost analysis.
- Keep recommendations explicitly human-reviewed and read-only.
- Generate artifacts that can be evaluated for grounding, clarity, completeness, and usefulness.

## Non-Goals

- Reports will not be finance-approved budget forecasts.
- Recommendations will not trigger automatic Azure changes.
- The agent will not claim guaranteed savings when evidence only supports likely opportunity.
- The report experience will not replace Azure Cost Management, Grafana dashboards, or team-specific governance processes.
- The first version will not support every possible report format, export target, or stakeholder view.
- Reports will not hide data gaps to maintain a cleaner narrative.

## Personas

- FinOps engineer: Needs defensible optimization candidates and cost narratives for stakeholders.
- Platform engineer: Needs resource-level evidence for cleanup, resizing, tagging, and ownership reviews.
- Engineering manager: Needs a concise report that explains what changed and what actions are worth discussing.
- SRE: Needs cost changes correlated with reliability, performance, or scaling signals.
- Governance reviewer: Needs to understand whether recommendations follow policy and avoid unsupported claims.

## User Journeys

### Generate a Cost Surprise Report

A FinOps engineer runs Az-Pixiu for a subscription with an unexpected cost increase. The report summarizes the cost delta, identifies top contributors, correlates changes with resource and telemetry signals, and presents ranked hypotheses with evidence.

The user can separate confirmed cost drivers from possible causes that require further investigation.

### Prepare an Optimization Backlog

A platform engineer asks for underused and potentially wasteful resources across selected resource groups. The report groups recommendations by likely impact, confidence, and required validation. Each candidate includes the signals that make it suspicious and the reasons it may be a false positive.

The user turns the report into a human-owned backlog rather than an automated change plan.

### Review Tagging and Ownership Hygiene

A governance team runs a tagging hygiene report. The report shows untagged or inconsistently tagged spend, identifies high-cost gaps, and recommends where ownership cleanup would have the greatest effect.

The user receives a prioritized governance view tied to cost impact, not just resource counts.

### Share a Report With Stakeholders

An engineering manager uses an Az-Pixiu report as the starting point for a quarterly review. The report contains an executive summary, key findings, evidence references, caveats, and recommended discussion items.

The manager can edit the narrative while preserving links to underlying evidence.

## Functional Requirements

- FR-1: Reports must state the analysis scope, time window, comparison baseline, and data sources used.
- FR-2: Reports must include an executive summary that is concise but does not omit critical caveats.
- FR-3: Reports must separate findings from recommendations.
- FR-4: Each finding must include the observed evidence, affected scope, and why it matters.
- FR-5: Each recommendation must include priority, confidence, expected impact or impact category, supporting evidence, assumptions, validation steps, and suggested human owner or audience where inferable.
- FR-6: Recommendations must avoid commands that imply the agent has approved or executed remediation.
- FR-7: Reports must include data quality notes, including missing telemetry, inaccessible scopes, stale data, inconsistent tags, and unsupported resources.
- FR-8: Reports must support cost change narratives that compare current and baseline periods where data is available.
- FR-9: Reports must support resource-level optimization candidates for idle, underused, oversized, orphaned, or poorly tagged resources where evidence supports those categories.
- FR-10: Reports must support grouping by useful enterprise dimensions such as subscription, resource group, service, environment, owner tag, cost center tag, and resource type when available.
- FR-11: Reports must include evidence references that connect report statements to collected data and observability traces.
- FR-12: Reports must represent confidence in calibrated terms rather than unsupported certainty.
- FR-13: Reports must make false-positive considerations visible for recommendations that could be dangerous if accepted blindly.
- FR-14: Reports must be structured enough for evaluation and comparison across runs.
- FR-15: Reports should support multiple audience depths over time, such as summary, engineering detail, and audit appendix, without changing the underlying evidence contract.
- FR-16: When the analysis produces waste candidates, the report must include a dedicated waste-candidates section that groups candidates by category, names individual resources, cites the predicate that classified each candidate, and presents naming-pattern clusters as a single grouped recommendation rather than as many independent items.
- FR-17: When the analysis produces estimated weekly cost impacts, the report must render them as ranges with the rate source identified in a footnote, never as point figures presented with implicit certainty, and must visibly mark candidates whose SKU has no matching rate as "rate unavailable" rather than silently omitting them from totals. Observed billed cost, list-price exposure, and realizable savings are distinct quantities: reports must label them separately, must never present list-price exposure as observed cost or guaranteed savings, and must lower confidence and require reconciliation when the figures materially disagree.
- FR-18: Reports must include a "Run Quality" section that surfaces transport-level findings (rate limits, retries, partial failures) and data-freshness findings (period-end within posting-lag threshold, cross-subscription uniform-drop heuristic) as first-class report content, distinct from the existing data-quality section which describes coverage gaps in retrieved evidence.
- FR-19: When prior-run context is available for the same scope and analysis type, the report must mark waste candidates and recommendations with continuity indicators (for example, "unchanged for N weeks", "recurring from run X", "first appearance", "carrying forward week N") and must cite the prior-run evidence that justifies each marker. When prior-run context is not available, continuity markers must be absent rather than asserted by default.
- FR-20: When reports use local cached billing evidence, they must disclose the cache source, covered subscription-months, maturity status, retrieval timestamp, and any missing dimensions. Cached-final evidence must be clearly distinguished from live AMG-MCP evidence and from recent periods that were intentionally not cached.

## Non-Functional Requirements

- Explainability: A reviewer must be able to understand why each recommendation exists.
- Grounding: Reports must not include Azure resources, metrics, or cost figures that were not present in retrieved evidence or explicitly supplied context.
- Clarity: Reports should use precise enterprise engineering language and avoid generic assistant phrasing.
- Actionability: Recommendations should identify concrete validation or review steps without pretending to own remediation.
- Brevity with depth: Reports should prioritize the most important information while preserving access to supporting detail.
- Consistency: Report sections, terminology, and confidence language should remain stable enough for evaluation over time.
- Audit readiness: Reports should be suitable as review artifacts in internal engineering or cost-governance discussions.
- Accessibility: Markdown output should be readable in standard developer tools and version-control review flows.

## Risks

- Recommendations may sound more certain than the evidence allows.
- Estimated savings may be misleading if based on incomplete pricing, reservations, discounts, or business context.
- Reports may become too long for practical review if all evidence is included inline.
- Reports may become too terse to defend if evidence is summarized too aggressively.
- Stakeholders may treat recommendations as approved remediation tickets rather than analysis inputs.
- Poor tagging or ownership data may make prioritization appear more precise than it is.
- Report quality may vary significantly across model or prompt changes without strong evaluations.

## Open Questions

- What confidence vocabulary should be used consistently across reports?
- How should estimated cost impact be represented when only directional evidence is available? *(FR-17 commits to calibrated ranges with cited rate sources; the design in [cost-summary depth](../design/cost-summary-depth.md) §Gap 3 names the in-repo rate-card approach.)*
- Which report sections should be mandatory for every analysis type?
- Should the agent produce a single report format first or separate formats for investigation, review, and governance?
- How should recommendation identifiers persist across repeated runs? *(FR-19 commits to continuity markers backed by a deterministic recommendation signature; the design in [cost-summary depth](../design/cost-summary-depth.md) §Gap 5 names the substrate options.)*
- What is the right balance between inline evidence and trace-linked evidence?
- How should accepted, rejected, or deferred recommendations be captured for future learning?

## Future Considerations

- Add report variants tuned for executives, FinOps practitioners, platform engineers, and audit reviewers.
- Support trend reports across multiple repeated runs.
- Integrate human disposition fields, such as accepted, rejected, duplicate, false positive, or needs more data.
- Support organization-specific policy language for tagging, SKU guidance, and cost allocation.
- Add benchmark-style comparisons only where data quality and context support them.
- Provide report export options after the core Markdown experience is stable.
- Reuse the reporting model for future reliability, capacity, and security posture agents.

## Success Criteria

- Users can identify the top cost and optimization issues from a report without losing the evidence behind them.
- Recommendations consistently include evidence, assumptions, confidence, and human validation steps.
- Reports avoid autonomous remediation claims and do not imply guaranteed savings where not supported.
- Data gaps and uncertainty are visible enough to affect user interpretation.
- Report outputs can be scored in evaluations for grounding, clarity, actionability, and format consistency.
- Enterprise reviewers would consider the report suitable as a starting point for internal FinOps discussion.
