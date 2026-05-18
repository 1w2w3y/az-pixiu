import type { EvidencePlan, EvidenceRequest, Scope } from '../schemas/index.js';

/**
 * Deterministic cost-surprise playbook (design §4.6).
 *
 * Translates a validated Scope into a fixed EvidencePlan against the
 * Phase 1 capability set. Multi-subscription scopes fan out per
 * subscription for cost_analysis and activity_log (those tools take a
 * single subscription_id), but share resource_graph queries across the
 * whole subscription list.
 *
 * Used when the operator wants reproducibility (the same scope always
 * produces the same plan) or to bootstrap the pipeline before the
 * planner LLM is exercised.
 */

export function costSurprisePlaybook(scope: Scope): EvidencePlan {
  if (scope.subscription_ids.length === 0) {
    throw new Error('cost-surprise playbook requires at least one subscription_id');
  }
  if (!scope.baseline_window) {
    // Belt-and-braces: ScopeSchema's refinement enforces this for the
    // cost_surprise analysis type, so we should never get here.
    throw new Error('cost-surprise playbook requires baseline_window');
  }
  const baselineWindow = scope.baseline_window;

  const requests: EvidenceRequest[] = [
    {
      capability: 'amgmcp_query_azure_subscriptions',
      parameters: {},
      intent: 'inventory',
      expected_role: 'confirm scope is reachable and identity has subscription read access',
    },
  ];

  // Per-subscription cost analysis: analysis window + baseline window.
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
      expected_role: `analysis-window cost for ${subId}`,
    });
    requests.push({
      capability: 'amgmcp_cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: baselineWindow,
        granularity: 'Daily',
        grouping: ['ServiceName'],
      },
      intent: 'cost_breakdown',
      expected_role: `baseline-window cost for ${subId}`,
    });
  }

  if (scope.resource_group_names && scope.resource_group_names.length > 0) {
    for (const rg of scope.resource_group_names) {
      requests.push({
        capability: 'amgmcp_query_resource_graph',
        parameters: {
          subscription_ids: scope.subscription_ids,
          query: `Resources | where resourceGroup =~ '${rg}' | project id, name, type, location, sku, tags`,
        },
        intent: 'inventory',
        expected_role: `inventory of ${rg} across selected subscriptions`,
      });
      for (const subId of scope.subscription_ids) {
        requests.push({
          capability: 'amgmcp_query_activity_log',
          parameters: {
            subscription_id: subId,
            time_window: scope.time_window,
            resource_group_name: rg,
          },
          intent: 'activity',
          expected_role: `management-plane changes in ${rg} for ${subId} during the analysis window`,
        });
      }
    }
  } else {
    requests.push({
      capability: 'amgmcp_query_resource_graph',
      parameters: {
        subscription_ids: scope.subscription_ids,
        query:
          'Resources | summarize count_=count() by type | order by count_ desc | take 20',
      },
      intent: 'inventory',
      expected_role: 'top resource types across selected subscriptions',
    });
    for (const subId of scope.subscription_ids) {
      requests.push({
        capability: 'amgmcp_query_activity_log',
        parameters: {
          subscription_id: subId,
          time_window: scope.time_window,
        },
        intent: 'activity',
        expected_role: `subscription-wide management-plane changes for ${subId} during the analysis window`,
      });
    }
  }

  return { requests };
}
