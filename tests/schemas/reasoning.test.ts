import { describe, it, expect } from 'vitest';
import {
  ConfidenceSchema,
  FactSchema,
  HypothesisSchema,
  RecommendationSchema,
} from '../../src/schemas/index.js';

const strongConfidence = {
  level: 'high',
  rationale: 'cost and utilization data are aligned and well-covered',
  dimensions: {
    evidence_coverage: 'strong',
    signal_quality: 'strong',
    signal_agreement: 'aligned',
  },
};

const validFact = {
  fact_id: 'fact-1',
  statement: 'cost on Microsoft.DBforPostgreSQL rose 38% versus baseline',
  evidence_ids: ['ev-1', 'ev-2'],
  scope_subset: {
    subscription_ids: ['11111111-1111-1111-1111-111111111111'],
    resource_group_names: null,
    resource_ids: null,
  },
};

const validHypothesis = {
  hypothesis_id: 'hyp-1',
  statement: 'deployment on 2026-05-03 raised PostgreSQL workload sharply',
  confidence: strongConfidence,
  supported_by_fact_ids: ['fact-1'],
  counter_evidence_fact_ids: [],
  missing_evidence_to_decide: [],
};

const validRecommendation = {
  recommendation_id: 'rec-1',
  priority: 'high',
  confidence: strongConfidence,
  impact: 'material',
  statement: 'review PostgreSQL flexible servers in rg-db-prod for over-provisioning',
  supported_by_hypothesis_ids: ['hyp-1'],
  supported_by_fact_ids: ['fact-1'],
  assumptions: ['cost baseline window is representative of steady state'],
  validation_steps: ['confirm deployment timing against CI history'],
  false_positive_considerations: ['legitimate traffic spike on a scheduled batch'],
  suggested_audience: 'finops_engineer',
  suggested_human_actions: ['investigate the 2026-05-03 deployment'],
  recommendation_signature: 'pg-flexible-server-review',
};

describe('ConfidenceSchema', () => {
  it('accepts a well-formed confidence object', () => {
    expect(ConfidenceSchema.safeParse(strongConfidence).success).toBe(true);
  });

  it('rejects an empty rationale', () => {
    expect(
      ConfidenceSchema.safeParse({ ...strongConfidence, rationale: '' }).success,
    ).toBe(false);
  });

  it('rejects an unknown level', () => {
    expect(
      ConfidenceSchema.safeParse({ ...strongConfidence, level: 'very_high' }).success,
    ).toBe(false);
  });

  it('rejects unknown dimension keys (strict)', () => {
    expect(
      ConfidenceSchema.safeParse({
        ...strongConfidence,
        dimensions: { ...strongConfidence.dimensions, freshness: 'fresh' },
      }).success,
    ).toBe(false);
  });
});

describe('FactSchema', () => {
  it('accepts a well-formed fact', () => {
    expect(FactSchema.safeParse(validFact).success).toBe(true);
  });

  it('rejects a fact with no evidence_ids (citation discipline)', () => {
    expect(FactSchema.safeParse({ ...validFact, evidence_ids: [] }).success).toBe(false);
  });

  it('rejects an empty statement', () => {
    expect(FactSchema.safeParse({ ...validFact, statement: '' }).success).toBe(false);
  });
});

describe('HypothesisSchema', () => {
  it('accepts a well-formed hypothesis', () => {
    expect(HypothesisSchema.safeParse(validHypothesis).success).toBe(true);
  });

  it('accepts a hypothesis with counter-evidence and missing-evidence lists', () => {
    expect(
      HypothesisSchema.safeParse({
        ...validHypothesis,
        counter_evidence_fact_ids: ['fact-2'],
        missing_evidence_to_decide: ['dq-1'],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      HypothesisSchema.safeParse({ ...validHypothesis, weight: 0.8 }).success,
    ).toBe(false);
  });
});

describe('RecommendationSchema', () => {
  it('accepts a recommendation cited by a hypothesis', () => {
    expect(RecommendationSchema.safeParse(validRecommendation).success).toBe(true);
  });

  it('accepts a recommendation cited only by facts (no hypothesis required)', () => {
    expect(
      RecommendationSchema.safeParse({
        ...validRecommendation,
        supported_by_hypothesis_ids: [],
        supported_by_fact_ids: ['fact-1'],
      }).success,
    ).toBe(true);
  });

  it('rejects a recommendation with no citations (citation completeness)', () => {
    expect(
      RecommendationSchema.safeParse({
        ...validRecommendation,
        supported_by_hypothesis_ids: [],
        supported_by_fact_ids: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a recommendation with zero suggested_human_actions (must be plural)', () => {
    expect(
      RecommendationSchema.safeParse({ ...validRecommendation, suggested_human_actions: [] })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown priority', () => {
    expect(
      RecommendationSchema.safeParse({ ...validRecommendation, priority: 'critical' }).success,
    ).toBe(false);
  });

  it('rejects an unknown audience', () => {
    expect(
      RecommendationSchema.safeParse({ ...validRecommendation, suggested_audience: 'cto' })
        .success,
    ).toBe(false);
  });

  it('rejects a recommendation missing recommendation_signature', () => {
    const { recommendation_signature: _sig, ...withoutSig } = validRecommendation;
    expect(RecommendationSchema.safeParse(withoutSig).success).toBe(false);
  });

  it('rejects an empty recommendation_signature', () => {
    expect(
      RecommendationSchema.safeParse({ ...validRecommendation, recommendation_signature: '' })
        .success,
    ).toBe(false);
  });
});
