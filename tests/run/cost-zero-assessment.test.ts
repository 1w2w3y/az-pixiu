import { describe, expect, it } from 'vitest';

import type { RawEvidence } from '../../src/evidence/executor.js';
import { parameterDigest } from '../../src/mcp/digest.js';
import {
  QUARANTINED_COST_SOURCE_CAPABILITY,
  assessCostZeroEvidence,
  markQuarantinedCostEvidence,
} from '../../src/run/cost-zero-assessment.js';
import type { EvidenceRecord, EvidenceRequest } from '../../src/schemas/index.js';

const SUB = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function raw(
  capability: string,
  parameters: Record<string, unknown>,
  payload: unknown,
): RawEvidence {
  const request: EvidenceRequest = {
    capability,
    parameters,
    intent: capability === 'amgmcp_cost_analysis' ? 'cost_breakdown' : 'inventory',
  };
  return {
    request,
    parameters_digest: parameterDigest(parameters),
    capability_version: '1.0.0',
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    },
    retrieved_at: '2026-07-10T00:00:00.000Z',
  };
}

function costRaw(
  payload: unknown,
  suffix = '2026-06',
  requestedSub = SUB,
): RawEvidence {
  return raw(
    'amgmcp_cost_analysis',
    {
      subscriptionId: requestedSub,
      startTime: `${suffix}-01T00:00:00Z`,
      endTime: suffix === '2026-06' ? '2026-07-01T00:00:00Z' : '2026-08-01T00:00:00Z',
    },
    payload,
  );
}

function subscriptionInventory(resourceCount: number): RawEvidence {
  return raw('amgmcp_query_azure_subscriptions', {}, {
    subscriptions: [{ subscriptionId: SUB, displayName: 'empty-sub', resourceCount }],
  });
}

describe('assessCostZeroEvidence', () => {
  it('accepts a scope-matched zero only when subscription inventory corroborates an empty scope', () => {
    const zero = costRaw({
      subscriptions: [{ subscriptionId: SUB, totalCost: 0, currency: 'USD', byService: [] }],
    });
    const result = assessCostZeroEvidence([zero, subscriptionInventory(0)]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.assessment).toBe('valid_zero');
    expect(result.data_quality).toEqual([]);
  });

  it('quarantines an internally consistent zero when empty-scope corroboration is unavailable', () => {
    const zero = costRaw({
      subscriptions: [{ subscriptionId: SUB, totalCost: 0, currency: 'USD', byService: [] }],
    });
    const result = assessCostZeroEvidence([zero]);

    expect(result.entries[0]?.assessment).toBe('zero_unresolved');
    expect(result.data_quality[0]?.category).toBe('zero_unresolved');

    const record: EvidenceRecord = {
      evidence_id: result.entries[0]!.evidence_id as EvidenceRecord['evidence_id'],
      source_capability: 'amgmcp_cost_analysis',
      capability_version: '1.0.0',
      query_intent: 'cost_breakdown',
      scope_subset: {
        subscription_ids: [SUB],
        resource_group_names: null,
        resource_ids: null,
      },
      time_window: { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' },
      payload_ref: { kind: 'inline', data: { subscriptions: [] } },
      payload_summary: { total_cost: 0, row_count: 0 },
      caveats: [],
    };
    const [marked] = markQuarantinedCostEvidence([record], result);
    expect(marked?.source_capability).toBe(QUARANTINED_COST_SOURCE_CAPABILITY);
    expect(marked?.caveats.join(' ')).toContain('provenance only');
  });

  it('marks a zero total with a non-zero dimension as suspected', () => {
    const zero = costRaw({
      subscriptions: [
        {
          subscriptionId: SUB,
          totalCost: 0,
          currency: 'USD',
          byService: [{ name: 'Storage', cost: 12.5 }],
        },
      ],
    });
    const result = assessCostZeroEvidence([zero, subscriptionInventory(0)]);

    expect(result.entries[0]?.assessment).toBe('cost_zero_suspected');
    expect(result.data_quality[0]?.category).toBe('cost_zero_suspected');
    expect(result.entries[0]?.reason).toContain('non-zero');
  });

  it('does not prove zero from malformed dimension costs', () => {
    const zero = costRaw({
      subscriptions: [
        {
          subscriptionId: SUB,
          totalCost: 0,
          currency: 'USD',
          byService: [{ name: 'Storage', cost: '12.5' }],
        },
      ],
    });
    const result = assessCostZeroEvidence([zero, subscriptionInventory(0)]);

    expect(result.entries[0]?.assessment).toBe('zero_unresolved');
    expect(result.entries[0]?.reason).toContain('finite numeric cost');
  });

  it.each([-1, 0.5])('does not use invalid resourceCount=%s as empty-scope proof', (count) => {
    const zero = costRaw({
      subscriptions: [{ subscriptionId: SUB, totalCost: 0, currency: 'USD', byService: [] }],
    });
    const result = assessCostZeroEvidence([zero, subscriptionInventory(count)]);

    expect(result.entries[0]?.assessment).toBe('zero_unresolved');
  });

  it('quarantines structured and tabular cost payloads that omit a numeric total', () => {
    const structured = costRaw({ subscriptions: [] });
    const tabular = raw(
      'amgmcp_cost_analysis',
      { subscriptionId: SUB },
      { columns: [{ name: 'UsageDate' }], rows: [] },
    );
    const result = assessCostZeroEvidence([structured, tabular]);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((entry) => entry.assessment === 'zero_unresolved')).toBe(true);
    expect(result.data_quality).toHaveLength(2);
    expect(result.entries.every((entry) => entry.reason.includes('omits a numeric total'))).toBe(true);
  });

  it('quarantines an unrecognized successful cost payload instead of counting it as coverage', () => {
    const malformed = costRaw({ unexpected: 'shape' });
    const result = assessCostZeroEvidence([malformed]);

    expect(result.entries[0]?.assessment).toBe('zero_unresolved');
    expect(result.data_quality[0]?.category).toBe('zero_unresolved');
    expect(result.entries[0]?.reason).toContain('omits a numeric total');
  });

  it('quarantines a tabular zero even when the payload omits the Cost column', () => {
    const zero = raw(
      'amgmcp_cost_analysis',
      { subscriptionId: SUB },
      { columns: [{ name: 'UsageDate' }], rows: [], total: { cost: 0, currency: 'USD' } },
    );
    const result = assessCostZeroEvidence([zero]);

    expect(result.entries[0]?.assessment).toBe('zero_unresolved');
    expect(result.data_quality[0]?.category).toBe('zero_unresolved');
  });

  it('marks a returned subscription mismatch as suspected', () => {
    const zero = costRaw({
      subscriptions: [{ subscriptionId: OTHER, totalCost: 0, currency: 'USD', byService: [] }],
    });
    const result = assessCostZeroEvidence([zero, subscriptionInventory(0)]);

    expect(result.entries[0]?.assessment).toBe('cost_scope_mismatch');
    expect(result.entries[0]?.reason).toContain('exactly the subscription set');
  });

  it.each([
    [
      'wrong subscription',
      [{ subscriptionId: OTHER, totalCost: 42, currency: 'USD', byService: [] }],
    ],
    [
      'extra subscription',
      [
        { subscriptionId: SUB, totalCost: 10, currency: 'USD', byService: [] },
        { subscriptionId: OTHER, totalCost: 20, currency: 'USD', byService: [] },
      ],
    ],
  ] as const)('quarantines a non-zero structured payload with %s', (_case, subscriptions) => {
    const result = assessCostZeroEvidence([costRaw({ subscriptions })]);

    expect(result.entries[0]?.assessment).toBe('cost_scope_mismatch');
    expect(result.data_quality[0]?.category).toBe('cost_scope_mismatch');
  });

  it('marks an all-zero window as suspected when another window for the same subscription is non-zero', () => {
    const zero = costRaw({
      subscriptions: [{ subscriptionId: SUB, totalCost: 0, currency: 'USD', byService: [] }],
    });
    const nonZero = costRaw(
      {
        subscriptions: [
          {
            subscriptionId: SUB,
            totalCost: 42,
            currency: 'USD',
            byService: [{ name: 'Storage', cost: 42 }],
          },
        ],
      },
      '2026-07',
    );
    const result = assessCostZeroEvidence([zero, nonZero, subscriptionInventory(0)]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.assessment).toBe('cost_zero_suspected');
    expect(result.entries[0]?.reason).toContain('another cost record');
  });
});
