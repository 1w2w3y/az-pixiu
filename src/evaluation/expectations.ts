import type { DatasetItem } from './dataset.js';
import type { EvidenceRecord, ReasoningOutput } from '../schemas/index.js';
import type { WasteLaneResult } from '../playbooks/waste-lanes/types.js';

/**
 * Checks a dataset item's `expectations` block (loaded from JSON; see
 * {@link DatasetItem}) against the artefacts a run produced. These are
 * dataset-level invariants that sit *on top of* the rubric checks in
 * {@link ./scoring.ts}: a run can score green on every rubric and still
 * fail an item-specific expectation (e.g., "this item must surface a
 * permission_gap DQ"). The two layers are deliberately separate so the
 * generic rubrics remain dataset-agnostic.
 *
 * The orchestrator merges normalizer-DQs with failure-DQs before scoring,
 * but the failure-DQs do not survive into ReasoningOutput.data_quality
 * (which the reasoner emits). For `expected_dq_categories` we therefore
 * combine reasoning DQs *and* the categories present on evidence records
 * that the normalizer flagged as wrapped errors. Pass the full evidence
 * list so the checker can see both surfaces.
 */

export interface ExpectationResult {
  expectation: string;
  passed: boolean;
  details?: string;
}

export interface ExpectationsAggregate {
  results: ExpectationResult[];
  passed_all: boolean;
  pass_count: number;
  fail_count: number;
}

export interface CheckExpectationsInput {
  item: DatasetItem;
  reasoning: ReasoningOutput;
  evidence: EvidenceRecord[];
  /**
   * Capabilities the run *attempted* to call, in the order they were
   * planned. Distinct from the surviving evidence list because a failed
   * call appears here even when its record was suppressed by the
   * failure_taxonomy and never made it to the normalizer. The runner
   * supplies this from the plan it executed.
   */
  invoked_capabilities: string[];
  /**
   * DQ categories the pipeline surfaced *before* the reasoner ran
   * (normalizer findings plus failure-taxonomy findings). Independent
   * from {@link reasoning}.data_quality so an expected `authz_gap`
   * resolves whether the reasoner echoed it forward or not.
   */
  input_dq_categories: string[];
  /** Deterministic waste-lane output from the orchestrator, when present. */
  waste_lanes?: readonly WasteLaneResult[];
}

export function checkExpectations(input: CheckExpectationsInput): ExpectationsAggregate {
  const results: ExpectationResult[] = [];
  const expectations = input.item.expectations;
  if (!expectations) {
    return { results: [], passed_all: true, pass_count: 0, fail_count: 0 };
  }

  if (typeof expectations.min_recommendations === 'number') {
    const actual = input.reasoning.recommendations.length;
    const min = expectations.min_recommendations;
    results.push(
      actual >= min
        ? { expectation: 'min_recommendations', passed: true }
        : {
            expectation: 'min_recommendations',
            passed: false,
            details: `expected ≥ ${min}, got ${actual}`,
          },
    );
  }

  if (expectations.expected_dq_categories && expectations.expected_dq_categories.length > 0) {
    const observed = new Set<string>([
      ...input.reasoning.data_quality.map((d) => d.category),
      ...input.input_dq_categories,
    ]);
    const missing = expectations.expected_dq_categories.filter((c) => !observed.has(c));
    results.push(
      missing.length === 0
        ? { expectation: 'expected_dq_categories', passed: true }
        : {
            expectation: 'expected_dq_categories',
            passed: false,
            details: `missing categories: ${missing.join(', ')}; observed: ${[...observed].join(', ') || '(none)'}`,
          },
    );
  }

  if (
    expectations.expected_capabilities_invoked &&
    expectations.expected_capabilities_invoked.length > 0
  ) {
    const observed = new Set<string>([
      ...input.invoked_capabilities,
      ...input.evidence.map((e) => e.source_capability),
      ...(input.waste_lanes ?? []).map((lane) => lane.source_capability),
    ]);
    const missing = expectations.expected_capabilities_invoked.filter((c) => !observed.has(c));
    results.push(
      missing.length === 0
        ? { expectation: 'expected_capabilities_invoked', passed: true }
        : {
            expectation: 'expected_capabilities_invoked',
            passed: false,
            details: `missing capabilities: ${missing.join(', ')}; invoked: ${[...observed].join(', ') || '(none)'}`,
          },
    );
  }

  const hasWasteLaneContract =
    expectations.expected_waste_lane !== undefined ||
    expectations.expected_candidate_ids !== undefined ||
    expectations.excluded_candidate_ids !== undefined ||
    expectations.expected_candidate_count !== undefined ||
    expectations.max_unparsed_rows !== undefined ||
    expectations.max_rejected_rows !== undefined ||
    expectations.expected_lane_total !== undefined ||
    expectations.require_waste_cost_reconciliation !== undefined;
  let evaluatedLanes = [...(input.waste_lanes ?? [])];
  if (hasWasteLaneContract) {
    const expectedLaneName = expectations.expected_waste_lane;
    const matching = expectedLaneName
      ? evaluatedLanes.filter((lane) => lane.lane === expectedLaneName)
      : [];
    const lane = matching.length === 1 ? matching[0] : undefined;
    const laneReady = lane !== undefined && !lane.failed;
    results.push(
      laneReady
        ? { expectation: 'expected_waste_lane', passed: true }
        : {
            expectation: 'expected_waste_lane',
            passed: false,
            details:
              expectedLaneName === undefined
                ? 'expected_waste_lane is required for waste-candidate expectations'
                : matching.length === 0
                  ? `lane ${expectedLaneName} was not produced`
                  : matching.length > 1
                    ? `lane ${expectedLaneName} was produced ${matching.length} times`
                    : `lane ${expectedLaneName} failed before completing enumeration`,
          },
    );
    evaluatedLanes = lane ? [lane] : [];
  }

  const actualCandidates = evaluatedLanes.flatMap((lane) =>
    lane.candidates.map((candidate) => candidate.candidate.resource_id),
  );
  const actualCandidateKeys = new Set(actualCandidates.map(normalizeResourceId));

  if (expectations.expected_candidate_ids) {
    const expected = expectations.expected_candidate_ids;
    const expectedKeys = new Set(expected.map(normalizeResourceId));
    const missing = expected.filter((id) => !actualCandidateKeys.has(normalizeResourceId(id)));
    const unexpected = actualCandidates.filter((id) => !expectedKeys.has(normalizeResourceId(id)));
    const duplicateExpected = findDuplicateResourceIds(expected);
    const duplicateActual = findDuplicateResourceIds(actualCandidates);
    results.push(
      missing.length === 0 &&
        unexpected.length === 0 &&
        duplicateExpected.length === 0 &&
        duplicateActual.length === 0
        ? { expectation: 'expected_candidate_ids', passed: true }
        : {
            expectation: 'expected_candidate_ids',
            passed: false,
            details:
              `missing: ${missing.join(', ') || '(none)'}; ` +
              `unexpected: ${unexpected.join(', ') || '(none)'}; ` +
              `duplicate expected: ${duplicateExpected.join(', ') || '(none)'}; ` +
              `duplicate actual: ${duplicateActual.join(', ') || '(none)'}`,
          },
    );
  }

  if (expectations.excluded_candidate_ids && expectations.excluded_candidate_ids.length > 0) {
    const leaked = expectations.excluded_candidate_ids.filter((id) =>
      actualCandidateKeys.has(normalizeResourceId(id)),
    );
    results.push(
      leaked.length === 0
        ? { expectation: 'excluded_candidate_ids', passed: true }
        : {
            expectation: 'excluded_candidate_ids',
            passed: false,
            details: `excluded candidates surfaced: ${leaked.join(', ')}`,
          },
    );
  }

  if (typeof expectations.expected_candidate_count === 'number') {
    const expected = expectations.expected_candidate_count;
    results.push(
      actualCandidates.length === expected
        ? { expectation: 'expected_candidate_count', passed: true }
        : {
            expectation: 'expected_candidate_count',
            passed: false,
            details: `expected ${expected}, got ${actualCandidates.length}`,
          },
    );
  }

  if (typeof expectations.max_unparsed_rows === 'number') {
    const actual = evaluatedLanes.reduce(
      (sum, lane) => sum + lane.unparsed_row_count,
      0,
    );
    const max = expectations.max_unparsed_rows;
    results.push(
      actual <= max
        ? { expectation: 'max_unparsed_rows', passed: true }
        : {
            expectation: 'max_unparsed_rows',
            passed: false,
            details: `expected <= ${max}, got ${actual}`,
          },
    );
  }

  if (typeof expectations.max_rejected_rows === 'number') {
    const actual = evaluatedLanes.reduce(
      (sum, lane) => sum + lane.rejected_row_count,
      0,
    );
    const max = expectations.max_rejected_rows;
    results.push(
      actual <= max
        ? { expectation: 'max_rejected_rows', passed: true }
        : {
            expectation: 'max_rejected_rows',
            passed: false,
            details: `expected <= ${max}, got ${actual}`,
          },
    );
  }

  if (expectations.expected_lane_total) {
    const lane = evaluatedLanes.length === 1 ? evaluatedLanes[0] : undefined;
    const expected = expectations.expected_lane_total;
    const actual = lane?.lane_total;
    const mismatches = actual
      ? (['low_usd', 'high_usd', 'point_usd', 'available_count', 'unavailable_count'] as const)
          .filter((key) => actual[key] !== expected[key])
          .map((key) => `${key}: expected ${expected[key]}, got ${actual[key]}`)
      : ['named lane total was not available'];
    results.push(
      mismatches.length === 0
        ? { expectation: 'expected_lane_total', passed: true }
        : {
            expectation: 'expected_lane_total',
            passed: false,
            details: mismatches.join('; '),
          },
    );
  }

  if (expectations.require_utilization_evidence_for_optimization_claims) {
    results.push(checkUtilizationEvidenceForOptimizationClaims(input));
  }

  if (expectations.require_waste_cost_reconciliation) {
    results.push(
      checkWasteCostReconciliation(
        input,
        expectations.require_waste_cost_reconciliation.lane,
        expectations.require_waste_cost_reconciliation.resource_type,
      ),
    );
  }

  const pass_count = results.filter((r) => r.passed).length;
  return {
    results,
    passed_all: pass_count === results.length,
    pass_count,
    fail_count: results.length - pass_count,
  };
}

function normalizeResourceId(id: string): string {
  return id.toLowerCase();
}

function findDuplicateResourceIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    const key = normalizeResourceId(id);
    if (seen.has(key)) duplicates.add(id);
    else seen.add(key);
  }
  return [...duplicates];
}

const ASSERTIVE_OPTIMIZATION_RE =
  /\b(?:underutili[sz]ed|underused|idle|oversi[sz]ed|overprovisioned|downsize|downsizing|downgrade|scale\s+down|reduce\s+(?:the\s+)?(?:sku|tier|capacity|v?cores?|nodes?|instances?)|(?:smaller|lower)\s+(?:sku|tier|size)|(?:(?:move|switch|resize)\b|change\s+(?:the\s+)?(?:sku|tier|server|database|resource|instance)\b)[^.!;]{0,60}\bto\s+(?:Standard_[A-Za-z0-9_]+|(?:a\s+)?(?:smaller|lower)\s+(?:sku|tier|size))|(?:reduce|cut)\s+(?:the\s+)?(?:spend|costs?)\s+by\s+~?\$|halve\s+(?:the\s+)?(?:v?cores?|capacity|nodes?|instances?)|right-?size\s+(?:to|from|the)|save\s+~?\$|savings?\s+(?:of|around|up\s+to)\s+~?\$)/i;
const NEGATED_OPTIMIZATION_SPAN_RE =
  /\b(?:do(?:es)?\s+not|must\s+not|should\s+not|cannot|can't|no\s+evidence\s+to|insufficient\s+evidence\s+to)\b(?:(?![;!?]|\.(?=\s|$)|\b(?:but|however|yet|although|though|while|whereas|because)\b)[\s\S]){0,240}/gi;
const DEFERRED_OPTIMIZATION_ASSESSMENT_RE =
  /\b(?:before|prior\s+to)\b[^.!;]{0,120}\b(?:assess(?:ing)?|decid(?:e|ing)|determin(?:e|ing)|evaluat(?:e|ing)|conclud(?:e|ing)|consider(?:ing)?)\b[^.!;]{0,40}\b(?:whether|if)\b[^.!;]{0,80}\b(?:underutili[sz]ed|underused|idle|oversi[sz]ed|overprovisioned|downsize|downsizing|downgrade|scale\s+down|reduce|cut|halve|(?:smaller|lower)\s+(?:sku|tier|size)|(?:move|switch|change|resize)|right-?size)\b/i;
const INSUFFICIENT_OPTIMIZATION_ASSESSMENT_RE =
  /\b(?:insufficient|inadequate|not\s+enough)\b[^.!;]{0,100}\bto\s+(?:assess|decide|determine|evaluate|conclude|consider|judge)\b[^.!;]{0,40}\b(?:whether|if)\b[^.!;]{0,160}\b(?:underutili[sz]ed|underused|idle|oversi[sz]ed|overprovisioned|downsize|downsizing|downgrade|scale\s+down|reduce|cut|halve|(?:smaller|lower)\s+(?:sku|tier|size)|(?:move|switch|change|resize)|right-?size)\b/i;

function checkUtilizationEvidenceForOptimizationClaims(
  input: CheckExpectationsInput,
): ExpectationResult {
  const evidenceById = new Map(input.evidence.map((record) => [record.evidence_id, record] as const));
  const violations: string[] = [];
  const hasCitedUtilization = (evidenceIds: Iterable<string>): boolean =>
    [...evidenceIds].some((evidenceId) => {
      const record = evidenceById.get(evidenceId);
      return (
        record?.query_intent === 'utilization' &&
        record.source_capability === 'amgmcp_query_resource_metric'
      );
    });

  for (const fact of input.reasoning.facts) {
    if (
      hasAssertiveOptimizationClaim(fact.statement) &&
      !hasCitedUtilization(fact.evidence_ids)
    ) {
      violations.push(
        `${fact.fact_id} makes an assertive optimization claim without cited raw utilization evidence`,
      );
    }
  }
  for (const hypothesis of input.reasoning.hypotheses) {
    if (!hasAssertiveOptimizationClaim(hypothesis.statement)) continue;
    const evidenceIds = evidenceIdsForFactIds(input.reasoning, hypothesis.supported_by_fact_ids);
    if (!hasCitedUtilization(evidenceIds)) {
      violations.push(
        `${hypothesis.hypothesis_id} makes an assertive optimization claim without cited raw utilization evidence`,
      );
    }
  }
  for (const recommendation of input.reasoning.recommendations) {
    const text = recommendationText(recommendation);
    if (!hasAssertiveOptimizationClaim(text)) continue;
    const citedEvidence = recommendationEvidenceIds(input.reasoning, recommendation.recommendation_id);
    if (!hasCitedUtilization(citedEvidence)) {
      violations.push(
        `${recommendation.recommendation_id} makes an assertive optimization claim without cited raw utilization evidence`,
      );
    }
  }
  return violations.length === 0
    ? { expectation: 'require_utilization_evidence_for_optimization_claims', passed: true }
    : {
        expectation: 'require_utilization_evidence_for_optimization_claims',
        passed: false,
        details: violations.join('; '),
      };
}

function hasAssertiveOptimizationClaim(text: string): boolean {
  const withoutNegatedSpans = text.replace(
    new RegExp(NEGATED_OPTIMIZATION_SPAN_RE.source, NEGATED_OPTIMIZATION_SPAN_RE.flags),
    (span) => (ASSERTIVE_OPTIMIZATION_RE.test(span) ? '' : span),
  );
  const withoutDeferredAssessments = withoutNegatedSpans.replace(
    new RegExp(
      DEFERRED_OPTIMIZATION_ASSESSMENT_RE.source,
      `${DEFERRED_OPTIMIZATION_ASSESSMENT_RE.flags}g`,
    ),
    '',
  );
  const withoutInsufficientAssessments = withoutDeferredAssessments.replace(
    new RegExp(
      INSUFFICIENT_OPTIMIZATION_ASSESSMENT_RE.source,
      `${INSUFFICIENT_OPTIMIZATION_ASSESSMENT_RE.flags}g`,
    ),
    '',
  );
  return ASSERTIVE_OPTIMIZATION_RE.test(withoutInsufficientAssessments);
}

function checkWasteCostReconciliation(
  input: CheckExpectationsInput,
  laneName: string,
  resourceType: string,
): ExpectationResult {
  const expectation = 'require_waste_cost_reconciliation';
  const matching = (input.waste_lanes ?? []).filter((lane) => lane.lane === laneName);
  if (matching.length !== 1) {
    return {
      expectation,
      passed: false,
      details: `expected exactly one ${laneName} lane, got ${matching.length}`,
    };
  }
  const lane = matching[0]!;
  if (
    lane.failed ||
    lane.unparsed_row_count !== 0 ||
    lane.rejected_row_count !== 0 ||
    lane.lane_total.available_count === 0
  ) {
    return {
      expectation,
      passed: false,
      details:
        `lane was not a complete priced enumeration: failed=${lane.failed}, ` +
        `unparsed=${lane.unparsed_row_count}, rejected=${lane.rejected_row_count}, ` +
        `available=${lane.lane_total.available_count}`,
    };
  }

  const observed = observedResourceTypeCost(input, resourceType);
  if (!observed.ok) {
    return { expectation, passed: false, details: observed.details };
  }
  if (lane.lane_total.low_usd <= observed.costUsd) {
    return {
      expectation,
      passed: false,
      details:
        `fixture did not produce the intended conflict: lane low ${lane.lane_total.low_usd} USD ` +
        `must exceed observed ${observed.costUsd} USD`,
    };
  }

  const evidenceById = new Map(input.evidence.map((record) => [record.evidence_id, record] as const));
  const compliant = input.reasoning.recommendations.some((recommendation) => {
    const text = recommendationText(recommendation);
    const evidenceIds = recommendationEvidenceIds(
      input.reasoning,
      recommendation.recommendation_id,
      true,
    );
    const citedRecords = [...evidenceIds]
      .map((id) => evidenceById.get(id))
      .filter((record): record is EvidenceRecord => record !== undefined);
    return (
      observed.evidenceIds.every((evidenceId) => evidenceIds.has(evidenceId)) &&
      citedRecords.some((record) =>
        isLaneSummaryEvidence(record, laneName, lane, input.item.scope)
      ) &&
      /\b(?:observed|billed|billing|cost\s+analysis)\b/i.test(text) &&
      /\b(?:list-?price|rate\s+card|exposure|upper\s+bound|ceiling|reconcil)/i.test(text) &&
      mentionsLaneTotalRange(text, lane.lane_total.low_usd, lane.lane_total.high_usd) &&
      mentionsObservedCost(text, observed) &&
      hasQualifiedSavingsFraming(text) &&
      !hasUnqualifiedSavingsClaim(text)
    );
  });
  return compliant
    ? { expectation, passed: true }
    : {
        expectation,
        passed: false,
        details:
          `no recommendation cited both billed-cost and ${laneName} lane-summary evidence while ` +
          `reporting exact ${lane.lane_total.low_usd}-${lane.lane_total.high_usd} USD list-price ` +
          `exposure and ${observed.costUsd} USD observed cost (or all billed components), with ` +
          `realizable savings kept qualified`,
      };
}

function isLaneSummaryEvidence(
  record: EvidenceRecord,
  laneName: string,
  lane: WasteLaneResult,
  scope: DatasetItem['scope'],
): boolean {
  if (
    record.source_capability !== 'az_pixiu_waste_lane' ||
    record.payload_ref.kind !== 'inline' ||
    record.time_window.start !== scope.time_window.start ||
    record.time_window.end !== scope.time_window.end ||
    !sameStringSet(record.scope_subset.subscription_ids, scope.subscription_ids)
  ) {
    return false;
  }
  const payload = asRecord(record.payload_ref.data);
  const total = asRecord(payload?.lane_total);
  const candidateEvidenceIds = Array.isArray(payload?.candidate_evidence_ids)
    ? payload.candidate_evidence_ids.filter((value): value is string => typeof value === 'string')
    : [];
  const expectedCandidateEvidenceIds = lane.candidates
    .map((candidate) => candidate.evidence.evidence_id)
    .sort();
  return (
    payload?.record_kind === 'lane_summary' &&
    payload.waste_lane === laneName &&
    payload.candidate_count === lane.candidates.length &&
    sameStringSet(candidateEvidenceIds, expectedCandidateEvidenceIds) &&
    amountsEqual(Number(total?.low_usd), lane.lane_total.low_usd) &&
    amountsEqual(Number(total?.high_usd), lane.lane_total.high_usd) &&
    amountsEqual(Number(total?.point_usd), lane.lane_total.point_usd) &&
    total?.available_count === lane.lane_total.available_count &&
    total?.unavailable_count === lane.lane_total.unavailable_count
  );
}

function mentionsLaneTotalRange(text: string, expectedLow: number, expectedHigh: number): boolean {
  for (const range of moneyRanges(text)) {
    if (
      amountsEqual(range.low, expectedLow) &&
      amountsEqual(range.high, expectedHigh) &&
      /^\s*(?:USD\b\s*)?(?:\/\s*week\b|per\s+week\b|weekly\b)/i.test(
        text.slice(range.end, range.end + 32),
      )
    ) {
      return true;
    }
  }
  return false;
}

function moneyRanges(text: string): Array<{ low: number; high: number; end: number }> {
  const ranges: Array<{ low: number; high: number; end: number }> = [];
  const patterns = [
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[-–—]|\bto\b)\s*\$?\s*([\d,]+(?:\.\d+)?)/gi,
    /\bUSD\s*([\d,]+(?:\.\d+)?)\s*(?:[-–—]|\bto\b)\s*(?:USD\s*)?([\d,]+(?:\.\d+)?)/gi,
    /\b([\d,]+(?:\.\d+)?)\s*USD\s*(?:[-–—]|\bto\b)\s*([\d,]+(?:\.\d+)?)\s*USD\b/gi,
    /\b([\d,]+(?:\.\d+)?)\s*(?:[-–—]|\bto\b)\s*([\d,]+(?:\.\d+)?)\s*USD\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({
        low: Number(match[1]?.replaceAll(',', '')),
        high: Number(match[2]?.replaceAll(',', '')),
        end: (match.index ?? 0) + match[0].length,
      });
    }
  }
  return ranges;
}

const OBSERVED_COST_SPAN_RE =
  /\b(?:observed|billed|billing|cost\s+analysis)\b(?:(?![;!?]|\.(?=\s|$)|\b(?:while|whereas|but|estimat(?:e|ed|ing|ion)|list-?price|rate\s*card|exposure|savings?|save)\b)[\s\S]){0,240}/gi;

function mentionsObservedCost(text: string, observed: Extract<ObservedCostResult, { ok: true }>): boolean {
  const amounts = [...text.matchAll(new RegExp(OBSERVED_COST_SPAN_RE.source, OBSERVED_COST_SPAN_RE.flags))]
    .flatMap((span) => extractUsdAmounts(span[0]));
  const hasTotal = amounts.some((amount) => amountsEqual(amount, observed.costUsd));
  const remainingAmounts = [...amounts];
  const hasEveryComponent = observed.componentCostsUsd.every((component) => {
    const matchIndex = remainingAmounts.findIndex((amount) => amountsEqual(amount, component));
    if (matchIndex < 0) return false;
    remainingAmounts.splice(matchIndex, 1);
    return true;
  });
  return hasTotal || hasEveryComponent;
}

function extractUsdAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const match of text.matchAll(
    /(?:\$\s*|\bUSD\s*)([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*USD\b/gi,
  )) {
    const raw = match[1] ?? match[2];
    if (raw !== undefined) amounts.push(Number(raw.replaceAll(',', '')));
  }
  return amounts;
}

function amountsEqual(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) < 0.000_001;
}

function sameStringSet(actual: readonly string[] | null, expected: readonly string[]): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  const actualSet = new Set(actual.map((value) => value.toLowerCase()));
  return expected.every((value) => actualSet.has(value.toLowerCase()));
}

function recommendationEvidenceIds(
  reasoning: ReasoningOutput,
  recommendationId: string,
  includeCounterEvidence = false,
): Set<string> {
  const recommendation = reasoning.recommendations.find(
    (entry) => entry.recommendation_id === recommendationId,
  );
  if (!recommendation) return new Set();
  const hypothesisById = new Map(
    reasoning.hypotheses.map((hypothesis) => [hypothesis.hypothesis_id, hypothesis] as const),
  );
  const factIds = new Set(recommendation.supported_by_fact_ids);
  for (const hypothesisId of recommendation.supported_by_hypothesis_ids) {
    const hypothesis = hypothesisById.get(hypothesisId);
    for (const factId of hypothesis?.supported_by_fact_ids ?? []) factIds.add(factId);
    if (includeCounterEvidence) {
      for (const factId of hypothesis?.counter_evidence_fact_ids ?? []) factIds.add(factId);
    }
  }
  return evidenceIdsForFactIds(reasoning, factIds);
}

function evidenceIdsForFactIds(
  reasoning: ReasoningOutput,
  factIds: Iterable<string>,
): Set<string> {
  const factById = new Map(reasoning.facts.map((fact) => [fact.fact_id, fact] as const));
  const evidenceIds = new Set<string>();
  for (const factId of factIds) {
    for (const evidenceId of factById.get(factId)?.evidence_ids ?? []) evidenceIds.add(evidenceId);
  }
  return evidenceIds;
}

function recommendationText(
  recommendation: ReasoningOutput['recommendations'][number],
): string {
  return [
    recommendation.statement,
    ...recommendation.assumptions,
    ...recommendation.validation_steps,
    ...recommendation.false_positive_considerations,
    ...recommendation.suggested_human_actions,
  ].join(' ');
}

type ObservedCostResult =
  | { ok: true; costUsd: number; componentCostsUsd: number[]; evidenceIds: string[] }
  | { ok: false; details: string };

function observedResourceTypeCost(
  input: CheckExpectationsInput,
  resourceType: string,
): ObservedCostResult {
  let costUsd = 0;
  let matched = 0;
  const componentCostsUsd: number[] = [];
  const evidenceIds = new Set<string>();
  const currencies = new Set<string>();
  for (const record of input.evidence) {
    if (record.source_capability !== 'amgmcp_cost_analysis') continue;
    if (
      record.time_window.start !== input.item.scope.time_window.start ||
      record.time_window.end !== input.item.scope.time_window.end
    ) continue;
    if (record.payload_ref.kind !== 'inline') continue;
    const payload = asRecord(record.payload_ref.data);
    const subscriptions = Array.isArray(payload?.subscriptions) ? payload.subscriptions : [];
    for (const subscriptionValue of subscriptions) {
      const subscription = asRecord(subscriptionValue);
      if (!subscription) continue;
      const currency = typeof subscription.currency === 'string'
        ? subscription.currency.toUpperCase()
        : '(missing)';
      const breakdown = Array.isArray(subscription.byResourceType)
        ? subscription.byResourceType
        : [];
      for (const entryValue of breakdown) {
        const entry = asRecord(entryValue);
        if (
          typeof entry?.name !== 'string' ||
          entry.name.toLowerCase() !== resourceType.toLowerCase() ||
          typeof entry.cost !== 'number' ||
          !Number.isFinite(entry.cost)
        ) continue;
        matched += 1;
        costUsd += entry.cost;
        componentCostsUsd.push(Math.round(entry.cost * 100) / 100);
        evidenceIds.add(record.evidence_id);
        currencies.add(currency);
      }
    }
  }
  if (matched === 0) {
    return { ok: false, details: `no same-window billed ${resourceType} cost was available` };
  }
  if (currencies.size !== 1 || !currencies.has('USD')) {
    return {
      ok: false,
      details: `billed ${resourceType} cost must use one USD currency; observed ${[...currencies].join(', ') || '(none)'}`,
    };
  }
  return {
    ok: true,
    costUsd: Math.round(costUsd * 100) / 100,
    componentCostsUsd,
    evidenceIds: [...evidenceIds],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

const QUALIFIED_SAVINGS_PATTERNS = [
  /\b(?:savings?|save)\b[^.!;]{0,80}\b(?:unknown|unverified|not\s+(?:realized|realizable|guaranteed|verified)|cannot\s+be\s+(?:claimed|treated|verified))\b/gi,
  /\b(?:unknown|unverified|not\s+(?:realized|realizable|guaranteed|verified)|cannot\s+be\s+(?:claimed|treated|verified))\b[^.!;]{0,80}\b(?:savings?|save)\b/gi,
  /\b(?:rather\s+than|not\s+(?:the\s+same\s+as|equivalent\s+to)|distinct\s+from)\b[^.!;]{0,100}\b(?:realized|realizable)?\s*savings?\b/gi,
  /\bbefore\b[^.!;]{0,100}\b(?:treat(?:ing)?|count(?:ing)?|claim(?:ing)?|present(?:ing)?|communicat(?:e|ing)|assign(?:ing)?|us(?:e|ing))\b[^.!;]{0,60}\b(?:as\s+)?(?:realized|realizable)?\s*savings?\b/gi,
  /\bdo\s+not\s+(?:treat|claim|count|present|communicate|assign|use)\b[^.!;]{0,80}\b(?:as\s+)?(?:realized|realizable)?\s*savings?\b/gi,
  /\bno\s+(?:realized|realizable)?\s*savings?\s+can\s+be\s+(?:claimed|verified|guaranteed)\b/gi,
] as const;

function hasQualifiedSavingsFraming(text: string): boolean {
  return QUALIFIED_SAVINGS_PATTERNS.some((pattern) =>
    new RegExp(pattern.source, pattern.flags).test(text),
  );
}

function hasUnqualifiedSavingsClaim(text: string): boolean {
  const unqualified = QUALIFIED_SAVINGS_PATTERNS.reduce(
    (remaining, pattern) => remaining.replace(new RegExp(pattern.source, pattern.flags), ''),
    text,
  );
  return /\b(?:save|savings?)\b/i.test(unqualified);
}
