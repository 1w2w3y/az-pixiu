import { describe, it, expect } from 'vitest';
import { costSurprisePlaybook } from '../../src/playbooks/cost-surprise.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import { PHASE_1_READ_ONLY_ALLOWLIST } from '../../src/mcp/allowlist.js';

const subId = '11111111-1111-1111-1111-111111111111';

const baseScope = intakeScope({
  subscription_ids: [subId],
  time_window_start: '2026-05-01T00:00:00Z',
  time_window_end: '2026-05-08T00:00:00Z',
  baseline_window_start: '2026-04-24T00:00:00Z',
  baseline_window_end: '2026-05-01T00:00:00Z',
});

describe('costSurprisePlaybook', () => {
  it('always plans both cost_analysis windows (analysis + baseline)', () => {
    const plan = costSurprisePlaybook(baseScope);
    const costCalls = plan.requests.filter((r) => r.capability === 'amgmcp_cost_analysis');
    expect(costCalls).toHaveLength(2);
    const windows = costCalls.map((r) => r.parameters.startTime);
    expect(windows).toContain('2026-05-01T00:00:00Z');
    expect(windows).toContain('2026-04-24T00:00:00Z');
    for (const call of costCalls) {
      expect(Object.keys(call.parameters).sort()).toEqual(['endTime', 'startTime', 'subscriptionId']);
    }
  });

  it('always includes query_azure_subscriptions for scope confirmation', () => {
    const plan = costSurprisePlaybook(baseScope);
    expect(plan.requests.some((r) => r.capability === 'amgmcp_query_azure_subscriptions')).toBe(true);
  });

  it('only requests capabilities from the Phase 1 read-only allowlist', () => {
    const plan = costSurprisePlaybook(baseScope);
    for (const req of plan.requests) {
      expect(PHASE_1_READ_ONLY_ALLOWLIST.has(req.capability)).toBe(true);
    }
  });

  it('emits per-RG activity_log + resource_graph when resource groups are scoped', () => {
    const scoped = intakeScope({
      subscription_ids: [subId],
      resource_group_names: ['rg-a', 'rg-b'],
      time_window_start: '2026-05-01T00:00:00Z',
      time_window_end: '2026-05-08T00:00:00Z',
      baseline_window_start: '2026-04-24T00:00:00Z',
      baseline_window_end: '2026-05-01T00:00:00Z',
    });
    const plan = costSurprisePlaybook(scoped);
    const rgGraph = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    const rgActivity = plan.requests.filter((r) => r.capability === 'amgmcp_query_activity_log');
    expect(rgGraph.length).toBe(2);
    expect(rgActivity.length).toBe(2);
    for (const request of rgGraph) {
      expect(Object.keys(request.parameters)).toEqual(['query']);
      expect(String(request.parameters.query)).toContain('where subscriptionId in~');
      expect(String(request.parameters.query)).toContain('where resourceGroup in~');
    }
    expect(rgActivity.map((request) => request.parameters.scope)).toEqual([
      `/subscriptions/${subId}/resourceGroups/rg-a`,
      `/subscriptions/${subId}/resourceGroups/rg-b`,
    ]);
  });

  it('emits subscription-wide top-types + activity_log when no RGs are given', () => {
    const plan = costSurprisePlaybook(baseScope);
    const graphs = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    expect(graphs).toHaveLength(1);
    expect(String((graphs[0]!.parameters as { query: string }).query)).toContain('summarize');
    expect(Object.keys(graphs[0]!.parameters)).toEqual(['query']);
    expect(String(graphs[0]!.parameters.query)).toContain('where subscriptionId in~');
  });

  it('throws when no subscription is in scope', () => {
    expect(() => costSurprisePlaybook({ ...baseScope, subscription_ids: [] as never })).toThrow();
  });
});
