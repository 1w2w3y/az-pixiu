import { describe, it, expect } from 'vitest';
import { postProcessReasoning } from '../../src/reasoning/post-process.js';
import type { ReasoningOutput, EvidenceRecord } from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

const baseEvidence: EvidenceRecord[] = [
  {
    evidence_id: 'ev-cost_analysis-aaaaaaaa',
    source_capability: 'cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId] },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: { total: { cost: 617.58, currency: 'USD' }, rows: [['x', 617.58]] },
    },
    payload_summary: {},
    caveats: [],
  },
  {
    evidence_id: 'ev-cost_analysis-bbbbbbbb',
    source_capability: 'cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId] },
    time_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: { total: { cost: 446.91, currency: 'USD' }, rows: [['x', 446.91]] },
    },
    payload_summary: {},
    caveats: [],
  },
];

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

const wellFormed: ReasoningOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost rose from 446.91 to 617.58 USD',
      evidence_ids: ['ev-cost_analysis-aaaaaaaa', 'ev-cost_analysis-bbbbbbbb'],
      scope_subset: { subscription_ids: [subId] },
    },
  ],
  hypotheses: [
    {
      hypothesis_id: 'hyp-1',
      statement: 'a deployment raised the workload',
      confidence: { level: 'high', rationale: 'aligned signals', dimensions: strongDims },
      supported_by_fact_ids: ['fact-1'],
      counter_evidence_fact_ids: [],
      missing_evidence_to_decide: [],
    },
  ],
  recommendations: [
    {
      recommendation_id: 'rec-1',
      priority: 'medium',
      confidence: { level: 'high', rationale: 'aligned signals', dimensions: strongDims },
      impact: 'moderate',
      statement: 'investigate the recent deployment to confirm workload alignment',
      supported_by_hypothesis_ids: ['hyp-1'],
      supported_by_fact_ids: [],
      assumptions: [],
      validation_steps: ['compare utilization before and after'],
      false_positive_considerations: ['legitimate workload increase'],
      suggested_audience: 'platform_engineer',
      suggested_human_actions: ['review the most recent deployment record'],
    },
  ],
  data_quality: [],
};

describe('postProcessReasoning — happy path', () => {
  it('passes well-formed output through unchanged', () => {
    const { output, issues } = postProcessReasoning(wellFormed, { evidence: baseEvidence });
    expect(issues).toHaveLength(0);
    expect(output.facts).toHaveLength(1);
    expect(output.hypotheses).toHaveLength(1);
    expect(output.recommendations).toHaveLength(1);
  });
});

describe('postProcessReasoning — citation validity', () => {
  it('drops a fact whose evidence_ids do not resolve and synthesizes a DQ', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      facts: [{ ...wellFormed.facts[0]!, evidence_ids: ['ev-does-not-exist'] }],
    };
    const { output, issues } = postProcessReasoning(broken, { evidence: baseEvidence });
    expect(output.facts).toHaveLength(0);
    expect(issues.some((i) => i.kind === 'dangling_citation' && i.target === 'fact')).toBe(true);
    expect(output.data_quality.length).toBeGreaterThan(wellFormed.data_quality.length);
  });

  it('drops a hypothesis whose supported_by_fact_ids reference a dropped fact', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      facts: [{ ...wellFormed.facts[0]!, evidence_ids: ['ev-does-not-exist'] }],
    };
    const { output } = postProcessReasoning(broken, { evidence: baseEvidence });
    expect(output.hypotheses).toHaveLength(0);
  });

  it('drops a recommendation whose only support was via a dropped hypothesis', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      facts: [{ ...wellFormed.facts[0]!, evidence_ids: ['ev-does-not-exist'] }],
    };
    const { output } = postProcessReasoning(broken, { evidence: baseEvidence });
    expect(output.recommendations).toHaveLength(0);
  });
});

describe('postProcessReasoning — fabricated numbers', () => {
  it('drops a fact with a number not in the cited evidence', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      facts: [
        {
          ...wellFormed.facts[0]!,
          statement: 'cost rose by 9999.99 USD — a clearly fabricated figure',
        },
      ],
    };
    const { output, issues } = postProcessReasoning(broken, { evidence: baseEvidence });
    expect(output.facts).toHaveLength(0);
    expect(issues.some((i) => i.kind === 'fabricated_number')).toBe(true);
  });

  it('accepts a fact that quotes only numbers present in the cited evidence', () => {
    const ok: ReasoningOutput = {
      ...wellFormed,
      facts: [
        {
          ...wellFormed.facts[0]!,
          statement: 'analysis-window cost 617.58 USD vs baseline 446.91 USD',
        },
      ],
    };
    const { output } = postProcessReasoning(ok, { evidence: baseEvidence });
    expect(output.facts).toHaveLength(1);
  });
});

describe('postProcessReasoning — read-only lint', () => {
  it('drops a recommendation whose statement uses imperative remediation language', () => {
    const broken: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'delete the db-prod-2 server to save cost',
          suggested_human_actions: ['terminate db-prod-2'],
        },
      ],
    };
    const { output, issues } = postProcessReasoning(broken, { evidence: baseEvidence });
    expect(output.recommendations).toHaveLength(0);
    expect(issues.some((i) => i.kind === 'imperative_language')).toBe(true);
  });

  it('accepts imperative verbs when softening framing precedes them', () => {
    const ok: ReasoningOutput = {
      ...wellFormed,
      recommendations: [
        {
          ...wellFormed.recommendations[0]!,
          statement: 'consider whether to delete the orphaned snapshot in rg-db-prod',
          suggested_human_actions: ['review whether to terminate inactive instances'],
        },
      ],
    };
    const { output } = postProcessReasoning(ok, { evidence: baseEvidence });
    expect(output.recommendations).toHaveLength(1);
  });
});

describe('postProcessReasoning — confidence derivation overrides LLM headline', () => {
  it('downgrades an over-confident hypothesis', () => {
    const overconfident: ReasoningOutput = {
      ...wellFormed,
      hypotheses: [
        {
          ...wellFormed.hypotheses[0]!,
          confidence: {
            level: 'high',
            rationale: 'looks aligned',
            dimensions: {
              evidence_coverage: 'partial',
              signal_quality: 'strong',
              signal_agreement: 'aligned',
            },
          },
        },
      ],
    };
    const { output, issues } = postProcessReasoning(overconfident, { evidence: baseEvidence });
    expect(output.hypotheses[0]?.confidence.level).toBe('low');
    expect(issues.some((i) => i.kind === 'confidence_downgraded')).toBe(true);
  });
});
