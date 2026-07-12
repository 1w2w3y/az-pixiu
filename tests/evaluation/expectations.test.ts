import { describe, it, expect } from 'vitest';
import { checkExpectations } from '../../src/evaluation/expectations.js';
import type { DatasetItem } from '../../src/evaluation/dataset.js';
import type { ReasoningOutput, EvidenceRecord } from '../../src/schemas/index.js';
import { rollUpLaneTotal } from '../../src/pricing/impact.js';
import type { WasteLaneResult } from '../../src/playbooks/waste-lanes/types.js';

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
      recommendation_signature: `expectations-test-${i + 1}`,
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

function makeWasteLane(
  resourceIds: string[],
  unparsed = 0,
  rejected = 0,
  failed = false,
): WasteLaneResult {
  return {
    lane: 'orphan_public_ip',
    title: 'Unassociated public IP review candidates',
    predicate_text: 'where test',
    source_capability: 'az_pixiu_waste_lane',
    candidates: resourceIds.map((resourceId, index) => ({
      candidate: {
        resource_id: resourceId,
        name: `pip-${index + 1}`,
        subscription_id: subId,
        resource_group: 'rg',
        location: 'westus2',
        sku: 'PublicIPAddress_Standard_Static',
        fields: {},
      },
      estimated_weekly_impact: {
        kind: 'unavailable' as const,
        reason: 'sku_not_in_rate_card' as const,
        count: 1,
        sku: 'PublicIPAddress_Standard_Static',
      },
      evidence: makeEvidence(['az_pixiu_waste_lane'])[0]!,
    })),
    lane_total: rollUpLaneTotal([]),
    rate_source_captured_at: '2026-05-23',
    unparsed_row_count: unparsed,
    rejected_row_count: rejected,
    failed,
  };
}

const publicIpResourceType = 'Microsoft.Network/publicIPAddresses';
const publicIpId =
  `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-1`;

function makePricedWasteLane(
  price: { low_usd: number; high_usd: number; point_usd: number } = {
    low_usd: 9,
    high_usd: 11,
    point_usd: 10,
  },
): WasteLaneResult {
  const lane = makeWasteLane([publicIpId]);
  const estimate = {
    kind: 'available' as const,
    ...price,
    count: 1,
    sku: 'PublicIPAddress_Standard_Static',
    source_url: 'https://azure.microsoft.com/pricing/details/ip-addresses/',
    captured_at: '2026-05-23',
  };
  const laneEvidence: EvidenceRecord = {
    ...lane.candidates[0]!.evidence,
    evidence_id: 'ev-waste',
    query_intent: 'waste_candidate',
    payload_ref: {
      kind: 'inline',
      data: {
        waste_lane: 'orphan_public_ip',
        candidate: { resource_id: publicIpId },
      },
    },
  };
  return {
    ...lane,
    candidates: [
      {
        ...lane.candidates[0]!,
        estimated_weekly_impact: estimate,
        evidence: laneEvidence,
      },
    ],
    lane_total: rollUpLaneTotal([estimate]),
  };
}

function makeLaneSummaryEvidence(lane: WasteLaneResult): EvidenceRecord {
  return {
    evidence_id: 'ev-waste-summary',
    source_capability: 'az_pixiu_waste_lane',
    capability_version: '1.0.0',
    query_intent: 'waste_candidate',
    scope_subset: {
      subscription_ids: [subId],
      resource_group_names: null,
      resource_ids: null,
    },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: {
        record_kind: 'lane_summary',
        waste_lane: lane.lane,
        candidate_count: lane.candidates.length,
        candidate_evidence_ids: lane.candidates
          .map((candidate) => candidate.evidence.evidence_id)
          .sort(),
        lane_total: lane.lane_total,
      },
    },
    payload_summary: { record_kind: 'lane_summary', waste_lane: lane.lane },
    caveats: [],
  };
}

function makeCostEvidence(
  costUsd: number,
  evidenceId = 'ev-cost',
  subscriptionId = subId,
): EvidenceRecord {
  return {
    evidence_id: evidenceId,
    source_capability: 'amgmcp_cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: {
      subscription_ids: [subscriptionId],
      resource_group_names: null,
      resource_ids: null,
    },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: {
        subscriptions: [
          {
            subscriptionId,
            currency: 'USD',
            byResourceType: [{ name: publicIpResourceType, cost: costUsd }],
          },
        ],
      },
    },
    payload_summary: {},
    caveats: [],
  };
}

function makeUtilizationEvidence(): EvidenceRecord {
  return {
    evidence_id: 'ev-utilization',
    source_capability: 'amgmcp_query_resource_metric',
    capability_version: '1.0.0',
    query_intent: 'utilization',
    scope_subset: {
      subscription_ids: [subId],
      resource_group_names: ['rg'],
      resource_ids: ['/subscriptions/unit/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/db'],
    },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: { kind: 'inline', data: { metric: 'cpu_percent', average: 4.2 } },
    payload_summary: {},
    caveats: [],
  };
}

function makeWasteReconciliationReasoning(
  statement: string,
  costEvidenceIds: string[] = ['ev-cost'],
): ReasoningOutput {
  const reasoning = makeReasoning(1);
  return {
    ...reasoning,
    facts: [
      {
        fact_id: 'fact-cost',
        statement: 'Cost Analysis returned billed public IP cost.',
        evidence_ids: costEvidenceIds,
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
      },
      {
        fact_id: 'fact-waste',
        statement: `The waste lane surfaced ${publicIpId}.`,
        evidence_ids: ['ev-waste-summary'],
        scope_subset: { subscription_ids: [subId], resource_group_names: ['rg'], resource_ids: [publicIpId] },
      },
    ],
    recommendations: [
      {
        ...reasoning.recommendations[0]!,
        statement,
        supported_by_fact_ids: ['fact-cost', 'fact-waste'],
      },
    ],
  };
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

  it('checks exact waste-candidate recall and parse-completeness limits', () => {
    const ids = [
      `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-1`,
      `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-2`,
    ];
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        expected_candidate_ids: ids,
        expected_candidate_count: 2,
        excluded_candidate_ids: [`/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/attached`],
        max_unparsed_rows: 0,
        max_rejected_rows: 0,
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [makeWasteLane(ids)],
    });

    expect(result.passed_all).toBe(true);
    expect(result.results.map((entry) => entry.expectation)).toEqual([
      'expected_waste_lane',
      'expected_candidate_ids',
      'excluded_candidate_ids',
      'expected_candidate_count',
      'max_unparsed_rows',
      'max_rejected_rows',
    ]);
  });

  it('fails when a lane misses a candidate or returns incomplete rows', () => {
    const expected = [
      `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-1`,
      `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-2`,
    ];
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        expected_candidate_ids: expected,
        expected_candidate_count: 2,
        max_unparsed_rows: 0,
        max_rejected_rows: 0,
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [makeWasteLane([expected[0]!], 1, 1)],
    });

    expect(result.passed_all).toBe(false);
    expect(result.results.find((entry) => entry.expectation === 'expected_candidate_ids')?.details).toContain('pip-2');
    expect(result.results.find((entry) => entry.expectation === 'max_unparsed_rows')?.passed).toBe(false);
    expect(result.results.find((entry) => entry.expectation === 'max_rejected_rows')?.passed).toBe(false);
  });

  it('fails exact candidate ids when the lane emits a duplicate id', () => {
    const id = `/subscriptions/${subId}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-1`;
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        expected_candidate_ids: [id],
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [makeWasteLane([id, id])],
    });

    expect(result.passed_all).toBe(false);
    expect(
      result.results.find((entry) => entry.expectation === 'expected_candidate_ids')?.details,
    ).toContain('duplicate actual');
  });

  it('fails the named-lane contract when the same lane is produced twice', () => {
    const result = checkExpectations({
      item: makeItem({ expected_waste_lane: 'orphan_public_ip' }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [makeWasteLane([]), makeWasteLane([])],
    });

    expect(result.passed_all).toBe(false);
    expect(
      result.results.find((entry) => entry.expectation === 'expected_waste_lane')?.details,
    ).toContain('produced 2 times');
  });

  it('counts a completed clean-empty lane source as an invoked synthetic capability', () => {
    const result = checkExpectations({
      item: makeItem({
        expected_capabilities_invoked: ['az_pixiu_waste_lane'],
        expected_waste_lane: 'orphan_public_ip',
        expected_candidate_ids: [],
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: ['amgmcp_query_resource_graph'],
      input_dq_categories: [],
      waste_lanes: [makeWasteLane([])],
    });

    expect(result.passed_all).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['failed', [makeWasteLane([], 0, 0, true)]],
  ] as const)('fails a clean-empty contract when the target lane is %s', (_case, wasteLanes) => {
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        expected_candidate_ids: [],
        expected_candidate_count: 0,
        max_unparsed_rows: 0,
        max_rejected_rows: 0,
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      ...(wasteLanes ? { waste_lanes: wasteLanes } : {}),
    });

    expect(result.passed_all).toBe(false);
    expect(
      result.results.find((entry) => entry.expectation === 'expected_waste_lane'),
    ).toMatchObject({ passed: false });
  });

  it('checks the exact aggregate for the selected waste lane', () => {
    const lane = makePricedWasteLane();
    const expectedLaneTotal = {
      low_usd: 9,
      high_usd: 11,
      point_usd: 10,
      available_count: 1,
      unavailable_count: 0,
    };
    const passing = checkExpectations({
      item: makeItem({ expected_waste_lane: 'orphan_public_ip', expected_lane_total: expectedLaneTotal }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });
    expect(
      passing.results.find((entry) => entry.expectation === 'expected_lane_total'),
    ).toMatchObject({ passed: true });

    const failing = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        expected_lane_total: { ...expectedLaneTotal, high_usd: 12 },
      }),
      reasoning: makeReasoning(0),
      evidence: [],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });
    const failure = failing.results.find((entry) => entry.expectation === 'expected_lane_total');
    expect(failure).toMatchObject({ passed: false });
    expect(failure?.details).toContain('high_usd: expected 12, got 11');
  });

  it('fails an assertive optimization claim whose citation closure has no utilization metric', () => {
    const costEvidence = makeCostEvidence(1);
    const reasoning = makeReasoning(1);
    reasoning.facts = [
      {
        fact_id: 'fact-cost',
        statement: 'The database is the largest cost category.',
        evidence_ids: ['ev-cost'],
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
      },
    ];
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement: 'The database is underutilized; downsize the SKU.',
      supported_by_fact_ids: ['fact-cost'],
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: [costEvidence],
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    const expectation = result.results.find(
      (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
    );
    expect(expectation).toMatchObject({ passed: false });
    expect(expectation?.details).toContain('without cited raw utilization evidence');
  });

  it.each([
    'Downgrade the database to a smaller SKU.',
    'Move the database from Standard_D16ds_v5 to Standard_D8ds_v5.',
    'Change the database SKU from Standard_D16ds_v5 to Standard_D8ds_v5.',
    'Cut cost by $100 per week.',
    'Reduce vCores from 16 to 8.',
    'Halve the node count.',
  ])('rejects a concrete optimization target without utilization: %s', (statement) => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement,
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: false });
  });

  it('allows an explicit refusal to downgrade without utilization evidence', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement: 'Do not downgrade to a smaller SKU without utilization evidence.',
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('does not let a negated action hide an assertive claim after a contrast connector', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement:
        'Do not downsize blindly, but the server is oversized and should move to a smaller SKU now.',
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: false });
  });

  it('does not treat an observed historical SKU change as a target recommendation', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement:
        'Review the billed cost before any rightsizing decision. A recent change from Standard_D8ds_v5 to Standard_D16ds_v5 may reflect an intentional response to workload demand.',
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('rejects reconciliation boilerplate that omits the exact billed and lane quantities', () => {
    const lane = makePricedWasteLane();
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        'Consider reconciling observed billed cost with rate-card list-price exposure; realized savings remain unknown.',
      ),
      evidence: [makeCostEvidence(1), makeLaneSummaryEvidence(lane)],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('requires the aggregate range to cite lane-summary evidence rather than a candidate row', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed, while rate-card list-price exposure is $9-$11; realized savings remain unknown.',
    );
    reasoning.facts.find((fact) => fact.fact_id === 'fact-waste')!.evidence_ids = ['ev-waste'];
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(1),
        makeLaneSummaryEvidence(lane),
        lane.candidates[0]!.evidence,
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('requires every Cost Analysis record that contributes a billed component to be cited', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed, while rate-card list-price exposure is $9-$11 per week; realized savings remain unknown.',
      ['ev-cost-a'],
    );
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(0.5, 'ev-cost-a'),
        makeCostEvidence(0.5, 'ev-cost-b'),
        makeLaneSummaryEvidence(lane),
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('requires repeated billed components to be reported with their multiplicity', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis billed components include $0.50, while rate-card list-price exposure is $9-$11 per week; realized savings remain unknown.',
      ['ev-cost-a', 'ev-cost-b'],
    );
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(0.5, 'ev-cost-a'),
        makeCostEvidence(0.5, 'ev-cost-b'),
        makeLaneSummaryEvidence(lane),
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('accepts billed cost as counter-evidence in the recommendation citation closure', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed, while rate-card list-price exposure is $9-$11 per week; realized savings remain unknown.',
    );
    reasoning.hypotheses = [
      {
        hypothesis_id: 'hyp-reconcile',
        statement: 'The lane is a review ceiling that conflicts with observed billing.',
        confidence: { level: 'medium', rationale: 'r', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-waste'],
        counter_evidence_fact_ids: ['fact-cost'],
        missing_evidence_to_decide: [],
      },
    ];
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      supported_by_fact_ids: [],
      supported_by_hypothesis_ids: ['hyp-reconcile'],
    };
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [makeCostEvidence(1), makeLaneSummaryEvidence(lane)],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: true });
  });

  it('rejects a stale or numerically mismatched lane-summary citation', () => {
    const lane = makePricedWasteLane();
    const summary = makeLaneSummaryEvidence(lane);
    if (summary.payload_ref.kind === 'inline') {
      const payload = summary.payload_ref.data as { lane_total: { high_usd: number } };
      payload.lane_total.high_usd = 12;
    }
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        'Cost Analysis observed $1.00 billed, while rate-card list-price exposure is $9-$11 per week; realized savings remain unknown.',
      ),
      evidence: [makeCostEvidence(1), summary],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('requires the lane exposure range to retain a weekly unit', () => {
    const lane = makePricedWasteLane();
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        'Cost Analysis observed $1.00 billed, while rate-card list-price exposure is $9-$11 per month; realized savings remain unknown.',
      ),
      evidence: [makeCostEvidence(1), makeLaneSummaryEvidence(lane)],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('accepts withholding savings communication until reconciliation', () => {
    const lane = makePricedWasteLane();
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        'Cost Analysis observed $1.00 billed while rate-card list-price exposure is $9-$11 per week; reconcile both before communicating savings.',
      ),
      evidence: [makeCostEvidence(1), makeLaneSummaryEvidence(lane)],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: true });
  });

  it.each([
    'Reconcile both values before assigning any savings estimate.',
    'Review meter attribution before using the estimate in savings reporting.',
  ])('accepts another explicit savings-withholding phrase: %s', (qualifier) => {
    const lane = makePricedWasteLane();
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        `Cost Analysis observed $1.00 billed while rate-card list-price exposure is $9-$11 per week. ${qualifier}`,
      ),
      evidence: [makeCostEvidence(1), makeLaneSummaryEvidence(lane)],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: true });
  });

  it('does not let an unsupported optimization hypothesis hide behind a safe recommendation', () => {
    const reasoning = makeReasoning(1);
    reasoning.facts = [
      {
        fact_id: 'fact-cost',
        statement: 'The database is the largest cost category.',
        evidence_ids: ['ev-cost'],
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
      },
    ];
    reasoning.hypotheses = [
      {
        hypothesis_id: 'hyp-unsupported',
        statement: 'The database is underutilized.',
        confidence: { level: 'medium', rationale: 'r', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-cost'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: [],
      },
    ];
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement: 'Collect CPU and memory evidence before deciding whether capacity should change.',
      supported_by_hypothesis_ids: ['hyp-unsupported'],
      supported_by_fact_ids: [],
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: [makeCostEvidence(1)],
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    const expectation = result.results.find(
      (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
    );
    expect(expectation).toMatchObject({ passed: false });
    expect(expectation?.details).toContain('hyp-unsupported');
  });

  it('allows a recommendation that only asks the reviewer to collect utilization evidence', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement: 'Collect CPU and memory utilization before deciding whether a smaller SKU is appropriate.',
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('allows a deferred oversized assessment from the live cost-only model output', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement:
        'No concrete capacity reduction or savings amount is supported without utilization, configuration, and per-resource billing evidence.',
      validation_steps: [
        'Collect multi-window CPU, memory, storage input/output, connection, and transaction distributions before assessing whether any server is oversized.',
      ],
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('allows an explicit insufficient-evidence hypothesis about underutilization', () => {
    const reasoning = makeReasoning(1);
    reasoning.hypotheses = [
      {
        hypothesis_id: 'hyp-insufficient',
        statement:
          'The current evidence is insufficient to judge whether the 12 Virtual Machine scale sets or the 4 PostgreSQL flexible servers are underutilized or oversized.',
        confidence: { level: 'medium', rationale: 'r', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-1'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: ['dq-1'],
      },
    ];
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      supported_by_hypothesis_ids: ['hyp-insufficient'],
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('still rejects an assertive action after a deferred oversized assessment', () => {
    const reasoning = makeReasoning(1);
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement:
        'Collect utilization before assessing whether the server is oversized; downsize the server immediately.',
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: makeEvidence(['amgmcp_cost_analysis']),
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: false });
  });

  it('accepts an optimization claim when its hypothesis citation closes over raw utilization evidence', () => {
    const utilizationEvidence = makeUtilizationEvidence();
    const reasoning = makeReasoning(1);
    reasoning.facts = [
      {
        fact_id: 'fact-utilization',
        statement: 'CPU averaged 4.2 percent during the analysis window.',
        evidence_ids: ['ev-utilization'],
        scope_subset: utilizationEvidence.scope_subset,
      },
    ];
    reasoning.hypotheses = [
      {
        hypothesis_id: 'hyp-utilization',
        statement: 'The current SKU may be oversized.',
        confidence: { level: 'medium', rationale: 'r', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-utilization'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: [],
      },
    ];
    reasoning.recommendations[0] = {
      ...reasoning.recommendations[0]!,
      statement: 'The server is underutilized; review downsizing to the next smaller SKU.',
      supported_by_hypothesis_ids: ['hyp-utilization'],
      supported_by_fact_ids: [],
    };

    const result = checkExpectations({
      item: makeItem({ require_utilization_evidence_for_optimization_claims: true }),
      reasoning,
      evidence: [utilizationEvidence],
      invoked_capabilities: [],
      input_dq_categories: [],
    });

    expect(
      result.results.find(
        (entry) => entry.expectation === 'require_utilization_evidence_for_optimization_claims',
      ),
    ).toMatchObject({ passed: true });
  });

  it('passes a complete waste-cost conflict that cites both surfaces and qualifies savings', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed for public IPs, while the rate-card list-price exposure is $9-$11 per week; realized savings are unverified and cannot be claimed.',
    );
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(1),
        makeLaneSummaryEvidence(lane),
        lane.candidates[0]!.evidence,
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: true });
  });

  it.each([
    'Reconcile billed public IP spend against the orphan_public_ip lane estimate before treating the lane total as savings. During 2026-05-01 to 2026-05-08, billed cost for microsoft.network/publicipaddresses was $0.32 in subscription 77777777-7777-7777-7777-777777777777 and $0.10 in subscription 88888888-8888-8888-8888-888888888888, while the lane reported ~$3.04-$3.68/week of list-price exposure from the in-repo rate card.',
    "The priced subset has an estimated list-price exposure of approximately $3.04–$3.68 USD per week from the rate card, but this is a review upper bound rather than realized savings; actual savings remain unknown until the estimate is reconciled with billed public IP costs of $0.32 USD and $0.10 USD.",
    'Investigate the candidates and reconcile approximately $3.04–$3.68 per week of rate-card list-price exposure against observed billed public-IP costs of USD 0.32 and USD 0.1; this is a review upper bound rather than realized savings, and actual savings remain unknown.',
    'The priced portion is $3.04–$3.68/week of rate-card list-price exposure, while Cost Analysis reported 0.32 USD and 0.1 USD for the same window; treat the range as an upper bound rather than realized savings, and keep actual savings unknown.',
    'The lane reports 3.04 USD–3.68 USD/week of rate-card list-price exposure, while same-window observed billed cost is 0.32 USD and 0.1 USD; realizable savings remain unknown until attribution is reconciled.',
  ])('accepts qualified savings framing from a live model output', (statement) => {
    const lane = makePricedWasteLane({ low_usd: 3.04, high_usd: 3.68, point_usd: 3.36 });
    const costEvidence = [
      makeCostEvidence(0.32, 'ev-cost-1', '77777777-7777-7777-7777-777777777777'),
      makeCostEvidence(0.1, 'ev-cost-2', '88888888-8888-8888-8888-888888888888'),
    ];
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(statement, ['ev-cost-1', 'ev-cost-2']),
      evidence: [
        ...costEvidence,
        makeLaneSummaryEvidence(lane),
        lane.candidates[0]!.evidence,
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: true });
  });

  it('fails waste-cost reconciliation when a recommendation also makes unqualified savings claims', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed for public IPs, while the rate-card list-price exposure is $9-$11 per week; realized savings are unverified. Cleanup will save $10 per week.',
    );
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(1),
        makeLaneSummaryEvidence(lane),
        lane.candidates[0]!.evidence,
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it('does not let qualified and assertive savings language share one clause', () => {
    const lane = makePricedWasteLane();
    const reasoning = makeWasteReconciliationReasoning(
      'Cost Analysis observed $1.00 billed while the rate-card exposure is $9-$11, an upper bound rather than realized savings, but cleanup will save $10 per week.',
    );
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning,
      evidence: [
        makeCostEvidence(1),
        makeLaneSummaryEvidence(lane),
        lane.candidates[0]!.evidence,
      ],
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    expect(
      result.results.find((entry) => entry.expectation === 'require_waste_cost_reconciliation'),
    ).toMatchObject({ passed: false });
  });

  it.each([
    {
      name: 'same-window billed resource-type cost is missing',
      costEvidence: undefined,
      lane: makePricedWasteLane(),
      detail: 'no same-window billed',
    },
    {
      name: 'the fixture has no exposure-versus-billed conflict',
      costEvidence: makeCostEvidence(12),
      lane: makePricedWasteLane(),
      detail: 'did not produce the intended conflict',
    },
    {
      name: 'the waste lane failed',
      costEvidence: makeCostEvidence(1),
      lane: { ...makePricedWasteLane(), failed: true },
      detail: 'not a complete priced enumeration',
    },
  ])('fails waste-cost reconciliation when $name', ({ costEvidence, lane, detail }) => {
    const evidence = [
      ...(costEvidence ? [costEvidence] : []),
      makeLaneSummaryEvidence(lane),
      lane.candidates[0]!.evidence,
    ];
    const result = checkExpectations({
      item: makeItem({
        expected_waste_lane: 'orphan_public_ip',
        require_waste_cost_reconciliation: {
          lane: 'orphan_public_ip',
          resource_type: publicIpResourceType,
        },
      }),
      reasoning: makeWasteReconciliationReasoning(
        'Cost Analysis observed $1.00 billed for public IPs, while the rate-card list-price exposure is $9-$11 per week; realized savings are unverified and cannot be claimed.',
      ),
      evidence,
      invoked_capabilities: [],
      input_dq_categories: [],
      waste_lanes: [lane],
    });

    const expectation = result.results.find(
      (entry) => entry.expectation === 'require_waste_cost_reconciliation',
    );
    expect(expectation).toMatchObject({ passed: false });
    expect(expectation?.details).toContain(detail);
  });
});
