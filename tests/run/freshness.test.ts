import { describe, it, expect } from 'vitest';
import { checkFreshness } from '../../src/run/freshness.js';
import type { EvidenceRecord } from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

function makeCostRecord(overrides: {
  evidence_id?: string;
  start: string;
  end: string;
  source_capability?: string;
}): EvidenceRecord {
  return {
    evidence_id: overrides.evidence_id ?? 'ev-cost-1',
    source_capability: overrides.source_capability ?? 'amgmcp_cost_analysis',
    capability_version: '1.0.0',
    query_intent: 'cost_breakdown',
    scope_subset: { subscription_ids: [subId], resource_group_names: null, resource_ids: null },
    time_window: { start: overrides.start, end: overrides.end },
    payload_ref: { kind: 'inline', data: {} },
    payload_summary: {},
    caveats: [],
  };
}

const now = () => new Date('2026-05-15T12:00:00Z');

describe('checkFreshness — partial-window heuristic', () => {
  it('emits a finding when the cost window ends within the 48h lag threshold', () => {
    const records = [
      makeCostRecord({ start: '2026-05-08T12:00:00Z', end: '2026-05-15T00:00:00Z' }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe('freshness_partial_window');
    expect(findings[0]!.affected_capability).toBe('amgmcp_cost_analysis');
    expect(findings[0]!.consequence_for_analysis).toMatch(/late-posting threshold/);
  });

  it('emits a finding when the cost window ends in the future (period not yet closed)', () => {
    const records = [
      makeCostRecord({ start: '2026-05-08T00:00:00Z', end: '2026-05-22T00:00:00Z' }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(1);
  });

  it('does not emit a finding when the cost window ended well before the threshold', () => {
    const records = [
      makeCostRecord({ start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(0);
  });

  it('emits one finding per distinct end timestamp', () => {
    const records = [
      makeCostRecord({
        evidence_id: 'ev-cost-1',
        start: '2026-05-08T00:00:00Z',
        end: '2026-05-14T18:00:00Z',
      }),
      makeCostRecord({
        evidence_id: 'ev-cost-2',
        start: '2026-05-09T00:00:00Z',
        end: '2026-05-14T23:00:00Z',
      }),
      makeCostRecord({
        evidence_id: 'ev-cost-3',
        start: '2026-05-01T00:00:00Z',
        end: '2026-05-08T00:00:00Z', // stale, not flagged
      }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(2);
  });

  it('dedupes per (source_capability, time_window.end) across fan-out records (§S1)', () => {
    const subB = '22222222-2222-2222-2222-222222222222';
    const subC = '33333333-3333-3333-3333-333333333333';
    const records: EvidenceRecord[] = [
      {
        ...makeCostRecord({ evidence_id: 'ev-cost-1', start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
      },
      {
        ...makeCostRecord({ evidence_id: 'ev-cost-2', start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
        scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null },
      },
      {
        ...makeCostRecord({ evidence_id: 'ev-cost-3', start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
        scope_subset: { subscription_ids: [subC], resource_group_names: null, resource_ids: null },
      },
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.affected_scope_subset?.subscription_ids).toEqual(
      expect.arrayContaining([subId, subB, subC]),
    );
  });

  it('groups by (category, source_capability, time_window.end) — captures intent for future categories', () => {
    // Today's only category is freshness_partial_window, so this test
    // proves the *current* shape: two records with the same capability
    // and same end timestamp collapse, and a third record with a
    // different start (but matching end) merges into the same group.
    // When Phase 3 §Gap 4 lands `freshness_uniform_drop`, the
    // category-in-the-key contract this test asserts keeps the two
    // category-families from colliding.
    const subB = '22222222-2222-2222-2222-222222222222';
    const records = [
      makeCostRecord({ evidence_id: 'ev-1', start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
      {
        ...makeCostRecord({ evidence_id: 'ev-2', start: '2026-05-09T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
        scope_subset: { subscription_ids: [subB], resource_group_names: null, resource_ids: null },
      },
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('freshness_partial_window');
    // The merged scope reflects every input subscription.
    expect(findings[0]?.affected_scope_subset?.subscription_ids).toEqual(
      expect.arrayContaining([subId, subB]),
    );
  });

  it('does not collapse findings from different source capabilities sharing an end timestamp', () => {
    const records = [
      makeCostRecord({ evidence_id: 'ev-1', start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' }),
      makeCostRecord({
        evidence_id: 'ev-2',
        start: '2026-05-08T00:00:00Z',
        end: '2026-05-15T00:00:00Z',
        source_capability: 'cost_analysis',
      }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(2);
  });

  it('ignores non-cost evidence (e.g., resource_graph)', () => {
    const records = [
      makeCostRecord({
        start: '2026-05-08T00:00:00Z',
        end: '2026-05-15T00:00:00Z',
        source_capability: 'amgmcp_query_resource_graph',
      }),
    ];
    const findings = checkFreshness(records, { now });
    expect(findings).toHaveLength(0);
  });

  it('respects a custom lag threshold', () => {
    // With a 24h threshold the 36h-ago window is now stale enough to skip.
    const records = [
      makeCostRecord({ start: '2026-05-08T00:00:00Z', end: '2026-05-14T00:00:00Z' }),
    ];
    expect(checkFreshness(records, { now, lagThresholdMs: 24 * 3600 * 1000 })).toHaveLength(0);
    expect(checkFreshness(records, { now, lagThresholdMs: 48 * 3600 * 1000 })).toHaveLength(1);
  });

  it('produces dq_ids that start from the supplied counter offset', () => {
    const records = [
      makeCostRecord({
        evidence_id: 'ev-cost-1',
        start: '2026-05-08T00:00:00Z',
        end: '2026-05-15T00:00:00Z',
      }),
    ];
    const findings = checkFreshness(records, { now, startingCounter: 7 });
    expect(findings[0]!.dq_id).toBe('dq-freshness-8');
  });

  it('returns [] when there is no evidence at all', () => {
    expect(checkFreshness([], { now })).toEqual([]);
  });

  it('accepts the cost_analysis source_capability alias used by older fixtures', () => {
    const records = [
      makeCostRecord({
        start: '2026-05-08T00:00:00Z',
        end: '2026-05-15T00:00:00Z',
        source_capability: 'cost_analysis',
      }),
    ];
    expect(checkFreshness(records, { now })).toHaveLength(1);
  });
});
