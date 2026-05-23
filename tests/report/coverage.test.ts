import { describe, it, expect } from 'vitest';
import {
  computeCostCoverage,
  hasIncompleteCoverage,
  isFullCoverage,
} from '../../src/report/coverage.js';
import type {
  EvidenceRecord,
  Scope,
  TransportSummaryEntry,
} from '../../src/schemas/index.js';

const subA = '11111111-1111-1111-1111-111111111111';
const subB = '22222222-2222-2222-2222-222222222222';
const subC = '33333333-3333-3333-3333-333333333333';

const scope: Scope = {
  subscription_ids: [subA, subB, subC],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: '3 subs',
};

function costRecord(subId: string): EvidenceRecord {
  return {
    evidence_id: `ev-${subId.slice(0, 4)}`,
    source_capability: 'amgmcp_cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    time_window: scope.time_window,
    payload_ref: { kind: 'inline', data: {} },
    payload_summary: {},
    caveats: [],
  };
}

function transportEntry(
  overrides: Partial<TransportSummaryEntry> & { capability?: string },
): TransportSummaryEntry {
  return {
    logical_request_id: overrides.logical_request_id ?? 'req-x',
    capability: overrides.capability ?? 'amgmcp_cost_analysis',
    scope_subset: overrides.scope_subset ?? null,
    parameters_digest: overrides.parameters_digest ?? 'a'.repeat(64),
    attempt_count: overrides.attempt_count ?? 1,
    retry_count: overrides.retry_count ?? 0,
    final_outcome: overrides.final_outcome ?? 'success',
    pacing_applied: overrides.pacing_applied ?? false,
    cumulative_backoff_ms: overrides.cumulative_backoff_ms ?? 0,
    ...(overrides.failure_category ? { failure_category: overrides.failure_category } : {}),
  };
}

describe('computeCostCoverage', () => {
  it('reports non-derivable when the scope has no subscription ids', () => {
    const out = computeCostCoverage({
      scope: { ...scope, subscription_ids: [] as unknown as Scope['subscription_ids'] },
      evidence: [],
    });
    expect(out.derivable).toBe(false);
    expect(isFullCoverage(out)).toBe(false);
    expect(hasIncompleteCoverage(out)).toBe(false);
  });

  it('counts a subscription as covered when at least one cost record carries its id', () => {
    const out = computeCostCoverage({
      scope,
      evidence: [costRecord(subA), costRecord(subB), costRecord(subC)],
    });
    expect(isFullCoverage(out)).toBe(true);
    expect(out.covered_ids).toEqual([subA, subB, subC]);
    expect(out.unavailable_ids).toEqual([]);
  });

  it('marks the failing sub as unavailable when transport_summary identifies it', () => {
    const out = computeCostCoverage({
      scope,
      evidence: [costRecord(subA)],
      transportSummary: [
        transportEntry({
          scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null },
          final_outcome: 'rate_limit',
          failure_category: 'rate_limit',
          attempt_count: 4,
          retry_count: 3,
        }),
        transportEntry({
          scope_subset: { subscription_ids: [subC], resource_group_names: null, resource_ids: null },
          final_outcome: 'rate_limit',
          failure_category: 'rate_limit',
          attempt_count: 4,
          retry_count: 3,
        }),
      ],
    });
    expect(out.covered_ids).toEqual([subA]);
    expect(out.unavailable_ids).toEqual([subB, subC]);
    expect(out.unavailable_by_category.rate_limit).toEqual([subB, subC]);
    expect(out.unknown_ids).toEqual([]);
    expect(hasIncompleteCoverage(out)).toBe(true);
  });

  it('treats subs missing from both evidence and transport_summary as unknown', () => {
    const out = computeCostCoverage({
      scope,
      evidence: [costRecord(subA)],
    });
    expect(out.unknown_ids).toEqual([subB, subC]);
    expect(out.unavailable_ids).toEqual([]);
  });

  it('does not mark a sub as unavailable if it also has successful cost evidence', () => {
    // Recovered retry case: sub had a rate_limit early in retries but
    // eventually got evidence — final_outcome should be 'success' but
    // even if some odd entry says 'rate_limit', coverage prefers evidence.
    const out = computeCostCoverage({
      scope: { ...scope, subscription_ids: [subA, subB] },
      evidence: [costRecord(subA), costRecord(subB)],
      transportSummary: [
        transportEntry({
          scope_subset: { subscription_ids: [subA], resource_group_names: null, resource_ids: null },
          final_outcome: 'rate_limit',
          failure_category: 'rate_limit',
        }),
      ],
    });
    expect(out.unavailable_ids).toEqual([]);
    expect(out.covered_ids).toEqual([subA, subB]);
  });
});
