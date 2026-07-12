/**
 * Seed a public-IP reconciliation case where deterministic list-price
 * exposure is materially higher than same-window billed PIP cost.
 *
 * Re-run with: npx tsx scripts/seed-cost-summary-pip-reconciliation-001.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activityLogParameters, costAnalysisParameters } from '../src/mcp/amg-parameters.js';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';
import { scopeResourceGraphQuery } from '../src/mcp/resource-graph.js';

const FIXTURE_ROOT = 'fixtures/cost-summary-pip-reconciliation-001';
const SUB_SHARED = '77777777-7777-7777-7777-777777777777';
const SUB_SANDBOX = '88888888-8888-8888-8888-888888888888';
const ALL_SUBS = [SUB_SHARED, SUB_SANDBOX] as const;
const TIME_WINDOW = { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' };

const manifest = {
  fixture_id: 'cost-summary-pip-reconciliation-001',
  description:
    'Synthetic cost_summary fixture with five unassociated public-IP review candidates. Four Standard/Static candidates have a 3.04-3.68 USD weekly list-price exposure while same-window billed public-IP resource-type cost is only 0.42 USD; one Basic/Dynamic candidate remains rate-unavailable.',
  analysis_type: 'cost_summary',
  recorded_at: '2026-05-09T00:00:00Z',
  sanitized_at: '2026-05-09T00:00:00Z',
  recorded_from: 'synthetic',
  time_window: TIME_WINDOW,
};

const capabilities = {
  capabilities: [
    { name: 'amgmcp_query_azure_subscriptions', version: '1.0.0', description: 'List subscriptions reachable by the AMG identity.' },
    { name: 'amgmcp_cost_analysis', version: '1.0.0', description: 'Cost breakdown for a subscription scope and time window.' },
    { name: 'amgmcp_query_resource_graph', version: '1.0.0', description: 'Kusto-style queries over the Azure Resource Graph.' },
    { name: 'amgmcp_query_resource_metric_definition', version: '1.0.0', description: 'List available metrics for a resource type.' },
    { name: 'amgmcp_query_resource_metric', version: '1.0.0', description: 'Fetch Azure Monitor metrics for a batch of resources.' },
    { name: 'amgmcp_query_activity_log', version: '1.0.0', description: 'Management-plane activity log entries for a scope and window.' },
    { name: 'amgmcp_query_resource_health', version: '1.0.0', description: 'Availability transitions for a resource over a window.' },
  ],
};

const candidates = [
  {
    id: `/subscriptions/${SUB_SHARED}/resourceGroups/rg-shared-test/providers/Microsoft.Network/publicIPAddresses/pip-test-vhx-inbound-001`,
    name: 'pip-test-vhx-inbound-001', subscriptionId: SUB_SHARED, resourceGroup: 'rg-shared-test', location: 'eastus',
    skuName: 'Standard', allocationMethod: 'Static', ipConfigurationId: '', natGatewayId: '',
  },
  {
    id: `/subscriptions/${SUB_SHARED}/resourceGroups/rg-shared-test/providers/Microsoft.Network/publicIPAddresses/pip-test-vhx-inbound-002`,
    name: 'pip-test-vhx-inbound-002', subscriptionId: SUB_SHARED, resourceGroup: 'rg-shared-test', location: 'eastus',
    skuName: 'Standard', allocationMethod: 'Static', ipConfigurationId: '', natGatewayId: '',
  },
  {
    id: `/subscriptions/${SUB_SHARED}/resourceGroups/rg-shared-test/providers/Microsoft.Network/publicIPAddresses/pip-test-vhx-outbound-001`,
    name: 'pip-test-vhx-outbound-001', subscriptionId: SUB_SHARED, resourceGroup: 'rg-shared-test', location: 'eastus',
    skuName: 'Standard', allocationMethod: 'Static', ipConfigurationId: '', natGatewayId: '',
  },
  {
    id: `/subscriptions/${SUB_SHARED}/resourceGroups/rg-legacy-prototype/providers/Microsoft.Network/publicIPAddresses/pip-legacy-basic-001`,
    name: 'pip-legacy-basic-001', subscriptionId: SUB_SHARED, resourceGroup: 'rg-legacy-prototype', location: 'westus2',
    skuName: 'Basic', allocationMethod: 'Dynamic', ipConfigurationId: '', natGatewayId: '',
  },
  {
    id: `/subscriptions/${SUB_SANDBOX}/resourceGroups/rg-sandbox-app/providers/Microsoft.Network/publicIPAddresses/pip-sandbox-bastion-stale`,
    name: 'pip-sandbox-bastion-stale', subscriptionId: SUB_SANDBOX, resourceGroup: 'rg-sandbox-app', location: 'westus2',
    skuName: 'Standard', allocationMethod: 'Static', ipConfigurationId: '', natGatewayId: '',
  },
];

type FixtureCall = {
  capability: string;
  parameters: Record<string, unknown>;
  response: { content: unknown; isError?: boolean };
};

function costPayload(
  subscriptionId: string,
  totalCost: number,
  publicIpCost: number,
  virtualNetworkCost: number,
) {
  return {
    periodStart: '2026-05-01',
    periodEnd: '2026-05-08',
    subscriptions: [
      {
        subscriptionId,
        totalCost,
        currency: 'USD',
        byService: [{ name: 'Virtual Network', cost: totalCost }],
        byRegion: [{ name: subscriptionId === SUB_SHARED ? 'us east' : 'us west 2', cost: totalCost }],
        byResourceType: [
          { name: 'microsoft.network/publicipaddresses', cost: publicIpCost },
          { name: 'microsoft.network/virtualnetworks', cost: virtualNetworkCost },
        ],
      },
    ],
  };
}

const calls: FixtureCall[] = [
  {
    capability: 'amgmcp_query_azure_subscriptions',
    parameters: {},
    response: {
      content: {
        subscriptions: [
          { subscriptionId: SUB_SHARED, displayName: 'corp-shared-platform-test', state: 'Enabled' },
          { subscriptionId: SUB_SANDBOX, displayName: 'corp-app-team-sandbox', state: 'Enabled' },
        ],
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: costAnalysisParameters(SUB_SHARED, TIME_WINDOW),
    response: { content: costPayload(SUB_SHARED, 12.6, 0.32, 12.28), isError: false },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: costAnalysisParameters(SUB_SANDBOX, TIME_WINDOW),
    response: { content: costPayload(SUB_SANDBOX, 4.2, 0.1, 4.1), isError: false },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        'Resources | summarize count_=count() by type | order by count_ desc | take 15',
        ALL_SUBS,
      ),
    },
    response: {
      content: {
        data: [
          { type: 'Microsoft.Network/publicIPAddresses', count_: 6 },
          { type: 'Microsoft.Network/virtualNetworks', count_: 2 },
        ],
        count: 2,
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        'Resources | summarize count_=count() by type, location | order by count_ desc | take 15',
        ALL_SUBS,
      ),
    },
    response: {
      content: {
        data: [
          { type: 'Microsoft.Network/publicIPAddresses', location: 'eastus', count_: 4 },
          { type: 'Microsoft.Network/publicIPAddresses', location: 'westus2', count_: 2 },
          { type: 'Microsoft.Network/virtualNetworks', location: 'eastus', count_: 2 },
        ],
        count: 3,
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        "Resources | extend owner = tostring(tags['owner']), environment = tostring(tags['environment']), cost_center = tostring(tags['cost-center']) | summarize total=count(), no_owner=countif(owner == ''), no_environment=countif(environment == ''), no_cost_center=countif(cost_center == '') by subscriptionId",
        ALL_SUBS,
      ),
    },
    response: {
      content: {
        data: [
          { subscriptionId: SUB_SHARED, total: 6, no_owner: 4, no_environment: 2, no_cost_center: 5 },
          { subscriptionId: SUB_SANDBOX, total: 2, no_owner: 1, no_environment: 1, no_cost_center: 2 },
        ],
        count: 2,
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        "Resources | where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration) | where isnull(properties.natGateway) | project id, name, subscriptionId, resourceGroup, location, skuName=tostring(sku.name), allocationMethod=tostring(properties.publicIPAllocationMethod), ipConfigurationId=tostring(properties.ipConfiguration.id), natGatewayId=tostring(properties.natGateway.id)",
        ALL_SUBS,
      ),
    },
    response: {
      content: [{ type: 'text', text: JSON.stringify({ data: candidates, count: candidates.length }) }],
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_activity_log',
    parameters: activityLogParameters(SUB_SHARED, TIME_WINDOW),
    response: { content: { entries: [] }, isError: false },
  },
  {
    capability: 'amgmcp_query_activity_log',
    parameters: activityLogParameters(SUB_SANDBOX, TIME_WINDOW),
    response: { content: { entries: [] }, isError: false },
  },
];

async function main(): Promise<void> {
  const responsesDir = join(FIXTURE_ROOT, 'responses');
  await rm(responsesDir, { recursive: true, force: true });
  await mkdir(responsesDir, { recursive: true });
  await writeFile(join(FIXTURE_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(FIXTURE_ROOT, 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`);

  for (const call of calls) {
    const digest = parameterDigest(call.parameters);
    const filename = `${call.capability}__${shortDigest(digest)}.json`;
    await writeFile(
      join(responsesDir, filename),
      `${JSON.stringify({
        capability: call.capability,
        parameters: call.parameters,
        parameters_digest: digest,
        response: call.response,
      }, null, 2)}\n`,
    );
    process.stdout.write(`wrote responses/${filename}\n`);
  }

  process.stdout.write(`seeded ${calls.length} responses in ${FIXTURE_ROOT}\n`);
}

void main();
