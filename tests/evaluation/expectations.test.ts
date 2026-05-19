import { describe, it, expect } from 'vitest';
import { checkExpectations } from '../../src/evaluation/expectations.js';
import type { DatasetItem } from '../../src/evaluation/dataset.js';
import type { ReasoningOutput, EvidenceRecord } from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

function makeItem(expectations: DatasetItem['expectations']): DatasetItem {
  return {
    id: 'unit',
    fixture_id: 'unit',
    scope: {
      subscription_ids: [subId],
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
      analysis_type: 'cost_surprise',
      effective_scope_summary: 'unit-test scope',
    },
    ...(expectations ? { expectations } : {}),
  } as DatasetItem;
}

const mixedDims = {
  evidence_coverage: 'adequate' as const,
  signal_quality: 'mixed' as const,
  signal_agreement: 'mixed' as const,
};

function makeReasoning(recommendationCount: number, dqCategories: string[] = []): ReasoningOutput {
  return {
    facts: recommendationCount > 0
      ? [{
          fact_id: 'fact-1',
          statement: 'a fact',
          evidence_ids: ['ev-1'],
          scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
        }]
      : [],
    hypotheses: [],
    recommendations: Array.from({ length: recommendationCount }, (_, i) => ({
      recommendation_id: `rec-${i + 1}`,
      priority: 'medium' as const,
      confidence: { level: 'medium' as const, rationale: 'r', dimensions: mixedDims },
      impact: 'unknown' as const,
      statement: 'consider reviewing the underlying signal',
      supported_by_hypothesis_ids: [],
      supported_by_fact_ids: ['fact-1'],
      assumptions: [],
      validation_steps: ['inspect the artefact'],
      false_positive_considerations: [],
      suggested_audience: 'platform_engineer' as const,
      suggested_human_actions: ['review evidence'],
    })),
    data_quality: dqCategories.map((category, i) => ({
      dq_id: `dq-${i + 1}` as ReasoningOutput['data_quality'][number]['dq_id'],
      category: category as ReasoningOutput['data_quality'][number]['category'],
      affected_capability: null,
      affected_scope_subset: null,
      consequence_for_analysis: 'unit consequence',
      impact_on_recommendations: [],
      actionable_hint: null,
    })),
  };
}

function makeEvidence(capabilities: string[]): EvidenceRecord[] {
  return capabilities.map((cap, i) => ({
    evidence_id: `ev-${i + 1}` as EvidenceRecord['evidence_id'],
    source_capability: cap,
    capability_version: '1.0.0',
    query_intent: 'inventory' as const,
    scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: { kind: 'inline', data: {} },
    payload_summary: {},
    caveats: [],
  }));
}

describe('checkExpectations', () => {
  it('returns no results when the item has no expectations block', () => {
    const result = checkExpectations({
      item: makeItem(undefined),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.results).toHaveLength(0);
    expect(result.passed_all).toBe(true);
  });

  it('passes min_recommendations when actual >= min', () => {
    const result = checkExpectations({
      item: makeItem({ min_recommendations: 1 }),
      reasoning: makeReasoning(2),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(true);
    expect(result.results[0]).toMatchObject({ expectation: 'min_recommendations', passed: true });
  });

  it('fails min_recommendations when actual < min and reports the count', () => {
    const result = checkExpectations({
      item: makeItem({ min_recommendations: 2 }),
      reasoning: makeReasoning(1),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(false);
    expect(result.results[0]).toMatchObject({ expectation: 'min_recommendations', passed: false });
    expect(result.results[0]!.details).toMatch(/expected ≥ 2, got 1/);
  });

  it('passes expected_dq_categories when reasoner echoes the category', () => {
    const result = checkExpectations({
      item: makeItem({ expected_dq_categories: ['tagging_gap'] }),
      reasoning: makeReasoning(1, ['tagging_gap']),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(true);
  });

  it('passes expected_dq_categories when only the input layer surfaced it', () => {
    // Reasoner dropped the DQ on the floor, but the normalizer or
    // failure-taxonomy surfaced it before reasoning — the assertion
    // should still resolve from input_dq_categories.
    const result = checkExpectations({
      item: makeItem({ expected_dq_categories: ['authz_gap'] }),
      reasoning: makeReasoning(1, []),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: ['authz_gap'],
    });
    expect(result.passed_all).toBe(true);
  });

  it('fails expected_dq_categories with a missing-list message', () => {
    const result = checkExpectations({
      item: makeItem({ expected_dq_categories: ['authz_gap', 'tagging_gap'] }),
      reasoning: makeReasoning(1, ['tagging_gap']),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(false);
    expect(result.results[0]!.details).toMatch(/missing categories: authz_gap/);
  });

  it('passes expected_capabilities_invoked from evidence records alone', () => {
    const result = checkExpectations({
      item: makeItem({
        expected_capabilities_invoked: ['amgmcp_cost_analysis', 'amgmcp_query_resource_graph'],
      }),
      reasoning: makeReasoning(1),
      evidence: makeEvidence(['amgmcp_cost_analysis', 'amgmcp_query_resource_graph']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(true);
  });

  it('fails expected_capabilities_invoked with the missing list', () => {
    const result = checkExpectations({
      item: makeItem({
        expected_capabilities_invoked: ['amgmcp_cost_analysis', 'amgmcp_query_activity_log'],
      }),
      reasoning: makeReasoning(1),
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: ['amgmcp_cost_analysis'],
      input_dq_categories: [],
    });
    expect(result.passed_all).toBe(false);
    expect(result.results[0]!.details).toMatch(/missing capabilities: amgmcp_query_activity_log/);
  });
});
