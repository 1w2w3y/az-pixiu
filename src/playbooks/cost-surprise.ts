import type { EvidencePlan, EvidenceRequest, Scope } from '../schemas/index.js';
import { activityLogParameters, costAnalysisParameters } from '../mcp/amg-parameters.js';
import { normalizeScopeValues, scopeResourceGraphQuery } from '../mcp/resource-graph.js';

/**
 * Deterministic cost-surprise playbook (design §4.6).
 *
 * Translates a validated Scope into a fixed EvidencePlan against the
 * Phase 1 capability set. Multi-subscription scopes fan out per
 * subscription for cost_analysis and activity_log (those tools take a
 * single subscription scope), but share resource_graph queries across the
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
  const intendedSubscriptions = normalizeScopeValues(scope.subscription_ids);
  const intendedResourceTypes = normalizeScopeValues(scope.resource_type_filter ?? []);

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
      parameters: costAnalysisParameters(subId, scope.time_window),
      intent: 'cost_breakdown',
      expected_role: `analysis-window cost for ${subId}`,
    });
    requests.push({
      capability: 'amgmcp_cost_analysis',
      parameters: costAnalysisParameters(subId, baselineWindow),
      intent: 'cost_breakdown',
      expected_role: `baseline-window cost for ${subId}`,
    });
  }

  if (scope.resource_group_names && scope.resource_group_names.length > 0) {
    for (const rg of scope.resource_group_names) {
      requests.push({
        capability: 'amgmcp_query_resource_graph',
        parameters: {
          query: scopeResourceGraphQuery(
            'Resources | project id, name, type, location, sku, tags',
            scope.subscription_ids,
            { resourceGroupNames: [rg], resourceTypes: scope.resource_type_filter },
          ),
        },
        intent: 'inventory',
        intended_scope_subset: {
          subscription_ids: intendedSubscriptions,
          resource_group_names: [rg],
          resource_ids: null,
        },
        expected_role: `inventory of ${rg} across selected subscriptions`,
      });
      for (const subId of scope.subscription_ids) {
        requests.push({
          capability: 'amgmcp_query_activity_log',
          parameters: activityLogParameters(subId, scope.time_window, rg),
          intent: 'activity',
          intended_scope_subset: {
            subscription_ids: [subId],
            resource_group_names: [rg],
            resource_ids: null,
          },
          expected_role: `management-plane changes in ${rg} for ${subId} during the analysis window`,
        });
      }
    }
  } else {
    requests.push({
      capability: 'amgmcp_query_resource_graph',
      parameters: {
        query: scopeResourceGraphQuery(
          'Resources | summarize count_=count() by type | order by count_ desc | take 20',
          scope.subscription_ids,
          { resourceTypes: scope.resource_type_filter },
        ),
      },
      intent: 'inventory',
      intended_scope_subset: {
        subscription_ids: intendedSubscriptions,
        resource_group_names: null,
        resource_ids: null,
      },
      expected_role: 'top resource types across selected subscriptions',
    });
    for (const subId of scope.subscription_ids) {
      requests.push({
        capability: 'amgmcp_query_activity_log',
        parameters: activityLogParameters(subId, scope.time_window),
        intent: 'activity',
        intended_scope_subset: {
          subscription_ids: [subId],
          resource_group_names: null,
          resource_ids: null,
        },
        expected_role: `subscription-wide management-plane changes for ${subId} during the analysis window`,
      });
    }
  }

  return { requests };
}
