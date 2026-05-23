import { describe, it, expect } from 'vitest';
import {
  failureCategoryToOutcome,
  rollupTransportSummary,
  scopeSubsetFromParameters,
  type TransportSummaryEntry,
} from '../../src/schemas/transport.js';

const subA = '11111111-1111-1111-1111-111111111111';
const subB = '22222222-2222-2222-2222-222222222222';

function makeEntry(overrides: Partial<TransportSummaryEntry>): TransportSummaryEntry {
  return {
    logical_request_id: 'req-1',
    capability: 'amgmcp_cost_analysis',
    scope_subset: null,
    parameters_digest: 'd'.repeat(64),
    attempt_count: 1,
    retry_count: 0,
    final_outcome: 'success',
    pacing_applied: false,
    cumulative_backoff_ms: 0,
    ...overrides,
  };
}

describe('failureCategoryToOutcome', () => {
  it('maps retriable categories to their own buckets', () => {
    expect(failureCategoryToOutcome('rate_limit')).toBe('rate_limit');
    expect(failureCategoryToOutcome('timeout')).toBe('timeout');
    expect(failureCategoryToOutcome('schema_mismatch')).toBe('transport');
  });

  it('maps remaining categories to "other"', () => {
    expect(failureCategoryToOutcome('auth')).toBe('other');
    expect(failureCategoryToOutcome('authz_gap')).toBe('other');
    expect(failureCategoryToOutcome('invalid_scope')).toBe('other');
    expect(failureCategoryToOutcome('empty_result')).toBe('other');
    expect(failureCategoryToOutcome('unsupported_capability')).toBe('other');
  });
});

describe('scopeSubsetFromParameters', () => {
  it('returns null when no subscription context is present', () => {
    expect(scopeSubsetFromParameters({})).toBeNull();
    expect(scopeSubsetFromParameters({ query: 'select *' })).toBeNull();
  });

  it('extracts a single subscription_id', () => {
    const out = scopeSubsetFromParameters({ subscription_id: subA });
    expect(out).toEqual({
      subscription_ids: [subA],
      resource_group_names: null,
      resource_ids: null,
    });
  });

  it('extracts subscription_ids array (deduplicated)', () => {
    const out = scopeSubsetFromParameters({ subscription_ids: [subA, subB, subA] });
    expect(out?.subscription_ids).toEqual([subA, subB]);
  });

  it('merges single and array forms', () => {
    const out = scopeSubsetFromParameters({
      subscription_id: subA,
      subscription_ids: [subB],
    });
    expect(out?.subscription_ids).toEqual([subA, subB]);
  });

  it('recognises camelCase (subscriptionId/subscriptionIds)', () => {
    const out = scopeSubsetFromParameters({ subscriptionIds: [subA, subB] });
    expect(out?.subscription_ids).toEqual([subA, subB]);
    const out2 = scopeSubsetFromParameters({ subscriptionId: subA });
    expect(out2?.subscription_ids).toEqual([subA]);
  });
});

describe('rollupTransportSummary', () => {
  it('returns zero rollup for empty input', () => {
    const rollup = rollupTransportSummary([]);
    expect(rollup.total_calls).toBe(0);
    expect(rollup.total_attempts).toBe(0);
    expect(rollup.rate_limit_seen).toBe(false);
    expect(rollup.by_capability).toEqual({});
  });

  it('counts successful single-attempt calls per capability', () => {
    const rollup = rollupTransportSummary([
      makeEntry({ logical_request_id: 'req-1', capability: 'amgmcp_cost_analysis' }),
      makeEntry({ logical_request_id: 'req-2', capability: 'amgmcp_cost_analysis' }),
      makeEntry({ logical_request_id: 'req-3', capability: 'amgmcp_query_resource_graph' }),
    ]);
    expect(rollup.total_calls).toBe(3);
    expect(rollup.total_attempts).toBe(3);
    expect(rollup.retry_count).toBe(0);
    expect(rollup.recovered_count).toBe(0);
    expect(rollup.exhausted_count).toBe(0);
    expect(rollup.rate_limit_seen).toBe(false);
    expect(rollup.by_capability.amgmcp_cost_analysis?.calls).toBe(2);
    expect(rollup.by_capability.amgmcp_query_resource_graph?.calls).toBe(1);
  });

  it('treats a final-outcome rate_limit as exhausted and seen', () => {
    const rollup = rollupTransportSummary([
      makeEntry({
        final_outcome: 'rate_limit',
        failure_category: 'rate_limit',
      }),
    ]);
    expect(rollup.exhausted_count).toBe(1);
    expect(rollup.recovered_count).toBe(0);
    expect(rollup.rate_limit_seen).toBe(true);
    expect(rollup.by_capability.amgmcp_cost_analysis?.exhausted_count).toBe(1);
    expect(rollup.by_capability.amgmcp_cost_analysis?.rate_limit_seen).toBe(true);
  });

  it('detects rate_limit_seen on a recovered 429 via observed_failure_categories', () => {
    // The success row has final_outcome='success' and no failure_category;
    // the only signal of the pre-recovery 429 is observed_failure_categories.
    const rollup = rollupTransportSummary([
      makeEntry({
        attempt_count: 3,
        retry_count: 2,
        final_outcome: 'success',
        observed_failure_categories: ['rate_limit'],
        cumulative_backoff_ms: 90_000,
      }),
    ]);
    expect(rollup.recovered_count).toBe(1);
    expect(rollup.rate_limit_seen).toBe(true);
    expect(rollup.by_capability.amgmcp_cost_analysis?.rate_limit_seen).toBe(true);
  });

  it('counts retries-that-recovered separately from exhausted retries', () => {
    const rollup = rollupTransportSummary([
      makeEntry({
        logical_request_id: 'req-1',
        attempt_count: 3,
        retry_count: 2,
        final_outcome: 'success',
        cumulative_backoff_ms: 90_000,
      }),
      makeEntry({
        logical_request_id: 'req-2',
        attempt_count: 4,
        retry_count: 3,
        final_outcome: 'rate_limit',
        failure_category: 'rate_limit',
        cumulative_backoff_ms: 540_000,
      }),
    ]);
    expect(rollup.total_attempts).toBe(7);
    expect(rollup.retry_count).toBe(5);
    expect(rollup.recovered_count).toBe(1);
    expect(rollup.exhausted_count).toBe(1);
    expect(rollup.rate_limit_seen).toBe(true);
    expect(rollup.cumulative_backoff_ms).toBe(630_000);
  });
});
