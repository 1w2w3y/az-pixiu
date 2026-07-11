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
    expect(costCalls[0]!.parameters).toEqual({
      subscriptionId: subId,
      startTime: '2026-05-01T00:00:00Z',
      endTime: '2026-05-08T00:00:00Z',
    });
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

  it('scopes every ARG query in supported KQL and sends no unsupported subscription_ids argument', () => {
    const otherSub = '22222222-2222-2222-2222-222222222222';
    const plan = costSummaryPlaybook(makeScope({ subscription_ids: [subId, otherSub] }));
    const argCalls = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');

    expect(argCalls).toHaveLength(3);
    for (const call of argCalls) {
      expect(Object.keys(call.parameters)).toEqual(['query']);
      expect(call.intended_scope_subset).toEqual({
        subscription_ids: [subId, otherSub],
        resource_group_names: null,
        resource_ids: null,
      });
      const query = String(call.parameters.query);
      expect(query).toContain('where subscriptionId in~');
      expect(query).toContain(`'${subId}'`);
      expect(query).toContain(`'${otherSub}'`);
    }
  });

  it('carries resource-group and resource-type filters inside ARG KQL', () => {
    const plan = costSummaryPlaybook(
      makeScope({
        resource_group_names: ['rg-finops'],
        resource_type_filter: ['microsoft.storage/storageaccounts'],
      }),
    );
    const argCalls = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    for (const call of argCalls) {
      const query = String(call.parameters.query);
      expect(query).toContain("where resourceGroup in~ ('rg-finops')");
      expect(query).toContain("where type in~ ('microsoft.storage/storageaccounts')");
    }
  });

  it('treats an empty resource-group list as no filter in KQL and provenance', () => {
    const plan = costSummaryPlaybook(makeScope({ resource_group_names: [] }));
    const argCalls = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    for (const call of argCalls) {
      expect(String(call.parameters.query)).not.toContain('where resourceGroup in~');
      expect(call.intended_scope_subset?.resource_group_names).toBeNull();
    }
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

  it('includes a type × location cross-cut so regional cost can be tied to resource types', () => {
    const plan = costSummaryPlaybook(makeScope());
    const argCalls = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    expect(
      argCalls.some((r) =>
        typeof r.parameters.query === 'string' &&
        r.parameters.query.includes('by type, location'),
      ),
    ).toBe(true);
  });

  it('includes a tag-coverage roll-up keyed by subscription', () => {
    const plan = costSummaryPlaybook(makeScope());
    const argCalls = plan.requests.filter((r) => r.capability === 'amgmcp_query_resource_graph');
    expect(
      argCalls.some((r) => {
        const q = r.parameters.query;
        return typeof q === 'string' && q.includes('no_owner') && q.includes('by subscriptionId');
      }),
    ).toBe(true);
  });

  it('emits one activity_log call per subscription scoped to the analysis window', () => {
    const otherSub = '22222222-2222-2222-2222-222222222222';
    const plan = costSummaryPlaybook(makeScope({ subscription_ids: [subId, otherSub] }));
    const activityCalls = plan.requests.filter(
      (r) => r.capability === 'amgmcp_query_activity_log',
    );
    expect(activityCalls).toHaveLength(2);
    expect(activityCalls.map((c) => c.parameters)).toEqual([
      {
        scope: `/subscriptions/${subId}`,
        startTime: '2026-05-01T00:00:00Z',
        endTime: '2026-05-08T00:00:00Z',
      },
      {
        scope: '/subscriptions/22222222-2222-2222-2222-222222222222',
        startTime: '2026-05-01T00:00:00Z',
        endTime: '2026-05-08T00:00:00Z',
      },
    ]);
  });
});
