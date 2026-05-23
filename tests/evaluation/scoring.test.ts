import { describe, it, expect } from 'vitest';
import {
  scoreAll,
  scoreStructuralCorrectness,
  scoreCitationCompleteness,
  scoreConfidenceConsistency,
  scoreReadOnlyAdherence,
} from '../../src/evaluation/scoring.js';
import type { ReasoningOutput } from '../../src/schemas/index.js';

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
  it('all four rubrics pass on a well-formed output', () => {
    const agg = scoreAll(wellFormed);
    expect(agg.passed_all).toBe(true);
    expect(agg.pass_count).toBe(4);
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
