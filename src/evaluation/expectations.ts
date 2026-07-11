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
    expectations.max_rejected_rows !== undefined;
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
