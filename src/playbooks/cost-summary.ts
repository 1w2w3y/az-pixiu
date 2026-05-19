import type { EvidencePlan, EvidenceRequest, Scope } from '../schemas/index.js';

/**
 * Deterministic cost-summary playbook.
 *
 * Single-window cost dump: no baseline comparison, no anomaly hunt.
 * The plan stays static (one EvidencePlan per scope, no result-driven
 * follow-ups) but covers the dimensions a cost-review reader expects:
 *
 *   1. amgmcp_query_azure_subscriptions — scope reachability check.
 *   2. amgmcp_cost_analysis per subscription — analysis-window spend.
 *      The live response already includes byService/byRegion/byResourceType
 *      breakdowns, so the reasoner gets all three dimensions from one call.
 *   3. amgmcp_query_resource_graph — top resource types overall.
 *   4. amgmcp_query_resource_graph — top resource type × location cells,
 *      so a regional cost concentration can be tied to specific types
 *      without needing a second planning phase.
 *   5. amgmcp_query_resource_graph — tag-coverage roll-up (owner /
 *      environment / cost-center), supporting reporting FR-10 grouping
 *      by enterprise tag dimensions and the tagging-hygiene use case.
 *   6. amgmcp_query_activity_log per subscription — management-plane
 *      events during the window, so notable lifecycle changes (deploys,
 *      resizes, RBAC) can anchor the cost narrative for the period.
 *
 * The reasoner sees the same EvidenceRecord shape as cost-surprise,
 * but with no baseline cost to compare against — its job for this
 * analysis type is to describe (top services, regional distribution,
 * cost concentration, tagging gaps, period-defining changes) rather
 * than to hypothesize about drift.
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
        'Resources | summarize count_=count() by type | order by count_ desc | take 15',
    },
    intent: 'inventory',
    expected_role: 'top resource types across the selected subscriptions',
  });

  // Type × location cross-cut. The cost_analysis response already
  // breaks spend down byRegion and byResourceType separately; this
  // joins those dimensions so the reasoner can say "Microsoft.Sql/servers
  // in westus2 dominate the regional total" rather than just listing
  // axis totals.
  requests.push({
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: scope.subscription_ids,
      query:
        'Resources | summarize count_=count() by type, location | order by count_ desc | take 15',
    },
    intent: 'inventory',
    expected_role: 'top resource type × location cells for regional cost attribution',
  });

  // Tag-coverage roll-up. Supports reporting FR-10 (grouping by owner /
  // environment / cost-center) and the tagging-hygiene use case. Counts
  // resources missing each of the three governance tags we care about
  // per subscription so the reasoner can call out attribution gaps.
  requests.push({
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: scope.subscription_ids,
      query:
        "Resources | extend owner = tostring(tags['owner']), environment = tostring(tags['environment']), cost_center = tostring(tags['cost-center']) | summarize total=count(), no_owner=countif(owner == ''), no_environment=countif(environment == ''), no_cost_center=countif(cost_center == '') by subscriptionId",
    },
    intent: 'inventory',
    expected_role: 'tag-coverage roll-up (owner / environment / cost-center) per subscription',
  });

  // Management-plane changes during the analysis window. For a cost
  // review this anchors the spend picture in concrete lifecycle events
  // (deploys, resizes, RBAC changes) rather than leaving "what changed"
  // as a guess.
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

  return { requests };
}
