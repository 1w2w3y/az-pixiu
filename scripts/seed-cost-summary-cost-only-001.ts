/**
 * Seed a cost-summary case where PostgreSQL is materially expensive but
 * no utilization evidence is available. The fixture is intentionally
 * cost-only: a model may recommend a bounded human investigation, but it
 * cannot defend an underutilization, target-SKU, or savings claim.
 *
 * Re-run with: npx tsx scripts/seed-cost-summary-cost-only-001.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activityLogParameters, costAnalysisParameters } from '../src/mcp/amg-parameters.js';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';
import { scopeResourceGraphQuery } from '../src/mcp/resource-graph.js';

const FIXTURE_ROOT = 'fixtures/cost-summary-cost-only-001';
const SUBSCRIPTION_ID = '99999999-9999-9999-9999-999999999999';
const TIME_WINDOW = { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' };

const manifest = {
  fixture_id: 'cost-summary-cost-only-001',
  description:
    'Synthetic cost_summary fixture with 7,000 USD of observed cost, including 5,600 USD for PostgreSQL, but deliberately no raw utilization evidence. It tests whether reasoning stays investigative instead of asserting underutilization, a target SKU, or savings.',
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

type FixtureCall = {
  capability: string;
  parameters: Record<string, unknown>;
  response: { content: unknown; isError?: boolean };
};

const calls: FixtureCall[] = [
  {
    capability: 'amgmcp_query_azure_subscriptions',
    parameters: {},
    response: {
      content: {
        subscriptions: [
          { subscriptionId: SUBSCRIPTION_ID, displayName: 'corp-data-prod', state: 'Enabled' },
        ],
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: costAnalysisParameters(SUBSCRIPTION_ID, TIME_WINDOW),
    response: {
      content: {
        periodStart: '2026-05-01',
        periodEnd: '2026-05-08',
        subscriptions: [
          {
            subscriptionId: SUBSCRIPTION_ID,
            totalCost: 7000,
            currency: 'USD',
            byService: [
              { name: 'Azure Database for PostgreSQL', cost: 5600 },
              { name: 'Virtual Machines', cost: 900 },
              { name: 'Log Analytics', cost: 500 },
            ],
            byRegion: [{ name: 'us west 2', cost: 7000 }],
            byResourceType: [
              { name: 'microsoft.dbforpostgresql/flexibleservers', cost: 5600 },
              { name: 'microsoft.compute/virtualmachinescalesets', cost: 900 },
              { name: 'microsoft.operationalinsights/workspaces', cost: 500 },
            ],
          },
        ],
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        'Resources | summarize count_=count() by type | order by count_ desc | take 15',
        [SUBSCRIPTION_ID],
      ),
    },
    response: {
      content: {
        data: [
          { type: 'microsoft.compute/virtualmachinescalesets', count_: 12 },
          { type: 'microsoft.dbforpostgresql/flexibleservers', count_: 4 },
          { type: 'microsoft.operationalinsights/workspaces', count_: 2 },
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
        'Resources | summarize count_=count() by type, location | order by count_ desc | take 15',
        [SUBSCRIPTION_ID],
      ),
    },
    response: {
      content: {
        data: [
          { type: 'microsoft.compute/virtualmachinescalesets', location: 'westus2', count_: 12 },
          { type: 'microsoft.dbforpostgresql/flexibleservers', location: 'westus2', count_: 4 },
          { type: 'microsoft.operationalinsights/workspaces', location: 'westus2', count_: 2 },
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
        [SUBSCRIPTION_ID],
      ),
    },
    response: {
      content: {
        data: [
          {
            subscriptionId: SUBSCRIPTION_ID,
            total: 18,
            no_owner: 0,
            no_environment: 0,
            no_cost_center: 0,
          },
        ],
        count: 1,
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      query: scopeResourceGraphQuery(
        "Resources | where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration) | where isnull(properties.natGateway) | project id, name, subscriptionId, resourceGroup, location, skuName=tostring(sku.name), allocationMethod=tostring(properties.publicIPAllocationMethod), ipConfigurationId=tostring(properties.ipConfiguration.id), natGatewayId=tostring(properties.natGateway.id)",
        [SUBSCRIPTION_ID],
      ),
    },
    response: { content: { data: [], count: 0 }, isError: false },
  },
  {
    capability: 'amgmcp_query_activity_log',
    parameters: activityLogParameters(SUBSCRIPTION_ID, TIME_WINDOW),
    response: {
      content: {
        entries: [
          {
            operation: 'Microsoft.DBforPostgreSQL/flexibleServers/write',
            resource_id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-data-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-prod-primary`,
            timestamp: '2026-05-03T08:31:42Z',
            caller: 'platform-deploy@example.com',
            properties: { from_sku: 'Standard_D8ds_v5', to_sku: 'Standard_D16ds_v5' },
            status: 'Succeeded',
          },
        ],
      },
      isError: false,
    },
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
