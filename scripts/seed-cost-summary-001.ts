/**
 * Seed the cost-summary-001 fixture.
 *
 * Healthy `cost_summary` run: single analysis window, no baseline, no
 * resource-group filter. Exercises the second Phase 1 analysis type
 * end-to-end so the eval framework's `expected_capabilities_invoked`
 * check verifies the cost-summary playbook's call shape (cost_analysis
 * + a single resource-graph inventory snapshot).
 *
 * Re-run with: npx tsx scripts/seed-cost-summary-001.ts
 * Idempotent — overwrites the same files each time.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';

const FIXTURE_ROOT = 'fixtures/cost-summary-001';

const SUBSCRIPTION_ID = '33333333-3333-3333-3333-333333333333';

const manifest = {
  fixture_id: 'cost-summary-001',
  description:
    'Synthetic single-window cost_summary fixture (no baseline). Healthy data across two service families; the eval framework uses this fixture to verify the cost-summary playbook call shape and that the runner handles analysis_type=cost_summary end-to-end.',
  analysis_type: 'cost_summary',
  recorded_at: '2026-05-18T00:00:00Z',
  sanitized_at: '2026-05-18T00:00:00Z',
  recorded_from: 'synthetic',
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
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

const calls: FixtureCall[] = [
  {
    capability: 'amgmcp_query_azure_subscriptions',
    parameters: {},
    response: {
      content: {
        subscriptions: [
          { subscriptionId: SUBSCRIPTION_ID, displayName: 'dev-sandbox', state: 'Enabled' },
        ],
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_cost_analysis',
    parameters: {
      subscription_id: SUBSCRIPTION_ID,
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      granularity: 'Daily',
      grouping: ['ServiceName'],
    },
    response: {
      content: {
        columns: [
          { name: 'UsageDate', type: 'string' },
          { name: 'ServiceName', type: 'string' },
          { name: 'Cost', type: 'decimal' },
          { name: 'Currency', type: 'string' },
        ],
        rows: [
          ['2026-05-01', 'App Service', 38.21, 'USD'],
          ['2026-05-01', 'Storage', 11.42, 'USD'],
          ['2026-05-04', 'App Service', 41.55, 'USD'],
          ['2026-05-04', 'Storage', 12.05, 'USD'],
          ['2026-05-07', 'App Service', 42.78, 'USD'],
          ['2026-05-07', 'Storage', 12.71, 'USD'],
        ],
        total: { cost: 158.72, currency: 'USD' },
      },
      isError: false,
    },
  },
  // Inventory snapshot — top resource types overall. Matches the
  // first resource_graph query emitted by the cost-summary playbook
  // (src/playbooks/cost-summary.ts).
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [SUBSCRIPTION_ID],
      query:
        'Resources | summarize count_=count() by type | order by count_ desc | take 15',
    },
    response: {
      content: {
        data: [
          { type: 'Microsoft.Web/sites', count_: 12 },
          { type: 'Microsoft.Storage/storageAccounts', count_: 6 },
          { type: 'Microsoft.OperationalInsights/workspaces', count_: 2 },
        ],
        count: 3,
      },
      isError: false,
    },
  },
  // Type × location cross-cut — lets the reasoner attribute regional
  // spend concentrations to specific resource types in a single
  // static-playbook pass.
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [SUBSCRIPTION_ID],
      query:
        'Resources | summarize count_=count() by type, location | order by count_ desc | take 15',
    },
    response: {
      content: {
        data: [
          { type: 'Microsoft.Web/sites', location: 'westus2', count_: 9 },
          { type: 'Microsoft.Storage/storageAccounts', location: 'westus2', count_: 4 },
          { type: 'Microsoft.Web/sites', location: 'eastus', count_: 3 },
          { type: 'Microsoft.Storage/storageAccounts', location: 'eastus', count_: 2 },
          { type: 'Microsoft.OperationalInsights/workspaces', location: 'westus2', count_: 2 },
        ],
        count: 5,
      },
      isError: false,
    },
  },
  // Tag-coverage roll-up — supports reporting FR-10 (grouping by
  // owner / environment / cost-center) without requiring a fan-out.
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [SUBSCRIPTION_ID],
      query:
        "Resources | extend owner = tostring(tags['owner']), environment = tostring(tags['environment']), cost_center = tostring(tags['cost-center']) | summarize total=count(), no_owner=countif(owner == ''), no_environment=countif(environment == ''), no_cost_center=countif(cost_center == '') by subscriptionId",
    },
    response: {
      content: {
        data: [
          {
            subscriptionId: SUBSCRIPTION_ID,
            total: 20,
            no_owner: 7,
            no_environment: 3,
            no_cost_center: 12,
          },
        ],
        count: 1,
      },
      isError: false,
    },
  },
  // Management-plane activity for the analysis window. Empty-on-quiet
  // is the realistic shape for a sandbox-style sub; the reasoner
  // still gets the signal that no notable changes happened in-window.
  {
    capability: 'amgmcp_query_activity_log',
    parameters: {
      subscription_id: SUBSCRIPTION_ID,
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
    },
    response: {
      content: {
        entries: [
          {
            operation: 'Microsoft.Web/sites/write',
            resource_id:
              '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-app/providers/Microsoft.Web/sites/api-prod',
            timestamp: '2026-05-03T14:22:00Z',
            caller: 'deploy-pipeline@example.com',
            status: 'Succeeded',
          },
          {
            operation: 'Microsoft.Storage/storageAccounts/write',
            resource_id:
              '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-storage/providers/Microsoft.Storage/storageAccounts/logsprod',
            timestamp: '2026-05-05T09:11:00Z',
            caller: 'platform-bot@example.com',
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
