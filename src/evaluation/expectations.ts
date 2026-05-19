import type { DatasetItem } from './dataset.js';
import type { EvidenceRecord, ReasoningOutput } from '../schemas/index.js';

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

  const pass_count = results.filter((r) => r.passed).length;
  return {
    results,
    passed_all: pass_count === results.length,
    pass_count,
    fail_count: results.length - pass_count,
  };
}
