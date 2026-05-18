import type { EvidencePlan, EvidenceRequest, Scope } from '../schemas/index.js';

/**
 * Deterministic cost-surprise playbook (design §4.6).
 *
 * Translates a validated Scope into a fixed EvidencePlan against the
 * Phase 1 capability set. Used when the operator wants reproducibility
 * (the same scope always produces the same plan) or to bootstrap the
 * pipeline before the planner LLM is exercised. The planner reads the
 * same capabilities and should converge on a similar plan; the playbook
 * is the floor, not the ceiling.
 */

export function costSurprisePlaybook(scope: Scope): EvidencePlan {
  const subId = scope.subscription_ids[0];
  if (!subId) {
    throw new Error('cost-surprise playbook requires at least one subscription_id');
  }

  const requests: EvidenceRequest[] = [
    {
      capability: 'query_azure_subscriptions',
      parameters: {},
      intent: 'inventory',
      expected_role: 'confirm scope is reachable and identity has subscription read access',
    },
    {
      capability: 'cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: scope.time_window,
        granularity: 'Daily',
        grouping: ['ServiceName'],
      },
      intent: 'cost_breakdown',
      expected_role: 'analysis-window cost by service',
    },
    {
      capability: 'cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: scope.baseline_window,
        granularity: 'Daily',
        grouping: ['ServiceName'],
      },
      intent: 'cost_breakdown',
      expected_role: 'baseline-window cost by service for delta comparison',
    },
  ];

  if (scope.resource_group_names && scope.resource_group_names.length > 0) {
    for (const rg of scope.resource_group_names) {
      requests.push({
        capability: 'query_resource_graph',
        parameters: {
          subscription_ids: [subId],
          query: `Resources | where resourceGroup =~ '${rg}' | project id, name, type, location, sku, tags`,
        },
        intent: 'inventory',
        expected_role: `inventory of ${rg}`,
      });
      requests.push({
        capability: 'query_activity_log',
        parameters: {
          subscription_id: subId,
          time_window: scope.time_window,
          resource_group_name: rg,
        },
        intent: 'activity',
        expected_role: `management-plane changes in ${rg} during the analysis window`,
      });
    }
  } else {
    requests.push({
      capability: 'query_resource_graph',
      parameters: {
        subscription_ids: [subId],
        query:
          'Resources | summarize count_=count() by type | order by count_ desc | take 20',
      },
      intent: 'inventory',
      expected_role: 'top resource types by count for an unscoped subscription view',
    });
    requests.push({
      capability: 'query_activity_log',
      parameters: {
        subscription_id: subId,
        time_window: scope.time_window,
      },
      intent: 'activity',
      expected_role: 'subscription-wide management-plane changes during the analysis window',
    });
  }

  return { requests };
}
