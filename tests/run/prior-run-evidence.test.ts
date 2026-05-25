import { describe, it, expect } from 'vitest';
import { buildPriorRunContextEvidence } from '../../src/run/prior-run-evidence.js';
import type { Scope } from '../../src/schemas/index.js';
import type { RunSummary } from '../../src/history/store.js';

const subId = '11111111-1111-1111-1111-111111111111';

const scope: Scope = {
  subscription_ids: [subId],
  resource_group_names: ['rg-a'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: '1 sub, 1 rg',
};

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: overrides.run_id ?? '00000000-0000-0000-0000-000000000001',
    scope_signature: overrides.scope_signature ?? 'sig-current',
    analysis_type: overrides.analysis_type ?? 'cost_summary',
    started_at: overrides.started_at ?? '2026-04-24T00:00:00Z',
    recommendations: overrides.recommendations ?? [
      {
        recommendation_id: 'rec-prior-1',
        recommendation_signature: 'pg-sku-upgrade-investigation',
        statement: 'consider reviewing PG SKU upgrade',
        priority: 'high',
      },
    ],
    ...(overrides.transport_rollup ? { transport_rollup: overrides.transport_rollup } : {}),
  };
}

describe('buildPriorRunContextEvidence', () => {
  it('returns [] when there are no prior runs', () => {
    expect(buildPriorRunContextEvidence({ priorRuns: [], scope })).toEqual([]);
  });

  it('exact_scope (default): emits one record with no scope-mismatch caveat', () => {
    const out = buildPriorRunContextEvidence({
      priorRuns: [makeSummary({ scope_signature: 'sig-current' })],
      scope,
      currentScopeSignature: 'sig-current',
    });
    expect(out).toHaveLength(1);
    const data = (out[0]!.payload_ref as { kind: 'inline'; data: { match_mode: string } }).data;
    expect(data.match_mode).toBe('exact_scope');
    expect(out[0]!.caveats.some((c) => /did not exactly match/.test(c))).toBe(false);
  });

  it('exact_scope is the default when matchMode is unspecified', () => {
    const out = buildPriorRunContextEvidence({
      priorRuns: [makeSummary({ scope_signature: 'sig-current' })],
      scope,
    });
    const data = (out[0]!.payload_ref as { kind: 'inline'; data: { match_mode: string } }).data;
    expect(data.match_mode).toBe('exact_scope');
    expect(out[0]!.payload_summary).toMatchObject({ match_mode: 'exact_scope' });
  });

  it('operator_override with scope mismatch appends the divergence caveat', () => {
    const out = buildPriorRunContextEvidence({
      priorRuns: [makeSummary({ scope_signature: 'sig-other' })],
      scope,
      matchMode: 'operator_override',
      currentScopeSignature: 'sig-current',
    });
    const data = (out[0]!.payload_ref as { kind: 'inline'; data: { match_mode: string } }).data;
    expect(data.match_mode).toBe('operator_override');
    expect(out[0]!.caveats.some((c) => /did not exactly match/.test(c))).toBe(true);
    expect(out[0]!.payload_summary).toMatchObject({ match_mode: 'operator_override' });
  });

  it('operator_override without scope mismatch does not append the divergence caveat', () => {
    const out = buildPriorRunContextEvidence({
      priorRuns: [makeSummary({ scope_signature: 'sig-current' })],
      scope,
      matchMode: 'operator_override',
      currentScopeSignature: 'sig-current',
    });
    expect(out[0]!.caveats.some((c) => /did not exactly match/.test(c))).toBe(false);
  });

  it('embeds the prior-run scope_signature in payload_ref.data for downstream inspection', () => {
    const out = buildPriorRunContextEvidence({
      priorRuns: [
        makeSummary({ run_id: '00000000-0000-0000-0000-000000000001', scope_signature: 'sig-a' }),
        makeSummary({ run_id: '00000000-0000-0000-0000-000000000002', scope_signature: 'sig-b' }),
      ],
      scope,
      currentScopeSignature: 'sig-current',
    });
    const data = (out[0]!.payload_ref as {
      kind: 'inline';
      data: { prior_runs: Array<{ scope_signature: string }> };
    }).data;
    expect(data.prior_runs.map((r) => r.scope_signature)).toEqual(['sig-a', 'sig-b']);
  });
});
