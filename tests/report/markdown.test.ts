import { describe, it, expect } from 'vitest';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  DataQualityFinding,
} from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

const scope: Scope = {
  subscription_ids: [subId],
  resource_group_names: ['rg-db-prod'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: '1 subscription, 7-day vs 7-day baseline',
};

const evidence: EvidenceRecord[] = [
  {
    evidence_id: 'ev-cost_analysis-aaaaaaaa',
    source_capability: 'cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId] },
    time_window: scope.time_window,
    payload_ref: { kind: 'inline', data: {} },
    payload_summary: {},
    caveats: [],
  },
];

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

const reasoning: ReasoningOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost on PostgreSQL rose 38% over baseline',
      evidence_ids: ['ev-cost_analysis-aaaaaaaa'],
      scope_subset: { subscription_ids: [subId] },
    },
  ],
  hypotheses: [
    {
      hypothesis_id: 'hyp-1',
      statement: 'a deployment caused the rise',
      confidence: { level: 'high', rationale: 'timing aligns', dimensions: strongDims },
      supported_by_fact_ids: ['fact-1'],
      counter_evidence_fact_ids: [],
      missing_evidence_to_decide: [],
    },
  ],
  recommendations: [
    {
      recommendation_id: 'rec-1',
      priority: 'high',
      confidence: { level: 'high', rationale: 'aligned', dimensions: strongDims },
      impact: 'material',
      statement: 'investigate the recent PostgreSQL deployment',
      supported_by_hypothesis_ids: ['hyp-1'],
      supported_by_fact_ids: ['fact-1'],
      assumptions: ['baseline is representative'],
      validation_steps: ['compare utilization week-over-week'],
      false_positive_considerations: ['legitimate workload growth'],
      suggested_audience: 'platform_engineer',
      suggested_human_actions: ['review the deployment timeline', 'examine workload telemetry'],
    },
  ],
  data_quality: [
    {
      dq_id: 'dq-1',
      category: 'missing_telemetry',
      affected_capability: 'query_resource_metric',
      consequence_for_analysis: 'utilization is unavailable for 2 servers',
      impact_on_recommendations: ['rec-1'],
      actionable_hint: 'grant Reader on rg-db-prod',
    },
  ],
};

const metadata: RunMetadata = {
  run_id: '22222222-2222-2222-2222-222222222222',
  trace_id: 'trace-abc',
  prompt_versions: { planner: 'planner.v1', reasoner: 'reasoner.v1' },
  model_provider: 'foundry',
  model_name: 'gpt-5.4',
  model_config_hash: 'abc12345',
  model_deployment_sku: 'GlobalStandard',
  credential_source: { implementation: 'AzureCliCredential', identity: 'operator@example.com' },
  amg_mcp_endpoint: 'https://amg.example.com',
  capability_versions: { cost_analysis: '1.0.0' },
  started_at: '2026-05-18T12:00:00Z',
  status: 'success',
};

describe('renderMarkdownReport', () => {
  it('produces a non-empty markdown string with all major sections', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain('# Az-Pixiu Cost-Surprise Report');
    expect(md).toContain('## Scope & Data Sources');
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('## Recommendations');
    expect(md).toContain('## Hypotheses');
    expect(md).toContain('## Observed Facts');
    expect(md).toContain('## Data Quality');
    expect(md).toContain('## Run Metadata');
  });

  it('includes the scope-confirmation echo (effective_scope_summary)', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain('1 subscription, 7-day vs 7-day baseline');
  });

  it('lists every distinct capability used in evidence', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toMatch(/Capabilities used.*cost_analysis/);
  });

  it('embeds run_id and trace_id in the footer', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain(metadata.run_id);
    expect(md).toContain(metadata.trace_id);
  });

  it('records the credential source and identity', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain('AzureCliCredential');
    expect(md).toContain('operator@example.com');
  });

  it('sorts recommendations by priority then confidence', () => {
    const multi: ReasoningOutput = {
      ...reasoning,
      recommendations: [
        { ...reasoning.recommendations[0]!, recommendation_id: 'rec-low', priority: 'low' },
        { ...reasoning.recommendations[0]!, recommendation_id: 'rec-hi', priority: 'high' },
        { ...reasoning.recommendations[0]!, recommendation_id: 'rec-mid', priority: 'medium' },
      ],
    };
    const md = renderMarkdownReport({ scope, reasoning: multi, evidence, metadata });
    expect(md.indexOf('rec-hi')).toBeLessThan(md.indexOf('rec-mid'));
    expect(md.indexOf('rec-mid')).toBeLessThan(md.indexOf('rec-low'));
  });

  it('renders sensibly when reasoning has no recommendations', () => {
    const empty: ReasoningOutput = { facts: [], hypotheses: [], recommendations: [], data_quality: [] };
    const md = renderMarkdownReport({ scope, reasoning: empty, evidence, metadata });
    expect(md).toContain('No recommendations were produced');
    expect(md).toContain('_(none)_');
  });

  it('is byte-for-byte deterministic for the same input', () => {
    const a = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    const b = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(a).toBe(b);
  });

  it('renders subscription names from scope.subscription_display_names when present', () => {
    const named: Scope = {
      ...scope,
      subscription_display_names: { [subId]: 'prod-billing' },
    };
    const md = renderMarkdownReport({ scope: named, reasoning, evidence, metadata });
    expect(md).toMatch(/Subscriptions:\*\*\s+"prod-billing"\s+\(11111111-/);
  });

  it('falls back to amgmcp_query_azure_subscriptions evidence when scope has no names', () => {
    const evWithNames: EvidenceRecord[] = [
      ...evidence,
      {
        evidence_id: 'ev-azure-subscriptions-aaa',
        source_capability: 'amgmcp_query_azure_subscriptions',
        capability_version: '1.0.0',
        query_intent: 'inventory',
        scope_subset: {},
        time_window: scope.time_window,
        payload_ref: {
          kind: 'inline',
          data: {
            data: [
              {
                subscriptionId: subId,
                subscriptionName: 'evidence-derived-name',
              },
            ],
          },
        },
        payload_summary: {},
        caveats: [],
      },
    ];
    const md = renderMarkdownReport({ scope, reasoning, evidence: evWithNames, metadata });
    expect(md).toMatch(/Subscriptions:\*\*\s+"evidence-derived-name"\s+\(11111111-/);
  });

  it('renders bare id when neither scope nor evidence carries a name', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toMatch(/Subscriptions:\*\*\s+11111111-1111-1111-1111-111111111111/);
    // and not the quoted name form
    expect(md).not.toMatch(/Subscriptions:\*\*\s+"/);
  });

  it('renders a deterministic spend overview for cost_summary reports', () => {
    const summaryScope: Scope = {
      subscription_ids: [subId],
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      analysis_type: 'cost_summary',
      effective_scope_summary: '1 subscription, 7-day cost summary',
    };
    const summaryEvidence: EvidenceRecord[] = [
      {
        evidence_id: 'ev-amgmcp_cost_analysis-aaaaaaaa',
        source_capability: 'amgmcp_cost_analysis',
        capability_version: '1.0.0',
        query_intent: 'cost_breakdown',
        scope_subset: { subscription_ids: [subId] },
        time_window: summaryScope.time_window,
        payload_ref: {
          kind: 'inline',
          data: {
            rows: [
              ['2026-05-01', 'App Service', 38.21, 'USD'],
              ['2026-05-01', 'Storage', 11.42, 'USD'],
              ['2026-05-04', 'App Service', 41.55, 'USD'],
              ['2026-05-04', 'Storage', 12.05, 'USD'],
              ['2026-05-07', 'App Service', 42.78, 'USD'],
              ['2026-05-07', 'Storage', 12.71, 'USD'],
            ],
            total: { cost: 158.72, currency: 'USD' },
          },
        },
        payload_summary: { total_cost: 158.72, currency: 'USD' },
        caveats: [],
      },
    ];

    const md = renderMarkdownReport({
      scope: summaryScope,
      reasoning,
      evidence: summaryEvidence,
      metadata,
    });

    expect(md).toContain('## Cost Summary Overview');
    expect(md).toContain('**Total observed cost:** 158.72 USD');
    expect(md).toContain('**Cost records:** 6');
    expect(md).toContain('**Cost evidence:** ev-amgmcp_cost_analysis-aaaaaaaa');
    expect(md).toContain('- App Service: 122.54 USD');
    expect(md).toContain('- Storage: 36.18 USD');
    expect(md).toContain('**Peak observed day:** 2026-05-07 (55.49 USD)');
    expect(md).toContain('**Lowest observed day:** 2026-05-01 (49.63 USD)');
  });

  it('does not add the cost-summary overview to cost_surprise reports', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).not.toContain('## Cost Summary Overview');
  });

  it('renders a spend overview from live AMG-MCP shape (subscriptions[].byService)', () => {
    const summaryScope: Scope = {
      subscription_ids: [subId],
      time_window: { start: '2026-05-12T00:00:00Z', end: '2026-05-19T00:00:00Z' },
      analysis_type: 'cost_summary',
      effective_scope_summary: '1 subscription, 7-day cost summary (live shape)',
    };
    const liveEvidence: EvidenceRecord[] = [
      {
        evidence_id: 'ev-amgmcp_cost_analysis-bbbbbbbb',
        source_capability: 'amgmcp_cost_analysis',
        capability_version: '1.0.0',
        query_intent: 'cost_breakdown',
        scope_subset: { subscription_ids: [subId] },
        time_window: summaryScope.time_window,
        payload_ref: {
          kind: 'inline',
          data: {
            periodStart: '2026-05-12',
            periodEnd: '2026-05-19',
            subscriptions: [
              {
                subscriptionId: subId,
                totalCost: 158.72,
                currency: 'USD',
                byService: [
                  { name: 'App Service', cost: 122.54 },
                  { name: 'Storage', cost: 36.18 },
                ],
                byRegion: [{ name: 'us west 2', cost: 158.72 }],
                byResourceType: [{ name: 'microsoft.web/sites', cost: 122.54 }],
              },
            ],
          },
        },
        payload_summary: { total_cost: 158.72, currency: 'USD' },
        caveats: [],
      },
    ];

    const md = renderMarkdownReport({
      scope: summaryScope,
      reasoning,
      evidence: liveEvidence,
      metadata,
    });

    expect(md).toContain('## Cost Summary Overview');
    expect(md).toContain('**Total observed cost:** 158.72 USD');
    expect(md).toContain('**Cost records:** 2');
    expect(md).toContain('- App Service: 122.54 USD');
    expect(md).toContain('- Storage: 36.18 USD');
    // Live shape has no per-day breakdown — the Peak/Lowest day block must
    // elide rather than fabricate a single-day total.
    expect(md).not.toContain('Peak observed day');
    expect(md).not.toContain('Lowest observed day');
  });
});

describe('renderMarkdownReport — retrieval-stage data quality', () => {
  const taggingFinding: DataQualityFinding = {
    dq_id: 'dq-1',
    category: 'tagging_gap',
    affected_capability: 'amgmcp_query_resource_graph',
    affected_scope_subset: null,
    consequence_for_analysis: 'half the inventoried resources lack tags',
    impact_on_recommendations: [],
    actionable_hint: 'apply a tagging policy',
  };
  const authzFinding: DataQualityFinding = {
    dq_id: 'dq-2',
    category: 'authz_gap',
    affected_capability: 'amgmcp_query_activity_log',
    affected_scope_subset: null,
    consequence_for_analysis: 'activity log access denied — change attribution unreliable',
    impact_on_recommendations: [],
    actionable_hint: 'grant the AMG identity Activity Log Reader on the scope',
  };

  it('omits the retrieval-stage section when inputDataQuality is empty', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).not.toContain('## Data Quality — Retrieval Stage');
  });

  it('renders pre-reasoner findings in a separate section and marks dropped categories', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning, // reasoning.data_quality is empty in the fixture
      evidence,
      metadata,
      inputDataQuality: [taggingFinding, authzFinding],
    });
    expect(md).toContain('## Data Quality — Retrieval Stage');
    expect(md).toContain('### dq-1 — tagging_gap');
    expect(md).toContain('### dq-2 — authz_gap');
    // Both categories are absent from reasoning.data_quality, so each is
    // tagged as not-echoed.
    expect(md).toMatch(/dq-1 — tagging_gap[\s\S]*Status:_ not echoed by the reasoner/);
    expect(md).toMatch(/dq-2 — authz_gap[\s\S]*Status:_ not echoed by the reasoner/);
    // Executive summary should call out the dropped categories.
    expect(md).toContain('Retrieval-stage findings not echoed by the reasoner: tagging_gap (1), authz_gap (1).');
  });

  it('does not mark a finding as dropped when the reasoner echoes the same category', () => {
    const reasoningWithDq: ReasoningOutput = {
      ...reasoning,
      data_quality: [
        {
          ...taggingFinding,
          dq_id: 'dq-reasoner-1',
          consequence_for_analysis: 'reasoner restated the tagging gap',
        },
      ],
    };
    const md = renderMarkdownReport({
      scope,
      reasoning: reasoningWithDq,
      evidence,
      metadata,
      inputDataQuality: [taggingFinding],
    });
    expect(md).toContain('## Data Quality — Retrieval Stage');
    expect(md).not.toMatch(/dq-1 — tagging_gap[\s\S]*Status:_ not echoed/);
    expect(md).not.toContain('Retrieval-stage findings not echoed');
  });
});
