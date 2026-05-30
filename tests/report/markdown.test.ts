import { describe, it, expect } from 'vitest';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import type {
  ReasoningOutput,
  Scope,
  EvidenceRecord,
  DataQualityFinding,
  TransportSummaryEntry,
} from '../../src/schemas/index.js';
import { subId, scope, evidence, reasoning, metadata } from './fixtures.js';

describe('renderMarkdownReport', () => {
  it('produces a non-empty markdown string with all major sections', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain('# Az-Pixiu Cost-Surprise Report');
    expect(md).toContain('## Scope & Data Sources');
    expect(md).toContain('## Run Quality');
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('## Recommendations');
    expect(md).toContain('## Hypotheses');
    expect(md).toContain('## Observed Facts');
    expect(md).toContain('## Data Quality');
    expect(md).toContain('## Run Metadata');
  });

  it('renders Run Quality before Executive Summary and Recommendations', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md.indexOf('## Run Quality')).toBeGreaterThan(md.indexOf('## Scope & Data Sources'));
    expect(md.indexOf('## Run Quality')).toBeLessThan(md.indexOf('## Executive Summary'));
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

  it('expands obscure-abbreviation service names in the top-services list', () => {
    const summaryScope: Scope = {
      subscription_ids: [subId],
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      analysis_type: 'cost_summary',
      effective_scope_summary: '1 subscription, 7-day cost summary',
    };
    const ddosEvidence: EvidenceRecord[] = [
      {
        evidence_id: 'ev-amgmcp_cost_analysis-ddos',
        source_capability: 'amgmcp_cost_analysis',
        capability_version: '1.0.0',
        query_intent: 'cost_breakdown',
        scope_subset: { subscription_ids: [subId] },
        time_window: summaryScope.time_window,
        payload_ref: {
          kind: 'inline',
          data: {
            periodStart: '2026-05-01',
            periodEnd: '2026-05-08',
            subscriptions: [
              {
                subscriptionId: subId,
                totalCost: 224.4,
                currency: 'USD',
                byService: [{ name: 'Azure DDOS Protection', cost: 224.4 }],
              },
            ],
          },
        },
        payload_summary: { total_cost: 224.4, currency: 'USD' },
        caveats: [],
      },
    ];
    const md = renderMarkdownReport({
      scope: summaryScope,
      reasoning,
      evidence: ddosEvidence,
      metadata,
    });
    expect(md).toContain('Azure Distributed Denial of Service (DDoS) Protection: 224.40 USD');
    expect(md).not.toMatch(/^- Azure DDOS Protection:/m);
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
  // Second analytical finding (was authz_gap before Phase 2.5 — that
  // category moved to the new "Run Quality" section §Gap 6, so the
  // retrieval-stage section now exercises a different analytical
  // category to keep the two-finding shape of these assertions intact).
  // partial_coverage is chosen because the reasoning fixture above
  // already carries a missing_telemetry finding, which would cause the
  // "echo match" code path instead of the "not echoed" one this test
  // is asserting.
  const partialCoverageFinding: DataQualityFinding = {
    dq_id: 'dq-2',
    category: 'partial_coverage',
    affected_capability: 'amgmcp_cost_analysis',
    affected_scope_subset: null,
    consequence_for_analysis: 'cost evidence available only at the subscription-level aggregate',
    impact_on_recommendations: [],
    actionable_hint: 'retrieve resource-level cost breakdown for the same window',
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
      inputDataQuality: [taggingFinding, partialCoverageFinding],
    });
    expect(md).toContain('## Data Quality — Retrieval Stage');
    expect(md).toContain('### Data Quality finding dq-1 — tagging_gap');
    expect(md).toContain('### Data Quality finding dq-2 — partial_coverage');
    // Both categories are absent from reasoning.data_quality, so each is
    // tagged as not-echoed.
    expect(md).toMatch(/dq-1 — tagging_gap[\s\S]*Status:_ not echoed by the reasoner/);
    expect(md).toMatch(/dq-2 — partial_coverage[\s\S]*Status:_ not echoed by the reasoner/);
    // Executive summary should call out the dropped categories.
    expect(md).toContain(
      'Retrieval-stage findings not echoed by the reasoner: tagging_gap (1), partial_coverage (1).',
    );
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

describe('renderMarkdownReport — Run Quality section (Phase 2.5 §Gap 6)', () => {
  const rateLimitFinding: DataQualityFinding = {
    dq_id: 'dq-throttle-1',
    category: 'rate_limit',
    affected_capability: 'amgmcp_cost_analysis',
    affected_scope_subset: null,
    consequence_for_analysis: 'one query throttled — recovered after 120s backoff',
    impact_on_recommendations: [],
    actionable_hint: 'increase the inter-subscription pacing to 60s if recurrent',
  };
  const authzFinding: DataQualityFinding = {
    dq_id: 'dq-rbac-1',
    category: 'authz_gap',
    affected_capability: 'amgmcp_query_activity_log',
    affected_scope_subset: null,
    consequence_for_analysis: 'activity log access denied — change attribution unreliable',
    impact_on_recommendations: [],
    actionable_hint: 'grant the AMG identity Activity Log Reader on the scope',
  };
  const taggingFinding: DataQualityFinding = {
    dq_id: 'dq-tagging-1',
    category: 'tagging_gap',
    affected_capability: 'amgmcp_query_resource_graph',
    affected_scope_subset: null,
    consequence_for_analysis: 'half the inventoried resources lack tags',
    impact_on_recommendations: [],
    actionable_hint: 'apply a tagging policy',
  };

  it('renders a quantified baseline when no transport / freshness findings are present', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).toContain('## Run Quality');
    expect(md).toMatch(
      /0 transport error\(s\), 0 retry attempt\(s\), 0 freshness finding\(s\) across 0 evidence request\(s\)/,
    );
  });

  it('lists transport findings (rate_limit, authz_gap) in the Run Quality section', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      inputDataQuality: [rateLimitFinding, authzFinding],
    });
    expect(md).toMatch(/## Run Quality[\s\S]*dq-throttle-1 — rate_limit/);
    expect(md).toMatch(/## Run Quality[\s\S]*dq-rbac-1 — authz_gap/);
  });

  it('does not duplicate transport findings into the retrieval-stage data-quality section', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      inputDataQuality: [rateLimitFinding],
    });
    // The retrieval-stage section should not render at all when the only
    // pre-reasoner finding is transport-level — Run Quality owns it.
    expect(md).not.toContain('## Data Quality — Retrieval Stage');
  });

  it('keeps analytical findings (tagging_gap) in the retrieval-stage section even when transport findings exist', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      inputDataQuality: [rateLimitFinding, taggingFinding],
    });
    expect(md).toMatch(/## Run Quality[\s\S]*rate_limit/);
    expect(md).toMatch(/## Data Quality — Retrieval Stage[\s\S]*tagging_gap/);
  });

  it('does not flag transport findings as "dropped by reasoner" in the executive summary', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      inputDataQuality: [rateLimitFinding],
    });
    expect(md).not.toContain('rate_limit (1)');
    expect(md).not.toContain('Retrieval-stage findings not echoed');
  });
});

describe('renderMarkdownReport — Run Quality enrichment (Phase 3 §S3)', () => {
  const subId = '11111111-1111-1111-1111-111111111111';
  const cs: Scope = {
    subscription_ids: [subId],
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    analysis_type: 'cost_summary',
    effective_scope_summary: '1 sub, 7-day cost summary',
  };
  const costEvidence: EvidenceRecord[] = [
    {
      evidence_id: 'ev-amgmcp_cost_analysis-aaa',
      source_capability: 'amgmcp_cost_analysis',
      capability_version: '1.0.0',
      query_intent: 'cost_breakdown',
      scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
      time_window: cs.time_window,
      payload_ref: {
        kind: 'inline',
        data: { rows: [], total: { cost: 0, currency: 'USD' } },
      },
      payload_summary: {},
      caveats: [],
    },
  ];

  it('asserts full cost-scope coverage when every scoped sub returned cost evidence', () => {
    const ts: TransportSummaryEntry[] = [
      {
        logical_request_id: 'req-1',
        capability: 'amgmcp_cost_analysis',
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
        parameters_digest: 'a'.repeat(64),
        attempt_count: 1,
        retry_count: 0,
        final_outcome: 'success',
        pacing_applied: false,
        cumulative_backoff_ms: 0,
      },
    ];
    const md = renderMarkdownReport({
      scope: cs,
      reasoning: { facts: [], hypotheses: [], recommendations: [], data_quality: [] },
      evidence: costEvidence,
      metadata,
      transportSummary: ts,
    });
    expect(md).toMatch(/full cost-scope coverage \(1 of 1 subscription\(s\) returned cost evidence\)/);
  });

  it('renders a recovered-throttle capability line WITHOUT requiring a DQ finding', () => {
    const ts: TransportSummaryEntry[] = [
      {
        logical_request_id: 'req-1',
        capability: 'amgmcp_cost_analysis',
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
        parameters_digest: 'a'.repeat(64),
        attempt_count: 3,
        retry_count: 2,
        final_outcome: 'success',
        failure_category: 'rate_limit',
        pacing_applied: false,
        cumulative_backoff_ms: 90_000,
      },
    ];
    const md = renderMarkdownReport({
      scope: cs,
      reasoning: { facts: [], hypotheses: [], recommendations: [], data_quality: [] },
      evidence: costEvidence,
      metadata,
      transportSummary: ts,
    });
    expect(md).toMatch(
      /amgmcp_cost_analysis:\*\* 2 retry attempt\(s\), 90s cumulative backoff, all attempts ultimately succeeded\./,
    );
    // Recovered throttles don't generate DQ findings.
    expect(md).not.toContain('### Data Quality finding dq-throttle');
  });

  it('renders exhausted throttle with rate_limit DQ above it', () => {
    const subB = '22222222-2222-2222-2222-222222222222';
    const multiScope: Scope = { ...cs, subscription_ids: [subId, subB] };
    const ts: TransportSummaryEntry[] = [
      {
        logical_request_id: 'req-1',
        capability: 'amgmcp_cost_analysis',
        scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
        parameters_digest: 'a'.repeat(64),
        attempt_count: 1,
        retry_count: 0,
        final_outcome: 'success',
        pacing_applied: false,
        cumulative_backoff_ms: 0,
      },
      {
        logical_request_id: 'req-2',
        capability: 'amgmcp_cost_analysis',
        scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null },
        parameters_digest: 'b'.repeat(64),
        attempt_count: 4,
        retry_count: 3,
        final_outcome: 'rate_limit',
        failure_category: 'rate_limit',
        pacing_applied: true,
        cumulative_backoff_ms: 210_000,
      },
    ];
    const dq: DataQualityFinding = {
      dq_id: 'dq-failure-1',
      category: 'rate_limit',
      affected_capability: 'amgmcp_cost_analysis',
      affected_scope_subset: null,
      consequence_for_analysis: 'rate-limit (429) calling amgmcp_cost_analysis after retries exhausted',
      impact_on_recommendations: [],
      actionable_hint: 'Back off and serialize calls per subscription.',
    };
    const md = renderMarkdownReport({
      scope: multiScope,
      reasoning: { facts: [], hypotheses: [], recommendations: [], data_quality: [] },
      evidence: costEvidence,
      metadata,
      inputDataQuality: [dq],
      transportSummary: ts,
    });
    expect(md).toMatch(/partial cost-scope coverage \(1 of 2 subscription\(s\) returned cost evidence\)/);
    expect(md).toMatch(/amgmcp_cost_analysis:\*\* 3 retry attempt\(s\), 210s cumulative backoff,/);
    expect(md).toContain('### Data Quality finding dq-failure-1 — rate_limit');
  });

  it('falls back to non-derivable when the scope has no subscription ids', () => {
    // Scope with no subs is unusual but possible (e.g. tagging hygiene
    // surveys); the renderer must not invent counts.
    const odd: Scope = {
      ...cs,
      subscription_ids: [] as unknown as Scope['subscription_ids'],
    };
    const md = renderMarkdownReport({
      scope: odd,
      reasoning: { facts: [], hypotheses: [], recommendations: [], data_quality: [] },
      evidence: [],
      metadata,
    });
    expect(md).toContain('cost-scope coverage not derivable from evidence metadata');
  });
});

describe('renderMarkdownReport — Executive Summary coverage disclosure (Phase 3 §S2)', () => {
  const subA = '11111111-1111-1111-1111-111111111111';
  const subB = '22222222-2222-2222-2222-222222222222';
  const subC = '33333333-3333-3333-3333-333333333333';

  const multiScope: Scope = {
    subscription_ids: [subA, subB, subC],
    time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    analysis_type: 'cost_summary',
    effective_scope_summary: '3 subs',
  };

  const oneCovered: EvidenceRecord[] = [
    {
      evidence_id: 'ev-cost-A',
      source_capability: 'amgmcp_cost_analysis',
      capability_version: '1.0.0',
      query_intent: 'cost_breakdown',
      scope_subset: { subscription_ids: [subA], resource_group_names: null, resource_ids: null },
      time_window: multiScope.time_window,
      payload_ref: { kind: 'inline', data: {} },
      payload_summary: {},
      caveats: [],
    },
  ];

  const twoFailed: TransportSummaryEntry[] = [
    {
      logical_request_id: 'req-1',
      capability: 'amgmcp_cost_analysis',
      scope_subset: { subscription_ids: [subA], resource_group_names: null, resource_ids: null },
      parameters_digest: 'a'.repeat(64),
      attempt_count: 1,
      retry_count: 0,
      final_outcome: 'success',
      pacing_applied: false,
      cumulative_backoff_ms: 0,
    },
    {
      logical_request_id: 'req-2',
      capability: 'amgmcp_cost_analysis',
      scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null },
      parameters_digest: 'b'.repeat(64),
      attempt_count: 4,
      retry_count: 3,
      final_outcome: 'rate_limit',
      failure_category: 'rate_limit',
      pacing_applied: true,
      cumulative_backoff_ms: 210_000,
    },
    {
      logical_request_id: 'req-3',
      capability: 'amgmcp_cost_analysis',
      scope_subset: { subscription_ids: [subC], resource_group_names: null, resource_ids: null },
      parameters_digest: 'c'.repeat(64),
      attempt_count: 4,
      retry_count: 3,
      final_outcome: 'rate_limit',
      failure_category: 'rate_limit',
      pacing_applied: true,
      cumulative_backoff_ms: 210_000,
    },
  ];

  it('renders Coverage: X of Y when only some subs returned evidence', () => {
    const md = renderMarkdownReport({
      scope: multiScope,
      reasoning,
      evidence: oneCovered,
      metadata,
      transportSummary: twoFailed,
    });
    expect(md).toMatch(
      /\*\*Coverage:\*\* 1 of 3 subscription\(s\) returned cost evidence; 2 had retrieval failures \(rate_limit\)/,
    );
    // Coverage line is in the Executive Summary block, above the
    // top-priority recommendation sentence.
    const execIdx = md.indexOf('## Executive Summary');
    const covIdx = md.indexOf('**Coverage:**');
    const recIdx = md.indexOf('The top-priority item is');
    expect(execIdx).toBeLessThan(covIdx);
    expect(covIdx).toBeLessThan(recIdx);
  });

  it('does not render a coverage line when every sub returned cost evidence', () => {
    const fullEvidence: EvidenceRecord[] = [
      oneCovered[0]!,
      { ...oneCovered[0]!, evidence_id: 'ev-cost-B', scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null } },
      { ...oneCovered[0]!, evidence_id: 'ev-cost-C', scope_subset: { subscription_ids: [subC], resource_group_names: null, resource_ids: null } },
    ];
    const md = renderMarkdownReport({
      scope: multiScope,
      reasoning,
      evidence: fullEvidence,
      metadata,
    });
    expect(md).not.toContain('**Coverage:**');
    expect(md).not.toContain('Coverage was incomplete');
  });

  it('renders a generic incomplete-coverage sentence when scope is non-derivable but transport DQs exist', () => {
    const emptyScope: Scope = {
      ...multiScope,
      subscription_ids: [] as unknown as Scope['subscription_ids'],
    };
    const dq: DataQualityFinding = {
      dq_id: 'dq-throttle-1',
      category: 'rate_limit',
      affected_capability: 'amgmcp_cost_analysis',
      affected_scope_subset: null,
      consequence_for_analysis: 'rate-limit (429) — retries exhausted',
      impact_on_recommendations: [],
      actionable_hint: null,
    };
    const md = renderMarkdownReport({
      scope: emptyScope,
      reasoning,
      evidence: [],
      metadata,
      inputDataQuality: [dq],
    });
    expect(md).toContain('Coverage was incomplete due to retrieval-stage rate_limit finding(s)');
  });

  it('still renders the coverage line when there are no recommendations', () => {
    const emptyReasoning: ReasoningOutput = {
      facts: [],
      hypotheses: [],
      recommendations: [],
      data_quality: [],
    };
    const md = renderMarkdownReport({
      scope: multiScope,
      reasoning: emptyReasoning,
      evidence: oneCovered,
      metadata,
      transportSummary: twoFailed,
    });
    expect(md).toMatch(/\*\*Coverage:\*\* 1 of 3 subscription\(s\) returned cost evidence/);
    expect(md).toContain('No recommendations were produced.');
  });
});
