import { describe, it, expect } from 'vitest';
import { ReasoningOutputSchema } from '../../src/schemas/index.js';

const strongConfidence = {
  level: 'high',
  rationale: 'cost and utilization data align',
  dimensions: {
    evidence_coverage: 'strong',
    signal_quality: 'strong',
    signal_agreement: 'aligned',
  },
};

const minimalOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost rose 38%',
      evidence_ids: ['ev-1'],
      scope_subset: {},
    },
  ],
  hypotheses: [
    {
      hypothesis_id: 'hyp-1',
      statement: 'deployment caused the spike',
      confidence: strongConfidence,
      supported_by_fact_ids: ['fact-1'],
      counter_evidence_fact_ids: [],
      missing_evidence_to_decide: [],
    },
  ],
  recommendations: [
    {
      recommendation_id: 'rec-1',
      priority: 'medium',
      confidence: strongConfidence,
      impact: 'moderate',
      statement: 'review the deployment',
      supported_by_hypothesis_ids: ['hyp-1'],
      supported_by_fact_ids: [],
      assumptions: [],
      validation_steps: ['check CI history'],
      false_positive_considerations: ['legitimate traffic spike'],
      suggested_audience: 'platform_engineer',
      suggested_human_actions: ['compare against last week'],
    },
  ],
  data_quality: [],
};

describe('ReasoningOutputSchema', () => {
  it('accepts a well-formed output', () => {
    expect(ReasoningOutputSchema.safeParse(minimalOutput).success).toBe(true);
  });

  it('accepts an output with empty arrays in every section', () => {
    expect(
      ReasoningOutputSchema.safeParse({
        facts: [],
        hypotheses: [],
        recommendations: [],
        data_quality: [],
      }).success,
    ).toBe(true);
  });

  it('rejects when a top-level section is missing', () => {
    const { data_quality: _dq, ...withoutDq } = minimalOutput;
    expect(ReasoningOutputSchema.safeParse(withoutDq).success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(
      ReasoningOutputSchema.safeParse({ ...minimalOutput, scratchpad: 'thinking...' }).success,
    ).toBe(false);
  });

  it('propagates citation-completeness failure from RecommendationSchema', () => {
    const broken = {
      ...minimalOutput,
      recommendations: [
        {
          ...minimalOutput.recommendations[0],
          supported_by_hypothesis_ids: [],
          supported_by_fact_ids: [],
        },
      ],
    };
    expect(ReasoningOutputSchema.safeParse(broken).success).toBe(false);
  });
});
