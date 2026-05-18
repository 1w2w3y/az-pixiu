import type { EvidencePlan, EvidenceRequest, Scope } from '../schemas/index.js';

/**
 * Deterministic cost-summary playbook.
 *
 * Single-window cost dump: no baseline comparison, no anomaly hunt.
 * Calls amgmcp_cost_analysis once per subscription for the analysis
 * window, plus a small resource_graph query for inventory context the
 * reasoner can use to ground its narrative.
 *
 * The reasoner sees the same EvidenceRecord shape as cost-surprise,
 * but with no baseline cost to compare against — its job for this
 * analysis type is to describe (top services, regional distribution,
 * cost concentration) rather than to hypothesize about drift.
 */

export function costSummaryPlaybook(scope: Scope): EvidencePlan {
  if (scope.subscription_ids.length === 0) {
    throw new Error('cost-summary playbook requires at least one subscription_id');
  }

  const requests: EvidenceRequest[] = [
    {
      capability: 'amgmcp_query_azure_subscriptions',
      parameters: {},
      intent: 'inventory',
      expected_role: 'confirm scope is reachable and identity has subscription read access',
    },
  ];

  for (const subId of scope.subscription_ids) {
    requests.push({
      capability: 'amgmcp_cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: scope.time_window,
        granularity: 'Daily',
        grouping: ['ServiceName'],
      },
      intent: 'cost_breakdown',
      expected_role: `cost breakdown by service for ${subId}`,
    });
  }

  // Inventory context — what kinds of resources are running, so the
  // reasoner can tie cost-by-service to resource-by-type.
  requests.push({
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: scope.subscription_ids,
      query:
        'Resources | summarize count_=count() by type | order by count_ desc | take 10',
    },
    intent: 'inventory',
    expected_role: 'top resource types across the selected subscriptions',
  });

  return { requests };
}
