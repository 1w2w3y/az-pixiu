import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from '../model/client.js';
import { MockModelClient } from '../model/mock-client.js';

/**
 * "Smart" mock model client for the CLI's --mock-model flag. Analyze and
 * eval replay fixtures with different evidence ids, so a single
 * constant canned response can't cite a valid evidence_id everywhere.
 * Instead, this mock parses the fenced evidence in the reasoner's user
 * prompt. It synthesizes scenario-aware output for the cost-judgment eval
 * fixtures and falls back to a minimal-but-valid ReasoningOutput around the
 * first evidence id for every other fixture.
 *
 * Constraints honored:
 *   - Cited evidence_id must resolve in postProcessReasoning (§7.5 step 1).
 *   - Fact statement must contain no numbers not present in cited
 *     evidence — the synthesized statement has none.
 *   - Recommendation prose must avoid imperative remediation (read-only
 *     lint, §7.5 step 3).
 *   - Confidence dimensions and level must agree after derivation (§7.5
 *     step 4); we emit 'medium' with mixed dimensions.
 *
 * The planner schema is deliberately unsupported — CLI --mock-model
 * pairs with --use-playbook so the planner LLM never fires.
 */

export function buildCannedReasoningResponder(): (
  args: GenerateStructuredArgs<z.ZodTypeAny>,
) => unknown {
  return (args) => {
    if (args.schemaName === 'reasoner_output') {
      const evidence = evidenceInPrompt(args.userPrompt);
      const reconciliation = detectWasteCostReconciliation(evidence, args.userPrompt);
      if (reconciliation) {
        return buildWasteCostReconciliationOutput(reconciliation);
      }

      const concentration = detectHighCostWithoutUtilization(evidence, args.userPrompt);
      if (concentration) {
        return buildHighCostInvestigationOutput(concentration.costEvidenceId);
      }

      const evidenceId = firstEvidenceIdInPrompt(args.userPrompt) ?? 'ev-unknown';
      return buildCannedReasoningOutput(evidenceId);
    }
    if (args.schemaName === 'planner_output') {
      throw new Error(
        'eval --mock-model: planner LLM is not mocked. Combine with --use-playbook to bypass the planner.',
      );
    }
    throw new Error(`eval --mock-model: unknown schemaName "${args.schemaName}"`);
  };
}

interface PromptEvidence {
  evidence_id?: unknown;
  source_capability?: unknown;
  query_intent?: unknown;
  payload?: unknown;
}

interface ReconciliationScenario {
  costEvidenceIds: string[];
  wasteEvidenceId: string;
  observedComponentCostsUsd: number[];
  laneLowUsd: number;
  laneHighUsd: number;
}

interface HighCostScenario {
  costEvidenceId: string;
}

/**
 * Parse only the reasoner's fenced evidence JSON. The mock deliberately
 * ignores prose outside the data block so fixture tags or operator context
 * cannot accidentally turn into citations.
 */
function evidenceInPrompt(prompt: string): PromptEvidence[] {
  const open = '<evidence_block role="data">';
  const close = '</evidence_block>';
  const start = prompt.indexOf(open);
  const end = prompt.indexOf(close, start + open.length);
  if (start < 0 || end < 0) return [];

  try {
    const parsed: unknown = JSON.parse(prompt.slice(start + open.length, end).trim());
    return Array.isArray(parsed)
      ? parsed.filter((value): value is PromptEvidence => asRecord(value) !== undefined)
      : [];
  } catch {
    // Preserve the original smoke-test fallback for malformed/unexpected
    // prompts. Structured-output validation will still exercise the wiring.
    return [];
  }
}

function detectWasteCostReconciliation(
  evidence: readonly PromptEvidence[],
  prompt: string,
): ReconciliationScenario | undefined {
  const wasteRecords = evidence.filter(
    (record) =>
      record.source_capability === 'az_pixiu_waste_lane' &&
      record.query_intent === 'waste_candidate' &&
      typeof record.evidence_id === 'string',
  );
  if (wasteRecords.length === 0) return undefined;

  const costRecords = evidence.filter(
    (record) =>
      record.source_capability === 'amgmcp_cost_analysis' &&
      typeof record.evidence_id === 'string',
  );
  const observed = observedPublicIpCost(costRecords);
  const laneSummary = wasteRecords.find((record) => {
    const payload = asRecord(record.payload);
    return payload?.record_kind === 'lane_summary';
  });
  const summaryTotal = asRecord(asRecord(laneSummary?.payload)?.lane_total);
  const candidateLaneLow = wasteRecords.reduce((total, record) => {
    const payload = asRecord(record.payload);
    const impact = asRecord(payload?.estimated_weekly_impact);
    return impact?.kind === 'available' && isFiniteNumber(impact.low_usd)
      ? total + impact.low_usd
      : total;
  }, 0);
  const candidateLaneHigh = wasteRecords.reduce((total, record) => {
    const payload = asRecord(record.payload);
    const impact = asRecord(payload?.estimated_weekly_impact);
    return impact?.kind === 'available' && isFiniteNumber(impact.high_usd)
      ? total + impact.high_usd
      : total;
  }, 0);
  const laneLow = isFiniteNumber(summaryTotal?.low_usd)
    ? summaryTotal.low_usd
    : candidateLaneLow;
  const laneHigh = isFiniteNumber(summaryTotal?.high_usd)
    ? summaryTotal.high_usd
    : candidateLaneHigh;

  // The fixture's intended contradiction is semantic rather than an id
  // switch: the lane's lowest list-price exposure exceeds same-window
  // billed Public IP cost. The textual marker is a narrow fallback for a
  // future equivalent fixture whose Cost Analysis envelope lacks the
  // byResourceType projection.
  const hasConflict =
    observed !== undefined &&
    laneLow > observed.costUsd;
  const markedForReconciliation = /\b(?:billed[- ]cost|cost[- ]reconciliation)\b/i.test(prompt);
  if (!hasConflict && !markedForReconciliation) return undefined;

  const fallbackCostEvidenceId = costRecords[0]?.evidence_id;
  const costEvidenceIds = observed?.evidenceIds ??
    (typeof fallbackCostEvidenceId === 'string' ? [fallbackCostEvidenceId] : []);
  const wasteEvidenceId = laneSummary?.evidence_id ?? wasteRecords[0]?.evidence_id;
  if (
    costEvidenceIds.length === 0 ||
    typeof wasteEvidenceId !== 'string' ||
    observed === undefined ||
    laneLow <= 0 ||
    laneHigh < laneLow
  ) {
    return undefined;
  }

  return {
    costEvidenceIds,
    wasteEvidenceId,
    observedComponentCostsUsd: observed.componentCostsUsd,
    laneLowUsd: laneLow,
    laneHighUsd: laneHigh,
  };
}

function detectHighCostWithoutUtilization(
  evidence: readonly PromptEvidence[],
  prompt: string,
): HighCostScenario | undefined {
  if (!/"analysis_type":\s*"cost_summary"/.test(prompt)) return undefined;
  const hasUtilization = evidence.some(
    (record) =>
      record.source_capability === 'amgmcp_query_resource_metric' &&
      record.query_intent === 'utilization',
  );
  if (hasUtilization) return undefined;

  const concentration = dominantCostConcentration(evidence);
  const markedForEvidenceSufficiency =
    /\b(?:no[- ]utilization|missing[- ]utilization|evidence[- ]sufficiency)\b/i.test(prompt);
  if (!concentration && !markedForEvidenceSufficiency) return undefined;

  const fallback = evidence.find(
    (record) =>
      record.source_capability === 'amgmcp_cost_analysis' &&
      typeof record.evidence_id === 'string',
  );
  const costEvidenceId = concentration?.evidenceId ?? fallback?.evidence_id;
  return typeof costEvidenceId === 'string' ? { costEvidenceId } : undefined;
}

function observedPublicIpCost(
  records: readonly PromptEvidence[],
): { costUsd: number; componentCostsUsd: number[]; evidenceIds: string[] } | undefined {
  let costUsd = 0;
  const componentCostsUsd: number[] = [];
  const evidenceIds = new Set<string>();
  for (const record of records) {
    const payload = asRecord(record.payload);
    const subscriptions = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
    for (const value of subscriptions) {
      const subscription = asRecord(value);
      const byResourceType = Array.isArray(subscription?.byResourceType)
        ? subscription.byResourceType
        : [];
      for (const item of byResourceType) {
        const entry = asRecord(item);
        if (
          typeof entry?.name !== 'string' ||
          entry.name.toLowerCase() !== 'microsoft.network/publicipaddresses' ||
          !isFiniteNumber(entry.cost)
        ) continue;
        costUsd += entry.cost;
        componentCostsUsd.push(entry.cost);
        evidenceIds.add(record.evidence_id as string);
      }
    }
  }
  return evidenceIds.size > 0
    ? { costUsd, componentCostsUsd, evidenceIds: [...evidenceIds] }
    : undefined;
}

function dominantCostConcentration(
  evidence: readonly PromptEvidence[],
): { evidenceId: string } | undefined {
  const categoryCosts = new Map<string, number>();
  let totalCost = 0;
  let evidenceId: string | undefined;

  for (const record of evidence) {
    if (
      record.source_capability !== 'amgmcp_cost_analysis' ||
      typeof record.evidence_id !== 'string'
    ) continue;
    const payload = asRecord(record.payload);
    const subscriptions = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
    for (const value of subscriptions) {
      const subscription = asRecord(value);
      if (!subscription) continue;
      if (isFiniteNumber(subscription.totalCost)) totalCost += subscription.totalCost;
      const breakdown = Array.isArray(subscription.byResourceType)
        ? subscription.byResourceType
        : Array.isArray(subscription.byService)
          ? subscription.byService
          : [];
      for (const item of breakdown) {
        const entry = asRecord(item);
        if (typeof entry?.name !== 'string' || !isFiniteNumber(entry.cost)) continue;
        const key = entry.name.toLowerCase();
        categoryCosts.set(key, (categoryCosts.get(key) ?? 0) + entry.cost);
        evidenceId ??= record.evidence_id;
      }
    }
  }

  const dominantCost = Math.max(0, ...categoryCosts.values());
  return evidenceId && totalCost >= 1_000 && dominantCost / totalCost >= 0.65
    ? { evidenceId }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function buildCannedMockModelClient(): ModelClient {
  return new MockModelClient({ responses: buildCannedReasoningResponder() });
}

function firstEvidenceIdInPrompt(prompt: string): string | undefined {
  // Reasoner.buildUserPrompt embeds the evidence as JSON. The first
  // "evidence_id": "<value>" hit is the first record passed in.
  const match = /"evidence_id":\s*"([^"]+)"/.exec(prompt);
  return match?.[1];
}

function buildHighCostInvestigationOutput(costEvidenceId: string): unknown {
  const mixedDims = {
    evidence_coverage: 'adequate' as const,
    signal_quality: 'mixed' as const,
    signal_agreement: 'mixed' as const,
  };
  return {
    facts: [
      {
        fact_id: 'fact-mock-cost-concentration',
        statement:
          'Cost Analysis shows that one service category materially concentrates the billed cost in scope.',
        evidence_ids: [costEvidenceId],
        scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      },
    ],
    hypotheses: [
      {
        hypothesis_id: 'hyp-mock-cost-investigation',
        statement:
          'The concentration warrants a bounded service review, but billed cost alone does not establish underutilization or overprovisioning.',
        confidence: {
          level: 'medium',
          rationale: 'Cost concentration is observed, while utilization and configuration signals are absent.',
          dimensions: mixedDims,
        },
        supported_by_fact_ids: ['fact-mock-cost-concentration'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: ['dq-mock-missing-utilization'],
      },
    ],
    recommendations: [
      {
        recommendation_id: 'rec-mock-utilization-review',
        priority: 'medium',
        confidence: {
          level: 'medium',
          rationale: 'The investigation is grounded in billed cost, but no utilization conclusion is supported.',
          dimensions: mixedDims,
        },
        impact: 'unknown',
        statement:
          'Consider collecting per-resource Stock Keeping Unit (SKU), age, high-availability configuration, and multi-window Central Processing Unit (CPU), memory, input/output, and connection distributions before any capacity or rightsizing decision.',
        supported_by_hypothesis_ids: ['hyp-mock-cost-investigation'],
        supported_by_fact_ids: ['fact-mock-cost-concentration'],
        assumptions: [
          'Current Cost Analysis evidence contains billed cost but no raw utilization metrics.',
        ],
        validation_steps: [
          'Compare utilization distributions across representative windows and reconcile them with the deployed configuration.',
        ],
        false_positive_considerations: [
          'High spend may reflect legitimate load, availability requirements, reserved capacity, or negotiated pricing.',
        ],
        suggested_audience: 'finops_engineer',
        suggested_human_actions: [
          'Investigate the concentrated service only after the missing utilization and configuration evidence is available.',
        ],
        recommendation_signature: 'cost-concentration-evidence-review',
      },
    ],
    data_quality: [
      {
        dq_id: 'dq-mock-missing-utilization',
        category: 'missing_telemetry',
        affected_capability: 'amgmcp_query_resource_metric',
        affected_scope_subset: null,
        consequence_for_analysis:
          'The run cannot determine whether the concentrated service is idle, underused, oversized, or overprovisioned.',
        impact_on_recommendations: ['rec-mock-utilization-review'],
        actionable_hint:
          'Collect raw utilization metrics and configuration context before estimating any capacity change or savings.',
      },
    ],
  };
}

function buildWasteCostReconciliationOutput(scenario: ReconciliationScenario): unknown {
  const mixedDims = {
    evidence_coverage: 'adequate' as const,
    signal_quality: 'mixed' as const,
    signal_agreement: 'mixed' as const,
  };
  const observedCosts = scenario.observedComponentCostsUsd
    .map((cost) => `$${cost.toFixed(2)}`)
    .join(' and ');
  const laneRange = `$${scenario.laneLowUsd.toFixed(2)}-$${scenario.laneHighUsd.toFixed(2)}`;
  return {
    facts: [
      {
        fact_id: 'fact-mock-pip-billed-cost',
        statement:
          `Cost Analysis returned observed billed public IP address costs of ${observedCosts} for the analysis window.`,
        evidence_ids: scenario.costEvidenceIds,
        scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      },
      {
        fact_id: 'fact-mock-pip-lane',
        statement:
          `The orphan_public_ip lane summary reported list-price exposure of ${laneRange} per week for its review candidates.`,
        evidence_ids: [scenario.wasteEvidenceId],
        scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      },
    ],
    hypotheses: [
      {
        hypothesis_id: 'hyp-mock-pip-reconciliation',
        statement:
          'The higher rate-card exposure and lower observed billing are different quantities that require attribution and ownership reconciliation.',
        confidence: {
          level: 'medium',
          rationale: 'Both evidence families are available, but meter attribution and resource intent remain unresolved.',
          dimensions: mixedDims,
        },
        supported_by_fact_ids: ['fact-mock-pip-billed-cost', 'fact-mock-pip-lane'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: [],
      },
    ],
    recommendations: [
      {
        recommendation_id: 'rec-mock-pip-reconciliation',
        priority: 'medium',
        confidence: {
          level: 'medium',
          rationale: 'The discrepancy is grounded, while realizable impact remains uncertain.',
          dimensions: mixedDims,
        },
        impact: 'unknown',
        statement:
          `Consider reconciling the observed billed public IP address costs of ${observedCosts} against the orphan_public_ip lane's ${laneRange} per week of list-price exposure; realizable savings remain unknown until billing attribution and ownership are reviewed.`,
        supported_by_hypothesis_ids: ['hyp-mock-pip-reconciliation'],
        supported_by_fact_ids: ['fact-mock-pip-billed-cost', 'fact-mock-pip-lane'],
        assumptions: [
          'The rate-card exposure is a review upper bound, not realized or guaranteed savings.',
        ],
        validation_steps: [
          'Compare meter attribution, discounts or reservations, region and SKU matching, resource age, posting lag, and the rate-card capture date.',
        ],
        false_positive_considerations: [
          'Reserved deployment pools, transient attachment states, and intentionally held capacity can make an unassociated address legitimate.',
        ],
        suggested_audience: 'finops_engineer',
        suggested_human_actions: [
          'Investigate ownership and lifecycle intent before treating any list-price exposure as avoidable cost.',
        ],
        recommendation_signature: 'pip-cost-reconciliation-review',
      },
    ],
    data_quality: [],
  };
}

function buildCannedReasoningOutput(evidenceId: string): unknown {
  const mixedDims = {
    evidence_coverage: 'adequate' as const,
    signal_quality: 'mixed' as const,
    signal_agreement: 'mixed' as const,
  };
  return {
    facts: [
      {
        fact_id: 'fact-mock-1',
        statement: 'mocked smoke fact: evidence was retrieved without errors',
        evidence_ids: [evidenceId],
        scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      },
    ],
    hypotheses: [
      {
        hypothesis_id: 'hyp-mock-1',
        statement: 'mocked smoke hypothesis derived from the retrieved evidence',
        confidence: { level: 'medium', rationale: 'mocked', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-mock-1'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: [],
      },
    ],
    recommendations: [
      {
        recommendation_id: 'rec-mock-1',
        priority: 'medium',
        confidence: { level: 'medium', rationale: 'mocked', dimensions: mixedDims },
        impact: 'unknown',
        statement: 'consider reviewing the recorded evidence to validate the synthesized signal',
        supported_by_hypothesis_ids: ['hyp-mock-1'],
        supported_by_fact_ids: ['fact-mock-1'],
        assumptions: ['mocked reasoning output — not a real recommendation'],
        validation_steps: ['inspect the run.json artefact for the underlying payload'],
        false_positive_considerations: ['this is a mock; treat as a wiring smoke test only'],
        suggested_audience: 'platform_engineer',
        suggested_human_actions: ['review the recorded evidence before relying on this output'],
        recommendation_signature: 'mock-smoke-test',
      },
    ],
    data_quality: [],
  };
}
