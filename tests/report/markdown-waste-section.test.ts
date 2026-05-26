import { describe, it, expect } from 'vitest';

import { renderMarkdownReport } from '../../src/report/markdown.js';
import { rollUpLaneTotal, type EstimateResult } from '../../src/pricing/impact.js';
import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
} from '../../src/schemas/index.js';
import type { WasteLaneResult } from '../../src/playbooks/waste-lanes/types.js';

const subId = '77777777-7777-7777-7777-777777777777';

const scope: Scope = {
  subscription_ids: [subId],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: '1 subscription, cost_summary',
};

const evidence: EvidenceRecord[] = [
  {
    evidence_id: 'ev-amgmcp_cost_analysis-aaa',
    source_capability: 'amgmcp_cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    time_window: scope.time_window,
    payload_ref: { kind: 'inline', data: { rows: [], total: { cost: 0, currency: 'USD' } } },
    payload_summary: {},
    caveats: [],
  },
];

const reasoning: ReasoningOutput = {
  facts: [
    {
      fact_id: 'fact-1',
      statement: 'cost was 0',
      evidence_ids: ['ev-amgmcp_cost_analysis-aaa'],
      scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    },
  ],
  hypotheses: [],
  recommendations: [],
  data_quality: [],
};

const metadata: RunMetadata = {
  run_id: '00000000-0000-0000-0000-000000000001',
  trace_id: 'trace-test',
  prompt_versions: { planner: 'planner.v1', reasoner: 'reasoner.v2' },
  model_provider: 'mock',
  model_name: 'mock',
  model_config_hash: 'abcd1234',
  credential_source: { implementation: 'MockCredential', identity: 'mock' },
  amg_mcp_endpoint: 'https://example.amg',
  capability_versions: {},
  started_at: '2026-05-25T00:00:00Z',
  status: 'success',
};

function available(point: number, sku = 'PublicIPAddress_Standard_Static'): EstimateResult {
  return {
    kind: 'available',
    low_usd: Number((point * 0.9).toFixed(2)),
    high_usd: Number((point * 1.1).toFixed(2)),
    point_usd: point,
    count: 1,
    sku,
    source_url: 'https://azure.microsoft.com/en-us/pricing/details/ip-addresses/',
    captured_at: '2026-05-23',
  };
}

function unavailable(sku = 'PublicIPAddress_Basic_Dynamic'): EstimateResult {
  return { kind: 'unavailable', reason: 'sku_not_in_rate_card', count: 1, sku };
}

function makeLane(): WasteLaneResult {
  const estimates: EstimateResult[] = [available(0.84), available(0.84), unavailable()];
  return {
    lane: 'orphan_public_ip',
    title: 'Orphan public IPs',
    predicate_text: "where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration)",
    source_capability: 'az_pixiu_waste_lane',
    candidates: [
      {
        candidate: {
          resource_id: '/subscriptions/77/.../pip-1',
          name: 'pip-1',
          subscription_id: subId,
          resource_group: 'rg-1',
          location: 'eastus',
          sku: 'PublicIPAddress_Standard_Static',
          fields: { skuName: 'Standard', allocationMethod: 'Static' },
        },
        estimated_weekly_impact: estimates[0]!,
        evidence: {
          evidence_id: 'ev-waste-1',
          source_capability: 'az_pixiu_waste_lane',
          capability_version: '1.0.0',
          query_intent: 'waste_candidate',
          scope_subset: { subscription_ids: [subId], resource_group_names: ['rg-1'], resource_ids: ['/subscriptions/77/.../pip-1'] },
          time_window: scope.time_window,
          payload_ref: { kind: 'inline', data: {} },
          payload_summary: {},
          caveats: [],
        },
      },
      {
        candidate: {
          resource_id: '/subscriptions/77/.../pip-2',
          name: 'pip-2',
          subscription_id: subId,
          resource_group: 'rg-1',
          location: 'eastus',
          sku: 'PublicIPAddress_Standard_Static',
          fields: { skuName: 'Standard', allocationMethod: 'Static' },
        },
        estimated_weekly_impact: estimates[1]!,
        evidence: {
          evidence_id: 'ev-waste-2',
          source_capability: 'az_pixiu_waste_lane',
          capability_version: '1.0.0',
          query_intent: 'waste_candidate',
          scope_subset: { subscription_ids: [subId], resource_group_names: ['rg-1'], resource_ids: ['/subscriptions/77/.../pip-2'] },
          time_window: scope.time_window,
          payload_ref: { kind: 'inline', data: {} },
          payload_summary: {},
          caveats: [],
        },
      },
      {
        candidate: {
          resource_id: '/subscriptions/77/.../pip-3-legacy',
          name: 'pip-3-legacy',
          subscription_id: subId,
          resource_group: 'rg-legacy',
          location: 'westus2',
          sku: 'PublicIPAddress_Basic_Dynamic',
          fields: { skuName: 'Basic', allocationMethod: 'Dynamic' },
        },
        estimated_weekly_impact: estimates[2]!,
        evidence: {
          evidence_id: 'ev-waste-3',
          source_capability: 'az_pixiu_waste_lane',
          capability_version: '1.0.0',
          query_intent: 'waste_candidate',
          scope_subset: { subscription_ids: [subId], resource_group_names: ['rg-legacy'], resource_ids: ['/subscriptions/77/.../pip-3-legacy'] },
          time_window: scope.time_window,
          payload_ref: { kind: 'inline', data: {} },
          payload_summary: {},
          caveats: [],
        },
      },
    ],
    lane_total: rollUpLaneTotal(estimates),
    rate_source_captured_at: '2026-05-23',
    unparsed_row_count: 0,
    failed: false,
  };
}

describe('renderMarkdownReport — Waste Candidates section', () => {
  it('renders the section heading between Executive Summary and Recommendations', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [makeLane()],
    });
    expect(md).toContain('## Waste Candidates');
    const wasteAt = md.indexOf('## Waste Candidates');
    const recsAt = md.indexOf('## Recommendations');
    const execAt = md.indexOf('## Executive Summary');
    expect(wasteAt).toBeGreaterThan(execAt);
    expect(wasteAt).toBeLessThan(recsAt);
  });

  it('lists each candidate by name and resource id', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [makeLane()],
    });
    expect(md).toContain('pip-1');
    expect(md).toContain('pip-2');
    expect(md).toContain('pip-3-legacy');
    expect(md).toContain('/subscriptions/77/.../pip-1');
  });

  it('renders priced candidates as a range and unknown-SKU candidates as "rate unavailable"', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [makeLane()],
    });
    // Range format: ~$0.76–$0.92/week (or hyphen-only when no en-dash)
    expect(md).toMatch(/\$0\.7[56]–\$0\.9[23]\/week/);
    expect(md).toContain('rate unavailable for SKU PublicIPAddress_Basic_Dynamic');
  });

  it('cites the classification predicate and rate-source provenance under each lane', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [makeLane()],
    });
    expect(md).toContain("isnull(properties.ipConfiguration)");
    expect(md).toContain('captured 2026-05-23');
    expect(md).toContain('list-price only');
  });

  it('includes a lane total that excludes rate-unavailable candidates', () => {
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [makeLane()],
    });
    // Two priced candidates × $0.84 × ±10%; per-candidate rounding yields
    // 0.76–0.92, summed to 1.52–1.84 in the lane total.
    expect(md).toMatch(/Lane total \(2 priced candidate\(s\)\):\*\* ~\$1\.52–\$1\.84\/week/);
    expect(md).toContain('1 candidate(s) excluded from the total');
  });

  it('elides the section when no lanes were supplied (other analysis types)', () => {
    const md = renderMarkdownReport({ scope, reasoning, evidence, metadata });
    expect(md).not.toContain('## Waste Candidates');
  });

  it('renders a failed lane with the predicate cited but no candidates enumerated', () => {
    const failedLane: WasteLaneResult = {
      lane: 'orphan_public_ip',
      title: 'Orphan public IPs',
      predicate_text: "where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration)",
      source_capability: 'az_pixiu_waste_lane',
      candidates: [],
      lane_total: rollUpLaneTotal([]),
      rate_source_captured_at: '2026-05-23',
      unparsed_row_count: 0,
      failed: true,
    };
    const md = renderMarkdownReport({
      scope,
      reasoning,
      evidence,
      metadata,
      wasteLanes: [failedLane],
    });
    expect(md).toContain('## Waste Candidates');
    expect(md).toContain('did not return data this run');
    expect(md).toContain('isnull(properties.ipConfiguration)');
  });
});
