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
