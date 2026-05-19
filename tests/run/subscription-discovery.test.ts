import { describe, it, expect } from 'vitest';
import {
  discoverTopSubscriptions,
  SubscriptionDiscoveryError,
} from '../../src/run/subscription-discovery.js';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type { CapabilityCatalog, ToolCallResult } from '../../src/schemas/index.js';

const PHASE_1_CATALOG: CapabilityCatalog = {
  capabilities: [
    { name: 'amgmcp_query_azure_subscriptions', version: '1.0.0' },
    { name: 'amgmcp_query_resource_graph', version: '1.0.0' },
  ],
};

class StubTransport implements MCPTransport {
  constructor(
    private readonly responses: Record<string, ToolCallResult>,
  ) {}
  async listCapabilities(): Promise<CapabilityCatalog> {
    return PHASE_1_CATALOG;
  }
  async invoke(capability: string): Promise<ToolCallResult> {
    const r = this.responses[capability];
    if (!r) throw new Error(`no stub response for ${capability}`);
    return r;
  }
  async close(): Promise<void> {}
}

async function makeClient(responses: Record<string, ToolCallResult>): Promise<MCPClient> {
  const client = new MCPClient({ transport: new StubTransport(responses) });
  await client.discover();
  return client;
}

const silent = () => {};

describe('discoverTopSubscriptions — name-field aliases', () => {
  it('picks up subscriptionName from the live AMG-MCP {data:[…]} shape', async () => {
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          totalRecords: 2,
          data: [
            {
              subscriptionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              subscriptionName: 'prod-billing',
              subscriptionURI: '/subscriptions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              resourceCount: 100,
            },
            {
              subscriptionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              subscriptionName: 'dev-sandbox',
              subscriptionURI: '/subscriptions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
              resourceCount: 5,
            },
          ],
        },
      },
      amgmcp_query_resource_graph: {
        content: {
          data: [
            { subscriptionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', resource_count: 100 },
            { subscriptionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', resource_count: 5 },
          ],
        },
      },
    });

    const result = await discoverTopSubscriptions(client, 3, { onProgress: silent });

    expect(result.selected_subscription_ids).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
    expect(result.selected[0].display_name).toBe('prod-billing');
    expect(result.selected[1].display_name).toBe('dev-sandbox');
    // No "no display names" diagnostic should fire when the live shape parses.
    expect(result.diagnostics.some((d) => d.startsWith('no display names'))).toBe(false);
  });

  it('filters by case-insensitive substring against display name', async () => {
    const PROD_ID = '11111111-1111-1111-1111-111111111111';
    const DEV_ID = '22222222-2222-2222-2222-222222222222';
    const TEST_ID = '33333333-3333-3333-3333-333333333333';
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          data: [
            { subscriptionId: PROD_ID, subscriptionName: 'prod-platform-billing' },
            { subscriptionId: DEV_ID, subscriptionName: 'dev-sandbox' },
            { subscriptionId: TEST_ID, subscriptionName: 'PROD-mobile-services' },
          ],
        },
      },
      amgmcp_query_resource_graph: {
        content: {
          data: [
            { subscriptionId: PROD_ID, resource_count: 50 },
            { subscriptionId: DEV_ID, resource_count: 200 },
            { subscriptionId: TEST_ID, resource_count: 10 },
          ],
        },
      },
    });

    const result = await discoverTopSubscriptions(client, 5, {
      onProgress: silent,
      nameFilter: 'PROD',
    });

    expect(result.selected_subscription_ids.sort()).toEqual([PROD_ID, TEST_ID].sort());
  });

  it('matches substrings (not just prefixes) and is case-insensitive', async () => {
    const ID_A = '11111111-1111-1111-1111-111111111111';
    const ID_B = '22222222-2222-2222-2222-222222222222';
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          data: [
            { subscriptionId: ID_A, subscriptionName: 'team-payments-prod' },
            { subscriptionId: ID_B, subscriptionName: 'team-search-dev' },
          ],
        },
      },
      amgmcp_query_resource_graph: {
        content: { data: [{ subscriptionId: ID_A, resource_count: 1 }] },
      },
    });

    const result = await discoverTopSubscriptions(client, 5, {
      onProgress: silent,
      nameFilter: 'payments',
    });

    expect(result.selected_subscription_ids).toEqual([ID_A]);
  });

  it('excludes subscriptions without a display name when a filter is set', async () => {
    const NAMED = '11111111-1111-1111-1111-111111111111';
    const UNNAMED = '22222222-2222-2222-2222-222222222222';
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          data: [
            { subscriptionId: NAMED, subscriptionName: 'prod-billing' },
            // no name at all
            { subscriptionId: UNNAMED },
          ],
        },
      },
      amgmcp_query_resource_graph: {
        content: {
          data: [
            { subscriptionId: NAMED, resource_count: 5 },
            { subscriptionId: UNNAMED, resource_count: 999 },
          ],
        },
      },
    });

    const result = await discoverTopSubscriptions(client, 5, {
      onProgress: silent,
      nameFilter: 'prod',
    });

    expect(result.selected_subscription_ids).toEqual([NAMED]);
    expect(
      result.diagnostics.some((d) => d.includes('1 subscription(s) without a display name')),
    ).toBe(true);
  });

  it('throws SubscriptionDiscoveryError when the filter matches zero subs', async () => {
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          data: [
            {
              subscriptionId: '11111111-1111-1111-1111-111111111111',
              subscriptionName: 'dev-sandbox',
            },
          ],
        },
      },
      amgmcp_query_resource_graph: { content: { data: [] } },
    });

    await expect(
      discoverTopSubscriptions(client, 5, { onProgress: silent, nameFilter: 'nonexistent' }),
    ).rejects.toBeInstanceOf(SubscriptionDiscoveryError);
  });

  it('still accepts the legacy {subscriptions:[{displayName}]} shape used by seeded fixtures', async () => {
    const client = await makeClient({
      amgmcp_query_azure_subscriptions: {
        content: {
          subscriptions: [
            {
              subscriptionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
              displayName: 'legacy-sub',
              state: 'Enabled',
            },
          ],
        },
      },
      amgmcp_query_resource_graph: {
        content: {
          data: [{ subscriptionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', resource_count: 7 }],
        },
      },
    });

    const result = await discoverTopSubscriptions(client, 3, { onProgress: silent });

    expect(result.selected[0].display_name).toBe('legacy-sub');
  });
});
