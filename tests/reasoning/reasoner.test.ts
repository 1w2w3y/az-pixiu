import { describe, it, expect } from 'vitest';
import { Reasoner } from '../../src/reasoning/reasoner.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import type { ReasoningOutput, EvidenceRecord, Scope } from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

const scope: Scope = {
  subscription_ids: [subId],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: '1 subscription, 7-day vs 7-day baseline',
  user_context: 'we deployed a new caching layer last week',
};

const evidence: EvidenceRecord[] = [
  {
    evidence_id: 'ev-cost-1',
    source_capability: 'cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    payload_ref: { kind: 'inline', data: { total: { cost: 617.58 } } },
    payload_summary: {},
    caveats: [],
  },
];

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

const cannedOutput: ReasoningOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost was 617.58',
      evidence_ids: ['ev-cost-1'],
      scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    },
  ],
  hypotheses: [
    {
      hypothesis_id: 'hyp-1',
      statement: 'workload increase explains the cost',
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
      statement: 'investigate workload patterns',
      supported_by_hypothesis_ids: ['hyp-1'],
      supported_by_fact_ids: [],
      assumptions: [],
      validation_steps: ['examine utilization'],
      false_positive_considerations: ['seasonal'],
      suggested_audience: 'finops_engineer',
      suggested_human_actions: ['review workload telemetry'],
      recommendation_signature: 'workload-investigation',
    },
  ],
  data_quality: [],
};

describe('Reasoner', () => {
  it('calls the model and returns post-processed output', async () => {
    const mock = new MockModelClient({ responses: cannedOutput });
    const reasoner = new Reasoner({ model: mock, systemPrompt: 'system' });
    const { output, issues } = await reasoner.reason({ scope, evidence, data_quality: [] });
    expect(mock.calls).toHaveLength(1);
    expect(output.recommendations).toHaveLength(1);
    expect(issues).toHaveLength(0);
  });

  it('includes user_context in the user prompt (reasoner-only boundary)', async () => {
    const mock = new MockModelClient({ responses: cannedOutput });
    const reasoner = new Reasoner({ model: mock, systemPrompt: 'system' });
    await reasoner.reason({ scope, evidence, data_quality: [] });
    expect(mock.calls[0]?.userPrompt).toContain('user_context');
    expect(mock.calls[0]?.userPrompt).toContain('caching layer');
  });

  it('omits user_context when absent', async () => {
    const mock = new MockModelClient({ responses: cannedOutput });
    const reasoner = new Reasoner({ model: mock, systemPrompt: 'system' });
    const scopeNoCtx = { ...scope };
    delete scopeNoCtx.user_context;
    await reasoner.reason({ scope: scopeNoCtx, evidence, data_quality: [] });
    expect(mock.calls[0]?.userPrompt).not.toContain('user_context');
  });

  it('passes temperature 0 and the supplied schema name by default', async () => {
    const mock = new MockModelClient({ responses: cannedOutput });
    const reasoner = new Reasoner({ model: mock, systemPrompt: 's' });
    await reasoner.reason({ scope, evidence, data_quality: [] });
    expect(mock.calls[0]?.temperature).toBe(0);
    expect(mock.calls[0]?.schemaName).toBe('reasoner_output');
  });

  it('post-process drops over-confident hypotheses (integration with confidence derivation)', async () => {
    const overconfident: ReasoningOutput = {
      ...cannedOutput,
      hypotheses: [
        {
          ...cannedOutput.hypotheses[0]!,
          confidence: {
            level: 'high',
            rationale: 'r',
            dimensions: { evidence_coverage: 'partial', signal_quality: 'weak', signal_agreement: 'aligned' },
          },
        },
      ],
    };
    const mock = new MockModelClient({ responses: overconfident });
    const reasoner = new Reasoner({ model: mock, systemPrompt: 's' });
    const { output } = await reasoner.reason({ scope, evidence, data_quality: [] });
    expect(output.hypotheses[0]?.confidence.level).toBe('low');
  });
});
