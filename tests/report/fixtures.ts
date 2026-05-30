import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
} from '../../src/schemas/index.js';

/**
 * Shared report-test fixtures. The markdown and HTML test suites read
 * from these so the two views are asserted against the same input shape
 * — drift between them shows up as a test failure rather than a silent
 * divergence in what one renderer can describe.
 */

export const subId = '11111111-1111-1111-1111-111111111111';

export const scope: Scope = {
  subscription_ids: [subId],
  resource_group_names: ['rg-db-prod'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: '1 subscription, 7-day vs 7-day baseline',
};

export const evidence: EvidenceRecord[] = [
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

export const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

export const reasoning: ReasoningOutput = {
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
      recommendation_signature: 'pg-deployment-investigation',
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

export const metadata: RunMetadata = {
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
