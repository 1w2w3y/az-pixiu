/**
 * Seed the cost-surprise-002 fixture.
 *
 * Failure-mode variant of cost-surprise-001: same shape, but the activity
 * log call returns an AMG-MCP wrapped-error payload that the normalizer
 * classifies as `authz_gap`. Exists so the eval framework can verify the
 * runner produces a permission_gap-style DQ finding on partial-data
 * scenarios (evaluation-framework PRD FR-3).
 *
 * Re-run with: npx tsx scripts/seed-cost-surprise-002.ts
 * Idempotent — overwrites the same files each time.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parameterDigest, shortDigest } from '../src/mcp/digest.js';

const FIXTURE_ROOT = 'fixtures/cost-surprise-002';

const SUBSCRIPTION_ID = '22222222-2222-2222-2222-222222222222';

const manifest = {
  fixture_id: 'cost-surprise-002',
  description:
    'Synthetic cost-surprise fixture with a restricted activity log scope. The activity log call returns an AMG-MCP wrapped 403 (access denied) so the run surfaces an authz_gap data-quality finding alongside its recommendations.',
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
          { subscriptionId: SUBSCRIPTION_ID, displayName: 'restricted-scope', state: 'Enabled' },
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
          ['2026-05-01', 'Virtual Machines', 210.55, 'USD'],
          ['2026-05-04', 'Virtual Machines', 295.18, 'USD'],
          ['2026-05-07', 'Virtual Machines', 312.42, 'USD'],
        ],
        total: { cost: 818.15, currency: 'USD' },
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_cost_analysis',
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
          ['2026-04-24', 'Virtual Machines', 198.04, 'USD'],
          ['2026-04-27', 'Virtual Machines', 205.91, 'USD'],
          ['2026-04-30', 'Virtual Machines', 211.66, 'USD'],
        ],
        total: { cost: 615.61, currency: 'USD' },
      },
      isError: false,
    },
  },
  {
    capability: 'amgmcp_query_resource_graph',
    parameters: {
      subscription_ids: [SUBSCRIPTION_ID],
      query:
        "Resources | where resourceGroup =~ 'rg-locked-prod' | project id, name, type, location, sku, tags",
    },
    response: {
      content: {
        data: [
          {
            id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-locked-prod/providers/Microsoft.Compute/virtualMachines/vm-prod-1`,
            name: 'vm-prod-1',
            type: 'Microsoft.Compute/virtualMachines',
            location: 'westus2',
            sku: { name: 'Standard_D8s_v5' },
            tags: { owner: 'platform-team', env: 'prod' },
          },
        ],
        count: 1,
      },
      isError: false,
    },
  },
  // The activity log call is the deliberate failure point: AMG-MCP wraps
  // the downstream 403 as a successful tool result whose text begins
  // with "An error occurred invoking …" and contains "access denied".
  // The normalizer's isWrappedError + classifyWrappedError path turns
  // this into an authz_gap DQ finding (see src/mcp/content.ts).
  {
    capability: 'amgmcp_query_activity_log',
    parameters: {
      subscription_id: SUBSCRIPTION_ID,
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      resource_group_name: 'rg-locked-prod',
    },
    response: {
      content: [
        {
          type: 'text',
          text:
            'An error occurred invoking amgmcp_query_activity_log: 403 access denied — the calling identity is missing Reader on /subscriptions/' +
            SUBSCRIPTION_ID +
            '/resourceGroups/rg-locked-prod.',
        },
      ],
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
