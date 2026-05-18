/**
 * Seed the cost-surprise-001 fixture.
 *
 * This fixture is hand-authored, synthetic, and sanitized — it does NOT
 * come from a real Azure environment. It exists to exercise the
 * fixture-replay seam (design §13) and provide a deterministic input set
 * for tests until LiveMCPTransport is wired (sequencing step 11).
 *
 * Re-run with: npx tsx scripts/seed-cost-surprise-001.ts
 * Idempotent — overwrites the same files each time.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';

const FIXTURE_ROOT = 'fixtures/cost-surprise-001';

const SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';

const manifest = {
  fixture_id: 'cost-surprise-001',
  description:
    'Synthetic 7-day cost-surprise fixture for Phase 1 development. Not from a real Azure environment.',
  analysis_type: 'cost_surprise',
  recorded_at: '2026-05-18T00:00:00Z',
  sanitized_at: '2026-05-18T00:00:00Z',
  recorded_from: 'synthetic',
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
};

const capabilities = {
  capabilities: [
    {
      name: 'query_azure_subscriptions',
      version: '1.0.0',
      description: 'List subscriptions reachable by the AMG identity.',
    },
    {
      name: 'cost_analysis',
      version: '1.0.0',
      description: 'Cost breakdown for a subscription scope and time window.',
    },
    {
      name: 'query_resource_graph',
      version: '1.0.0',
      description: 'Kusto-style queries over the Azure Resource Graph.',
    },
    {
      name: 'query_resource_metric_definition',
      version: '1.0.0',
      description: 'List available metrics for a resource type.',
    },
    {
      name: 'query_resource_metric',
      version: '1.0.0',
      description: 'Fetch Azure Monitor metrics for a batch of resources.',
    },
    {
      name: 'query_activity_log',
      version: '1.0.0',
      description: 'Management-plane activity log entries for a scope and window.',
    },
    {
      name: 'query_resource_health',
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
    capability: 'query_azure_subscriptions',
    parameters: {},
    response: {
      content: {
        subscriptions: [
          { subscriptionId: SUBSCRIPTION_ID, displayName: 'prod-platform', state: 'Enabled' },
        ],
      },
      isError: false,
    },
  },
  {
    capability: 'cost_analysis',
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
          ['2026-05-01', 'Virtual Machines', 145.32, 'USD'],
          ['2026-05-01', 'Azure Database for PostgreSQL flexible servers', 89.21, 'USD'],
          ['2026-05-01', 'App Service', 62.14, 'USD'],
          ['2026-05-04', 'Azure Database for PostgreSQL flexible servers', 158.87, 'USD'],
          ['2026-05-07', 'Azure Database for PostgreSQL flexible servers', 162.04, 'USD'],
        ],
        total: { cost: 617.58, currency: 'USD' },
      },
      isError: false,
    },
  },
  {
    capability: 'cost_analysis',
    parameters: {
      subscription_id: SUBSCRIPTION_ID,
      time_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
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
          ['2026-04-24', 'Virtual Machines', 144.18, 'USD'],
          ['2026-04-24', 'Azure Database for PostgreSQL flexible servers', 64.55, 'USD'],
          ['2026-04-24', 'App Service', 60.92, 'USD'],
        ],
        total: { cost: 446.91, currency: 'USD' },
      },
      isError: false,
    },
  },
  {
    capability: 'query_resource_graph',
    parameters: {
      subscription_ids: [SUBSCRIPTION_ID],
      query:
        "Resources | where type =~ 'Microsoft.DBforPostgreSQL/flexibleServers' | project id, name, location, sku, tags",
    },
    response: {
      content: {
        data: [
          {
            id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-db-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/db-prod-1`,
            name: 'db-prod-1',
            location: 'eastus',
            sku: { name: 'Standard_D4ds_v5', tier: 'GeneralPurpose' },
            tags: { owner: 'platform-team', env: 'prod' },
          },
          {
            id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-db-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/db-prod-2`,
            name: 'db-prod-2',
            location: 'eastus',
            sku: { name: 'Standard_D8ds_v5', tier: 'GeneralPurpose' },
            tags: {},
          },
        ],
        count: 2,
      },
      isError: false,
    },
  },
  {
    capability: 'query_activity_log',
    parameters: {
      subscription_id: SUBSCRIPTION_ID,
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      resource_group_name: 'rg-db-prod',
    },
    response: {
      content: {
        entries: [
          {
            timestamp: '2026-05-03T14:22:11Z',
            operation: 'Microsoft.DBforPostgreSQL/flexibleServers/write',
            resource_id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-db-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/db-prod-2`,
            caller: 'deploy@example.com',
            properties: { from_sku: 'Standard_D4ds_v5', to_sku: 'Standard_D8ds_v5' },
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
