/**
 * Seed the cost-summary-002 fixture.
 *
 * Multi-subscription cost_summary derived from a real live-AMG-MCP run
 * (runs/a0173f27-37ab-4688-9174-b2fb4798a457/run.json) — three internal
 * platform subscriptions whose IDs, display names, callers, and resource
 * IDs have been replaced with deterministic anonymized placeholders. The
 * cost totals, byService / byRegion / byResourceType breakdowns, and the
 * resource-graph type×location distribution come from the recorded
 * response payloads. The tag-coverage roll-up and activity log are
 * authored realistically — the live planner at the time the run was
 * captured did not exercise those queries, so they are reconstructed
 * (consistent with each sub's recorded resource volume) rather than
 * replayed.
 *
 * This fixture exists so the eval suite scores multi-subscription
 * cost_summary end-to-end, the per-subscription playbook fan-out is
 * verified, and the reasoner sees the rich live response shape rather
 * than the columns/rows synthetic shape used by cost-summary-001.
 *
 * Re-run with: npx tsx scripts/seed-cost-summary-002.ts
 * Idempotent — overwrites the same files each time.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';

const FIXTURE_ROOT = 'fixtures/cost-summary-002';

const SUB_PROD = '44444444-4444-4444-4444-444444444444';
const SUB_STAGING = '55555555-5555-5555-5555-555555555555';
const SUB_SANDBOX = '66666666-6666-6666-6666-666666666666';
const ALL_SUBS = [SUB_PROD, SUB_STAGING, SUB_SANDBOX] as const;

const TIME_WINDOW = { start: '2026-05-12T00:00:00Z', end: '2026-05-19T00:00:00Z' };

const manifest = {
  fixture_id: 'cost-summary-002',
  description:
    'Multi-subscription cost_summary fixture. Cost totals and resource-graph distribution are sanitized from a real AMG-MCP run; tag-coverage and activity-log payloads are realistically reconstructed to match the recorded resource volumes.',
  analysis_type: 'cost_summary',
  recorded_at: '2026-05-19T19:48:46Z',
  sanitized_at: '2026-05-20T00:00:00Z',
  recorded_from: 'live AMG-MCP, sanitized (source run a0173f27-37ab-4688-9174-b2fb4798a457)',
  time_window: TIME_WINDOW,
};

const capabilities = {
  capabilities: [
    {
      name: 'amgmcp_query_azure_subscriptions',
      version: '1.0.0',
      description: 'List subscriptions reachable by the AMG identity.',
    },
    {
      name: 'amgmcp_cost_analysis',
      version: '1.0.0',
      description: 'Cost breakdown for a subscription scope and time window.',
    },
    {
      name: 'amgmcp_query_resource_graph',
      version: '1.0.0',
      description: 'Kusto-style queries over the Azure Resource Graph.',
    },
    {
      name: 'amgmcp_query_resource_metric_definition',
      version: '1.0.0',
      description: 'List available metrics for a resource type.',
    },
    {
      name: 'amgmcp_query_resource_metric',
      version: '1.0.0',
      description: 'Fetch Azure Monitor metrics for a batch of resources.',
    },
    {
      name: 'amgmcp_query_activity_log',
      version: '1.0.0',
      description: 'Management-plane activity log entries for a scope and window.',
    },
    {
      name: 'amgmcp_query_resource_health',
      version: '1.0.0',
      description: 'Availability transitions for a resource over a window.',
    },
  ],
};

type FixtureCall = {
  capability: string;
  parameters: Record<string, unknown>;
  response: { content: unknown; isError?: boolean };
};

// --- cost_analysis payloads (real numbers, sanitized subscription IDs) ---

const COST_PROD = {
  periodStart: '2026-05-12',
  periodEnd: '2026-05-19',
  subscriptions: [
    {
      subscriptionId: SUB_PROD,
      totalCost: 5511.65,
      currency: 'USD',
      byService: [
        { name: 'Azure Database for PostgreSQL', cost: 2559 },
        { name: 'Azure Cosmos DB', cost: 863.17 },
        { name: 'Virtual Machines', cost: 527.17 },
        { name: 'Log Analytics', cost: 303.5 },
        { name: 'Azure DDOS Protection', cost: 227.22 },
        { name: 'Microsoft Defender for Cloud', cost: 164.04 },
        { name: 'Container Registry', cost: 152.22 },
        { name: 'Azure Grafana Service', cost: 131.17 },
        { name: 'Storage', cost: 121.7 },
        { name: 'Azure Monitor', cost: 118.18 },
        { name: 'Azure Kubernetes Service', cost: 90.79 },
        { name: 'Redis Cache', cost: 59.7 },
        { name: 'Foundry Models', cost: 52.46 },
        { name: 'Virtual Network', cost: 46.95 },
        { name: 'Event Hubs', cost: 38.64 },
        { name: 'Load Balancer', cost: 20.35 },
        { name: 'Key Vault', cost: 18.7 },
        { name: 'Azure Bastion', cost: 11.94 },
        { name: 'Azure DNS', cost: 2.39 },
        { name: 'Traffic Manager', cost: 1.27 },
        { name: 'Bandwidth', cost: 0.86 },
        { name: 'IoT Central', cost: 0.18 },
        { name: 'Container Instances', cost: 0.05 },
      ],
      byRegion: [
        { name: 'us central', cost: 1198.82 },
        { name: 'us west central', cost: 908 },
        { name: 'us east 2', cost: 651.03 },
        { name: 'us west 2', cost: 608.53 },
        { name: 'se central', cost: 466.96 },
        { name: 'us south central', cost: 443.15 },
        { name: 'us west 3', cost: 421.73 },
        { name: 'us west', cost: 255.97 },
        { name: 'ap southeast', cost: 246.69 },
        { name: 'us east', cost: 103.38 },
        { name: 'se south', cost: 28.2 },
        { name: 'fr central', cost: 22.74 },
        { name: 'eu west', cost: 16.8 },
        { name: 'ap east', cost: 16.58 },
        { name: 'uk south', cost: 14.43 },
        { name: 'br south', cost: 12.96 },
        { name: 'global', cost: 10.39 },
      ],
      byResourceType: [
        { name: 'microsoft.dbforpostgresql/flexibleservers', cost: 2589.57 },
        { name: 'microsoft.documentdb/databaseaccounts', cost: 867.81 },
        { name: 'microsoft.compute/virtualmachinescalesets', cost: 560.89 },
        { name: 'microsoft.operationalinsights/workspaces', cost: 303.5 },
        { name: 'microsoft.network/ddosprotectionplans', cost: 227.22 },
        { name: 'microsoft.containerregistry/registries', cost: 152.22 },
        { name: 'microsoft.containerservice/managedclusters', cost: 146.86 },
        { name: 'microsoft.dashboard/grafana', cost: 132.16 },
        { name: 'microsoft.insights/components', cost: 95.38 },
        { name: 'microsoft.compute/disks', cost: 86.22 },
        { name: 'microsoft.cache/redis', cost: 59.7 },
        { name: 'microsoft.storage/storageaccounts', cost: 59.57 },
        { name: 'microsoft.cognitiveservices/accounts', cost: 53.32 },
        { name: 'microsoft.network/publicipaddresses', cost: 41.06 },
        { name: 'microsoft.eventhub/namespaces', cost: 38.64 },
      ],
    },
  ],
};

const COST_STAGING = {
  periodStart: '2026-05-12',
  periodEnd: '2026-05-19',
  subscriptions: [
    {
      subscriptionId: SUB_STAGING,
      totalCost: 93.42,
      currency: 'USD',
      byService: [
        { name: 'Azure Database for PostgreSQL', cost: 72.29 },
        { name: 'Azure Cosmos DB', cost: 20.72 },
        { name: 'Microsoft Defender for Cloud', cost: 0.41 },
      ],
      byRegion: [
        { name: 'us central', cost: 75.78 },
        { name: 'kr central', cost: 4.65 },
        { name: 'us east 2', cost: 4.65 },
        { name: 'us west 3', cost: 3.1 },
        { name: 'fr central', cost: 2.9 },
        { name: 'de west central', cost: 2.32 },
        { name: 'global', cost: 0.02 },
      ],
      byResourceType: [
        { name: 'microsoft.dbforpostgresql/flexibleservers', cost: 72.68 },
        { name: 'microsoft.documentdb/databaseaccounts', cost: 20.72 },
        { name: 'microsoft.security/pricings', cost: 0.02 },
      ],
    },
  ],
};

const COST_SANDBOX = {
  periodStart: '2026-05-12',
  periodEnd: '2026-05-19',
  subscriptions: [
    {
      subscriptionId: SUB_SANDBOX,
      totalCost: 0.01,
      currency: 'USD',
      byService: [{ name: 'Microsoft Defender for Cloud', cost: 0.01 }],
      byRegion: [{ name: 'global', cost: 0.01 }],
      byResourceType: [{ name: 'microsoft.security/pricings', cost: 0.01 }],
    },
  ],
};

// --- resource_graph: top types (aggregated from the recorded 302-row
// type×location distribution, sanitized). ---

const TOP_TYPES_ROWS = [
  { type: 'microsoft.network/publicipaddresses', count_: 160 },
  { type: 'microsoft.insights/scheduledqueryrules', count_: 154 },
  { type: 'microsoft.managedidentity/userassignedidentities', count_: 139 },
  { type: 'microsoft.insights/metricalerts', count_: 136 },
  { type: 'microsoft.storage/storageaccounts', count_: 119 },
  { type: 'microsoft.dashboard/dashboards', count_: 105 },
  { type: 'microsoft.alertsmanagement/prometheusrulegroups', count_: 96 },
  { type: 'microsoft.insights/webtests', count_: 84 },
  { type: 'microsoft.keyvault/vaults', count_: 61 },
  { type: 'microsoft.compute/virtualmachinescalesets', count_: 49 },
  { type: 'microsoft.network/networksecuritygroups', count_: 44 },
  { type: 'microsoft.insights/datacollectionrules', count_: 42 },
  { type: 'microsoft.dbforpostgresql/flexibleservers', count_: 40 },
  { type: 'microsoft.network/dnszones', count_: 37 },
  { type: 'microsoft.documentdb/databaseaccounts', count_: 29 },
];

// --- resource_graph: top type × location (top 15 of the recorded 302
// rows, with sanitized subscription IDs preserved across the join). ---

const TOP_TYPE_LOCATION_ROWS = [
  { type: 'microsoft.insights/scheduledqueryrules', location: 'westus2', count_: 146 },
  { type: 'microsoft.insights/metricalerts', location: 'global', count_: 136 },
  { type: 'microsoft.insights/webtests', location: 'westus2', count_: 84 },
  { type: 'microsoft.dashboard/dashboards', location: 'westus2', count_: 57 },
  { type: 'microsoft.dashboard/dashboards', location: 'westus3', count_: 38 },
  { type: 'microsoft.network/dnszones', location: 'global', count_: 37 },
  { type: 'microsoft.network/publicipaddresses', location: 'eastus2', count_: 32 },
  { type: 'microsoft.alertsmanagement/prometheusrulegroups', location: 'southcentralus', count_: 26 },
  { type: 'microsoft.alertsmanagement/prometheusrulegroups', location: 'westus2', count_: 26 },
  { type: 'microsoft.network/publicipaddresses', location: 'westus3', count_: 24 },
  { type: 'microsoft.network/trafficmanagerprofiles', location: 'global', count_: 23 },
  { type: 'microsoft.storage/storageaccounts', location: 'eastus2', count_: 23 },
  { type: 'microsoft.managedidentity/userassignedidentities', location: 'westus3', count_: 20 },
  { type: 'microsoft.network/publicipaddresses', location: 'southcentralus', count_: 20 },
  { type: 'microsoft.managedidentity/userassignedidentities', location: 'centralus', count_: 19 },
];

// --- resource_graph: tag coverage roll-up. Synthesized to be consistent
// with the recorded per-subscription resource counts (1659 / 6 / 1) and
// shaped to surface a credible attribution-gap story: the prod sub has
// thin owner coverage but worse cost-center coverage; staging is well
// tagged; sandbox is entirely untagged. ---

const TAG_COVERAGE_ROWS = [
  {
    subscriptionId: SUB_PROD,
    total: 1659,
    no_owner: 412,
    no_environment: 168,
    no_cost_center: 1103,
  },
  {
    subscriptionId: SUB_STAGING,
    total: 6,
    no_owner: 0,
    no_environment: 0,
    no_cost_center: 1,
  },
  {
    subscriptionId: SUB_SANDBOX,
    total: 1,
    no_owner: 1,
    no_environment: 1,
    no_cost_center: 1,
  },
];

// --- activity log entries (per-subscription, sanitized callers). Prod
// has a SKU deploy + RBAC role assignment; staging has a single deploy;
// sandbox is quiet. ---

const ACTIVITY_PROD = {
  entries: [
    {
      operation: 'Microsoft.DBforPostgreSQL/flexibleServers/write',
      resource_id: `/subscriptions/${SUB_PROD}/resourceGroups/rg-data-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-prod-primary`,
      timestamp: '2026-05-14T08:31:42Z',
      caller: 'platform-deploy@example.com',
      properties: { from_sku: 'Standard_D8ds_v5', to_sku: 'Standard_D16ds_v5' },
      status: 'Succeeded',
    },
    {
      operation: 'Microsoft.Authorization/roleAssignments/write',
      resource_id: `/subscriptions/${SUB_PROD}/resourceGroups/rg-platform/providers/Microsoft.Authorization/roleAssignments/role-2026-05-15`,
      timestamp: '2026-05-15T17:04:11Z',
      caller: 'iam-admin@example.com',
      status: 'Succeeded',
    },
    {
      operation: 'Microsoft.ContainerService/managedClusters/write',
      resource_id: `/subscriptions/${SUB_PROD}/resourceGroups/rg-platform/providers/Microsoft.ContainerService/managedClusters/aks-platform-1`,
      timestamp: '2026-05-17T11:48:09Z',
      caller: 'platform-deploy@example.com',
      status: 'Succeeded',
    },
  ],
};

const ACTIVITY_STAGING = {
  entries: [
    {
      operation: 'Microsoft.DocumentDB/databaseAccounts/write',
      resource_id: `/subscriptions/${SUB_STAGING}/resourceGroups/rg-staging/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-staging`,
      timestamp: '2026-05-13T10:12:55Z',
      caller: 'platform-deploy@example.com',
      status: 'Succeeded',
    },
  ],
};

const ACTIVITY_SANDBOX = { entries: [] };

const calls: FixtureCall[] = [
  {
    capability: 'amgmcp_query_azure_subscriptions',
    parameters: {},
    response: {
      content: {
        subscriptions: [
          { subscriptionId: SUB_PROD, displayName: 'corp-platform-prod', state: 'Enabled' },
          { subscriptionId: SUB_STAGING, displayName: 'corp-platform-staging', state: 'Enabled' },
          { subscriptionId: SUB_SANDBOX, displayName: 'corp-platform-sandbox', state: 'Enabled' },
        ],
      },
      isError: false,
    },
  },

  // Per-subscription cost analysis (analysis window only — no baseline
  // for cost_summary).
  {
    capability: 'amgmcp_cost_analysis',
    parameters: {
      subscription_id: SUB_PROD,
      time_window: TIME_WINDOW,
      granularity: 'Daily',
      grouping: ['ServiceName'],
    },
    response: { content: COST_PROD, isError: false },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: {
      subscription_id: SUB_STAGING,
      time_window: TIME_WINDOW,
      granularity: 'Daily',
      grouping: ['ServiceName'],
    },
    response: { content: COST_STAGING, isError: false },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: {
      subscription_id: SUB_SANDBOX,
      time_window: TIME_WINDOW,
      granularity: 'Daily',
      grouping: ['ServiceName'],
    },
    response: { content: COST_SANDBOX, isError: false },
  },

  // Resource-graph fan-out (subscription_ids list shared across calls).
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [...ALL_SUBS],
      query: 'Resources | summarize count_=count() by type | order by count_ desc | take 15',
    },
    response: {
      content: { data: TOP_TYPES_ROWS, count: TOP_TYPES_ROWS.length },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [...ALL_SUBS],
      query:
        'Resources | summarize count_=count() by type, location | order by count_ desc | take 15',
    },
    response: {
      content: { data: TOP_TYPE_LOCATION_ROWS, count: TOP_TYPE_LOCATION_ROWS.length },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [...ALL_SUBS],
      query:
        "Resources | extend owner = tostring(tags['owner']), environment = tostring(tags['environment']), cost_center = tostring(tags['cost-center']) | summarize total=count(), no_owner=countif(owner == ''), no_environment=countif(environment == ''), no_cost_center=countif(cost_center == '') by subscriptionId",
    },
    response: {
      content: { data: TAG_COVERAGE_ROWS, count: TAG_COVERAGE_ROWS.length },
      isError: false,
    },
  },

  // Per-subscription activity log.
  {
    capability: 'amgmcp_query_activity_log',
    parameters: { subscription_id: SUB_PROD, time_window: TIME_WINDOW },
    response: { content: ACTIVITY_PROD, isError: false },
  },
  {
    capability: 'amgmcp_query_activity_log',
    parameters: { subscription_id: SUB_STAGING, time_window: TIME_WINDOW },
    response: { content: ACTIVITY_STAGING, isError: false },
  },
  {
    capability: 'amgmcp_query_activity_log',
    parameters: { subscription_id: SUB_SANDBOX, time_window: TIME_WINDOW },
    response: { content: ACTIVITY_SANDBOX, isError: false },
  },
];

async function main(): Promise<void> {
  const responsesDir = join(FIXTURE_ROOT, 'responses');
  await mkdir(responsesDir, { recursive: true });

  await writeFile(join(FIXTURE_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(
    join(FIXTURE_ROOT, 'capabilities.json'),
    JSON.stringify(capabilities, null, 2) + '\n',
  );

  for (const call of calls) {
    const digest = parameterDigest(call.parameters);
    const filename = `${call.capability}__${shortDigest(digest)}.json`;
    const payload = {
      capability: call.capability,
      parameters: call.parameters,
      parameters_digest: digest,
      response: call.response,
    };
    await writeFile(join(responsesDir, filename), JSON.stringify(payload, null, 2) + '\n');
    process.stdout.write(`wrote responses/${filename}\n`);
  }

  process.stdout.write(`seeded ${calls.length} responses in ${FIXTURE_ROOT}\n`);
}

void main();
