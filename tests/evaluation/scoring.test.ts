import { describe, it, expect } from 'vitest';
import {
  scoreAll,
  scoreStructuralCorrectness,
  scoreCitationCompleteness,
  scoreConfidenceConsistency,
  scoreReadOnlyAdherence,
  scoreWasteClassificationGrounding,
  scoreEstimatedImpactCalibrated,
} from '../../src/evaluation/scoring.js';
import type { EvidenceRecord, ReasoningOutput } from '../../src/schemas/index.js';

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

const wellFormed: ReasoningOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost was 617.58',
      evidence_ids: ['ev-1'],
      scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
    },
  ],
  hypotheses: [
    {
      hypothesis_id: 'hyp-1',
      statement: 'workload growth',
      confidence: { level: 'high', rationale: 'r', dimensions: strongDims },
      supported_by_fact_ids: ['fact-1'],
      counter_evidence_fact_ids: [],
      missing_evidence_to_decide: [],
    },
  ],
  recommendations: [
    {
      recommendation_id: 'rec-1',
      priority: 'medium',
      confidence: { level: 'high', rationale: 'r', dimensions: strongDims },
      impact: 'moderate',
      statement: 'investigate the workload increase',
      supported_by_hypothesis_ids: ['hyp-1'],
      supported_by_fact_ids: [],
      assumptions: [],
      validation_steps: ['compare metrics week-over-week'],
      false_positive_considerations: ['seasonal'],
      suggested_audience: 'platform_engineer',
      suggested_human_actions: ['review workload patterns'],
      recommendation_signature: 'workload-growth-review',
    },
  ],
  data_quality: [],
};

describe('scoring rubrics — happy path', () => {
  it('all base rubrics pass on a well-formed output (no evidence supplied)', () => {
    // No evidence → waste_classification_grounding is skipped, so the
    // aggregate is the four Phase 1 rubrics + Phase 3 calibrated-impact
    // (which passes vacuously when no dollar amounts are rendered).
    const agg = scoreAll(wellFormed);
    expect(agg.passed_all).toBe(true);
    expect(agg.pass_count).toBe(5);
    expect(agg.fail_count).toBe(0);
  });
});

describe('scoreStructuralCorrectness', () => {
  it('passes valid ReasoningOutput', () => {
    expect(scoreStructuralCorrectness(wellFormed).passed).toBe(true);
  });

  it('fails on missing top-level field', () => {
    const broken: Partial<ReasoningOutput> = { facts: [], hypotheses: [], recommendations: [] };
    expect(scoreStructuralCorrectness(broken).passed).toBe(false);
  });
});

describe('scoreCitationCompleteness', () => {
  it('passes when recommendation cites a surviving hypothesis', () => {
    expect(scoreCitationCompleteness(wellFormed).passed).toBe(true);
  });

  it('fails when hypothesis references a non-existent fact', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      hypotheses: [{ ...wellFormed.hypotheses[0]!, supported_by_fact_ids: ['fact-missing'] }],
    };
    expect(scoreCitationCompleteness(broken).passed).toBe(false);
  });
});

describe('scoreConfidenceConsistency', () => {
  it('passes when level matches dimensions', () => {
    expect(scoreConfidenceConsistency(wellFormed).passed).toBe(true);
  });

  it('fails when level disagrees with dimensions', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      hypotheses: [
        {
          ...wellFormed.hypotheses[0]!,
          confidence: {
            level: 'high',
            rationale: 'r',
            dimensions: { evidence_coverage: 'partial', signal_quality: 'weak', signal_agreement: 'aligned' },
          },
        },
      ],
    };
    const result = scoreConfidenceConsistency(broken);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/disagrees/);
  });
});

describe('scoreReadOnlyAdherence', () => {
  it('passes on softened phrasing', () => {
    expect(scoreReadOnlyAdherence(wellFormed).passed).toBe(true);
  });

  it('fails on imperative remediation', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'delete the orphaned server',
          suggested_human_actions: ['delete the server'],
        },
      ],
    };
    const result = scoreReadOnlyAdherence(broken);
    expect(result.passed).toBe(false);
  });
});

describe('scoreAll — short-circuits on structural failure', () => {
  it('returns just one result when structure is broken', () => {
    const agg = scoreAll({ wrong: 'shape' } as unknown as ReasoningOutput);
    expect(agg.results).toHaveLength(1);
    expect(agg.results[0]?.rubric).toBe('structural_correctness');
  });
});

// ---- Phase 3 rubrics (design/cost-summary-depth.md §"Evaluation surface") ----

function makeWasteEvidence(resourceId: string, evidenceId = 'ev-waste-1'): EvidenceRecord {
  return {
    evidence_id: evidenceId,
    source_capability: 'az_pixiu_waste_lane',
    capability_version: '1.0.0',
    query_intent: 'waste_candidate',
    scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: [resourceId] },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: {
        waste_lane: 'orphan_public_ip',
        classification_predicate: "isnull(properties.ipConfiguration)",
        candidate_count: 1,
        candidate: { resource_id: resourceId },
      },
    },
    payload_summary: {},
    caveats: [],
  };
}

describe('scoreWasteClassificationGrounding', () => {
  it('is vacuously satisfied when the run produced no waste-candidate evidence', () => {
    expect(scoreWasteClassificationGrounding(wellFormed, []).passed).toBe(true);
  });

  it('passes when every fact mentioning a waste-candidate resource id cites the lane evidence', () => {
    const resId = '/subscriptions/77/.../pip-orphan-1';
    const evidence = [makeWasteEvidence(resId, 'ev-waste-1')];
    const out: ReasoningOutput = {
      ...wellFormed,
      facts: [
        {
          fact_id: 'fact-1',
          statement: `orphan_public_ip lane surfaced ${resId} in scope`,
          evidence_ids: ['ev-waste-1'],
          scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: [resId] },
        },
      ],
      hypotheses: [
        { ...wellFormed.hypotheses[0]!, supported_by_fact_ids: ['fact-1'] },
      ],
    };
    expect(scoreWasteClassificationGrounding(out, evidence).passed).toBe(true);
  });

  it('ignores lane-summary evidence as a candidate and grounds only candidate payloads', () => {
    const resId = '/subscriptions/77/.../pip-orphan-1';
    const summary: EvidenceRecord = {
      ...makeWasteEvidence(resId, 'ev-summary'),
      scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      payload_ref: {
        kind: 'inline',
        data: {
          record_kind: 'lane_summary',
          waste_lane: 'orphan_public_ip',
          candidate_count: 1,
          lane_total: { low_usd: 0.76, high_usd: 0.92, point_usd: 0.84 },
        },
      },
    };
    const candidate = makeWasteEvidence(resId, 'ev-candidate');
    const out: ReasoningOutput = {
      ...wellFormed,
      facts: [
        {
          fact_id: 'fact-1',
          statement: `orphan_public_ip lane surfaced ${resId} in scope`,
          evidence_ids: ['ev-candidate'],
          scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: [resId] },
        },
      ],
      hypotheses: [
        { ...wellFormed.hypotheses[0]!, supported_by_fact_ids: ['fact-1'] },
      ],
    };

    expect(scoreWasteClassificationGrounding(out, [summary, candidate]).passed).toBe(true);
  });

  it('does not throw when waste-intent evidence has a null inline payload', () => {
    const malformed: EvidenceRecord = {
      ...makeWasteEvidence('/subscriptions/77/.../pip-orphan-1', 'ev-malformed'),
      payload_ref: { kind: 'inline', data: null },
    };

    expect(() => scoreWasteClassificationGrounding(wellFormed, [malformed])).not.toThrow();
    expect(scoreWasteClassificationGrounding(wellFormed, [malformed])).toMatchObject({
      passed: true,
    });
  });

  it('fails when a fact names a waste-candidate resource id but does not cite the lane evidence', () => {
    const resId = '/subscriptions/77/.../pip-orphan-1';
    const evidence = [makeWasteEvidence(resId, 'ev-waste-1')];
    const out: ReasoningOutput = {
      ...wellFormed,
      facts: [
        {
          fact_id: 'fact-uncited',
          statement: `the resource ${resId} appears in the inventory snapshot`,
          evidence_ids: ['ev-1'], // unrelated
          scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
        },
      ],
    };
    const result = scoreWasteClassificationGrounding(out, evidence);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/lane evidence/);
  });
});

describe('scoreEstimatedImpactCalibrated', () => {
  it('passes when no recommendation mentions a dollar amount (vacuously satisfied)', () => {
    expect(scoreEstimatedImpactCalibrated(wellFormed).passed).toBe(true);
  });

  it('passes when a recommendation renders impact as a range with a cited rate source', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement:
            'Investigate the orphan IPs surfaced by the lane. Estimated weekly waste is ~$1.51–$1.85/week (list-price estimate from the in-repo rate card).',
        },
      ],
    };
    expect(scoreEstimatedImpactCalibrated(out).passed).toBe(true);
  });

  it('allows explicitly observed or billed point dollars but still rejects an estimated point dollar', () => {
    const observed: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement:
            'Cost Analysis observed $1.25 billed this week; the rate-card estimate is $9-$11 per week.',
        },
      ],
    };
    expect(scoreEstimatedImpactCalibrated(observed).passed).toBe(true);

    const estimated: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'The rate-card estimated impact is $10 per week.',
        },
      ],
    };
    const result = scoreEstimatedImpactCalibrated(estimated);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/point dollar/);
  });

  it('allows multiple billed point dollars alongside a list-price range', () => {
    const outputs = [
      'Billed cost was $0.32 in one subscription and $0.10 in another, while the rate-card list-price exposure was ~$3.04-$3.68/week.',
      'Observed billed costs were USD 0.32 and USD 0.1, while the rate-card list-price exposure was ~$3.04-$3.68/week.',
      'The list-price estimate is ~$3.04–$3.68/week; actual savings remain unknown until it is reconciled with billed public IP costs of $0.32 and $0.10.',
    ];

    for (const statement of outputs) {
      const out: ReasoningOutput = {
        ...wellFormed,
        recommendations: [{ ...wellFormed.recommendations[0]!, statement }],
      };
      expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
    }
  });

  it('recognizes raw billed values introduced by an analyzed-window phrase', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement:
            'Investigate the service cost drivers. The analyzed window shows 5600 USD for PostgreSQL out of 7000 USD total; actual savings remain unknown.',
        },
      ],
    };
    expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
  });

  it('does not hide an estimated point dollar that follows an observed point dollar', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'Observed billed cost was $0.42, while the estimated impact is $3.36.',
        },
      ],
    };

    const result = scoreEstimatedImpactCalibrated(out);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('$3.36');
  });

  it('does not let a billed prefix absorb a later avoidable-cost point estimate', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'Billed cost is $0.42, yielding $3.36 per week of avoidable cost.',
        },
      ],
    };

    const result = scoreEstimatedImpactCalibrated(out);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('$3.36');
  });

  it.each([
    'Observed billed cost was $0.42 and the projected reduction is $3.36 per week.',
    'Cost Analysis recorded $0.42 and the expected recovery is $3.36 per week.',
    'Billing was $0.42 and a forecast benefit is $3.36 per week.',
    'Observed cost was $0.42 and the recoverable amount is $3.36 per week.',
    'Observed billed cost was $0.42 and the reduction opportunity is $3.36 per week.',
  ])('does not let observed-cost wording absorb a later estimate clause: %s', (statement) => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [{ ...wellFormed.recommendations[0]!, statement }],
    };

    const result = scoreEstimatedImpactCalibrated(out);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('$3.36');
  });

  it.each([
    'Observed billed cost was $0.42, a reduction from $0.50 last week.',
    'Observed billed cost was reduced to $0.42 from $0.50.',
  ])('keeps historical observed-cost reductions exempt: %s', (statement) => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [{ ...wellFormed.recommendations[0]!, statement }],
    };

    expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
  });

  it.each([
    'Observed cost for project Alpha was $0.42.',
    'The observed project cost was $0.42.',
    'Observed billing for projects Alpha and Beta was $0.42.',
  ])('does not confuse a project name with a projected estimate: %s', (statement) => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [{ ...wellFormed.recommendations[0]!, statement }],
    };

    expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
  });

  it.each([
    'The rate-card list-price estimate is $3.04 to $3.68 per week.',
    'The rate-card list-price estimate is USD 3.04 to USD 3.68 per week.',
    'The rate-card list-price estimate is 3.04 USD–3.68 USD/week.',
    'The captured rate-card list-price estimate is 3.04–3.68 USD per week.',
    'The captured rate-card list-price estimate is $1,024-$1,280 per week.',
  ])('accepts a calibrated range grammar: %s', (statement) => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [{ ...wellFormed.recommendations[0]!, statement }],
    };
    expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
  });

  it('allows an observed billed range without requiring rate-card provenance', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'Observed billed cost was $0.32-$0.42 during the selected window.',
        },
      ],
    };
    expect(scoreEstimatedImpactCalibrated(out)).toMatchObject({ passed: true });
  });

  it('fails when a recommendation renders impact as a single dollar figure', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'Cleanup will save ~$87/week, list-price estimate.',
        },
      ],
    };
    const result = scoreEstimatedImpactCalibrated(out);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/point dollar/);
  });

  it('fails when a dollar amount has no rate-source citation', () => {
    const out: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'Cleanup will save ~$5–$10/week.',
        },
      ],
    };
    const result = scoreEstimatedImpactCalibrated(out);
    expect(result.passed).toBe(false);
    expect(result.details).toMatch(/rate source/);
  });
});
