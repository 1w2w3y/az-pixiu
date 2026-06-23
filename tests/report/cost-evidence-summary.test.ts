import { describe, it, expect } from 'vitest';
import { summarizeCostEvidence } from '../../src/report/shared.js';
import type { EvidenceRecord } from '../../src/schemas/index.js';

const SUB = '11111111-1111-1111-1111-111111111111';

function costRecord(sourceCapability: string): EvidenceRecord {
  return {
    evidence_id: `ev-${sourceCapability}-1`,
    source_capability: sourceCapability,
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [SUB], resource_group_names: null, resource_ids: null },
    time_window: { start: '2026-04-01T00:00:00Z', end: '2026-05-01T00:00:00Z' },
    payload_ref: {
      kind: 'inline',
      data: {
        columns: [
          { name: 'UsageDate', type: 'string' },
          { name: 'ServiceName', type: 'string' },
          { name: 'Cost', type: 'decimal' },
          { name: 'Currency', type: 'string' },
        ],
        rows: [
          ['2026-04-01', 'App Service', 100, 'USD'],
          ['2026-04-02', 'Storage', 50, 'USD'],
        ],
        total: { cost: 150, currency: 'USD' },
      },
    },
    payload_summary: { capability: 'amgmcp_cost_analysis', row_count: 2, total_cost: 150, currency: 'USD' },
    caveats: [],
  } as unknown as EvidenceRecord;
}

describe('summarizeCostEvidence', () => {
  it('summarizes cost evidence SERVED FROM the billing cache (regression for default-on)', () => {
    // A cache hit carries source_capability = az_pixiu_billing_cache; the
    // Cost Summary Overview must still render from its replayed payload.
    const summary = summarizeCostEvidence([costRecord('az_pixiu_billing_cache')]);
    expect(summary).toBeDefined();
    expect(summary?.totalCost).toBe(150);
    expect(summary?.currency).toBe('USD');
    expect(summary?.topServices.map((s) => s.name)).toEqual(['App Service', 'Storage']);
  });

  it('still summarizes live wire cost evidence', () => {
    const summary = summarizeCostEvidence([costRecord('amgmcp_cost_analysis')]);
    expect(summary?.totalCost).toBe(150);
  });

  it('returns undefined when there is no cost evidence', () => {
    expect(summarizeCostEvidence([])).toBeUndefined();
    expect(summarizeCostEvidence([costRecord('amgmcp_query_resource_graph')])).toBeUndefined();
  });
});
