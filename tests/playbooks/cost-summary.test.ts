import { describe, it, expect } from 'vitest';
import { costSummaryPlaybook } from '../../src/playbooks/cost-summary.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import { PHASE_1_READ_ONLY_ALLOWLIST } from '../../src/mcp/allowlist.js';

const subId = '11111111-1111-1111-1111-111111111111';

function makeScope(extra: Partial<Parameters<typeof intakeScope>[0]> = {}) {
  return intakeScope({
    subscription_ids: [subId],
    analysis_type: 'cost_summary',
    time_window_start: '2026-05-01T00:00:00Z',
    time_window_end: '2026-05-08T00:00:00Z',
    ...extra,
  });
}

describe('costSummaryPlaybook', () => {
  it('emits one cost_analysis per subscription (analysis window only — no baseline)', () => {
    const plan = costSummaryPlaybook(makeScope());
    const costCalls = plan.requests.filter((r) => r.capability === 'amgmcp_cost_analysis');
    expect(costCalls).toHaveLength(1);
    expect((costCalls[0]!.parameters.time_window as { start: string }).start).toBe(
      '2026-05-01T00:00:00Z',
    );
  });

  it('includes query_azure_subscriptions for scope confirmation', () => {
    const plan = costSummaryPlaybook(makeScope());
    expect(plan.requests.some((r) => r.capability === 'amgmcp_query_azure_subscriptions')).toBe(
      true,
    );
  });

  it('includes a resource_graph inventory query', () => {
    const plan = costSummaryPlaybook(makeScope());
    expect(plan.requests.some((r) => r.capability === 'amgmcp_query_resource_graph')).toBe(true);
  });

  it('fans out cost_analysis per subscription when scope has multiple', () => {
    const otherSub = '22222222-2222-2222-2222-222222222222';
    const plan = costSummaryPlaybook(makeScope({ subscription_ids: [subId, otherSub] }));
    const costCalls = plan.requests.filter((r) => r.capability === 'amgmcp_cost_analysis');
    expect(costCalls).toHaveLength(2);
  });

  it('only requests capabilities from the Phase 1 read-only allowlist', () => {
    const plan = costSummaryPlaybook(makeScope());
    for (const req of plan.requests) {
      expect(PHASE_1_READ_ONLY_ALLOWLIST.has(req.capability)).toBe(true);
    }
  });

  it('never requests baseline cost (no second cost_analysis window)', () => {
    const plan = costSummaryPlaybook(makeScope());
    const costCalls = plan.requests.filter((r) => r.capability === 'amgmcp_cost_analysis');
    // exactly one — the analysis window only, never a baseline
    expect(costCalls).toHaveLength(1);
  });

  it('throws when no subscription is in scope', () => {
    expect(() => costSummaryPlaybook({ ...makeScope(), subscription_ids: [] as never })).toThrow();
  });
});
