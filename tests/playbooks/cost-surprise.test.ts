import { describe, it, expect } from 'vitest';
import { costSurprisePlaybook } from '../../src/playbooks/cost-surprise.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import { PHASE_1_READ_ONLY_ALLOWLIST } from '../../src/mcp/allowlist.js';

const subId = '11111111-1111-1111-1111-111111111111';

const baseScope = intakeScope({
  subscription_id: subId,
  time_window_start: '2026-05-01T00:00:00Z',
  time_window_end: '2026-05-08T00:00:00Z',
  baseline_window_start: '2026-04-24T00:00:00Z',
  baseline_window_end: '2026-05-01T00:00:00Z',
});

describe('costSurprisePlaybook', () => {
  it('always plans both cost_analysis windows (analysis + baseline)', () => {
    const plan = costSurprisePlaybook(baseScope);
    const costCalls = plan.requests.filter((r) => r.capability === 'cost_analysis');
    expect(costCalls).toHaveLength(2);
    const windows = costCalls.map((r) => (r.parameters.time_window as { start: string }).start);
    expect(windows).toContain('2026-05-01T00:00:00Z');
    expect(windows).toContain('2026-04-24T00:00:00Z');
  });

  it('always includes query_azure_subscriptions for scope confirmation', () => {
    const plan = costSurprisePlaybook(baseScope);
    expect(plan.requests.some((r) => r.capability === 'query_azure_subscriptions')).toBe(true);
  });

  it('only requests capabilities from the Phase 1 read-only allowlist', () => {
    const plan = costSurprisePlaybook(baseScope);
    for (const req of plan.requests) {
      expect(PHASE_1_READ_ONLY_ALLOWLIST.has(req.capability)).toBe(true);
    }
  });

  it('emits per-RG activity_log + resource_graph when resource groups are scoped', () => {
    const scoped = intakeScope({
      subscription_id: subId,
      resource_group_names: ['rg-a', 'rg-b'],
      time_window_start: '2026-05-01T00:00:00Z',
      time_window_end: '2026-05-08T00:00:00Z',
      baseline_window_start: '2026-04-24T00:00:00Z',
      baseline_window_end: '2026-05-01T00:00:00Z',
    });
    const plan = costSurprisePlaybook(scoped);
    const rgGraph = plan.requests.filter((r) => r.capability === 'query_resource_graph');
    const rgActivity = plan.requests.filter((r) => r.capability === 'query_activity_log');
    expect(rgGraph.length).toBe(2);
    expect(rgActivity.length).toBe(2);
  });

  it('emits subscription-wide top-types + activity_log when no RGs are given', () => {
    const plan = costSurprisePlaybook(baseScope);
    const graphs = plan.requests.filter((r) => r.capability === 'query_resource_graph');
    expect(graphs).toHaveLength(1);
    expect(String((graphs[0]!.parameters as { query: string }).query)).toContain('summarize');
  });

  it('throws when no subscription is in scope', () => {
    expect(() => costSurprisePlaybook({ ...baseScope, subscription_ids: [] as never })).toThrow();
  });
});
