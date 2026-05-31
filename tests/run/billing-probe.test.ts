import { describe, it, expect } from 'vitest';
import { probeBillingAccess } from '../../src/run/billing-probe.js';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type { CapabilityCatalog, ToolCallResult } from '../../src/schemas/index.js';
import { BillingProbeCache } from '../../src/run/billing-probe-cache.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CATALOG: CapabilityCatalog = {
  capabilities: [
    { name: 'amgmcp_cost_analysis', version: '1.0.0' },
    { name: 'amgmcp_query_azure_subscriptions', version: '1.0.0' },
  ],
};

type Handler = () => Promise<ToolCallResult> | ToolCallResult;

class ProbeTransport implements MCPTransport {
  public calls: Array<{ sub: string }> = [];
  constructor(private readonly bySub: Record<string, Handler | Handler[]>) {}
  async listCapabilities(): Promise<CapabilityCatalog> {
    return CATALOG;
  }
  async invoke(capability: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    if (capability !== 'amgmcp_cost_analysis') {
      throw new Error(`unexpected capability: ${capability}`);
    }
    const sub = String(params.subscriptionId);
    this.calls.push({ sub });
    const entry = this.bySub[sub];
    if (!entry) throw new Error(`no handler for ${sub}`);
    if (Array.isArray(entry)) {
      const next = entry.shift();
      if (!next) throw new Error(`exhausted handlers for ${sub}`);
      return await next();
    }
    return await entry();
  }
  async close(): Promise<void> {}
}

async function makeClient(bySub: Record<string, Handler | Handler[]>): Promise<{
  client: MCPClient;
  transport: ProbeTransport;
}> {
  const transport = new ProbeTransport(bySub);
  const client = new MCPClient({ transport });
  await client.discover();
  return { client, transport };
}

function ok(payload: unknown): ToolCallResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function wrappedError(text: string): ToolCallResult {
  // AMG-MCP returns 200-OK with the upstream failure in the text body.
  return { content: [{ type: 'text' as const, text }] };
}

const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';
const SUB_C = '33333333-3333-3333-3333-333333333333';

const RBAC_WRAPPED =
  `An error occurred invoking amgmcp_cost_analysis. Error: err_calling_grafana_api. StatusCode: Unauthorized. ` +
  `Error message: {"error":{"code":"RBACAccessDenied","message":"The client does not have authorization to perform action."}}`;

describe('probeBillingAccess', () => {
  it('classifies a clean payload as pass', async () => {
    const { client } = await makeClient({
      [SUB_A]: () => ok({ subscriptions: [{ subscriptionId: SUB_A, totalCost: 12.34, byService: [] }] }),
    });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(results[0]!.outcome).toBe('pass');
  });

  it('classifies an empty but structurally valid payload as pass', async () => {
    const { client } = await makeClient({
      [SUB_A]: () => ok({ subscriptions: [] }),
    });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(results[0]!.outcome).toBe('pass');
  });

  it('classifies an RBAC-wrapped error as denied with rbac_access_denied tag', async () => {
    const { client } = await makeClient({
      [SUB_A]: () => wrappedError(RBAC_WRAPPED),
    });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(results[0]!.outcome).toBe('denied');
    expect(results[0]!.classification).toBe('rbac_access_denied');
    expect(results[0]!.message ?? '').toContain('RBACAccessDenied');
  });

  it('classifies a thrown HTTP 403 as denied/authz', async () => {
    const { client } = await makeClient({
      [SUB_A]: () => {
        throw new Error('Forbidden: client lacks permission');
      },
    });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(results[0]!.outcome).toBe('denied');
    expect(results[0]!.classification).toBe('authz');
  });

  it('retries once on transient and accepts the retry outcome', async () => {
    let attempts = 0;
    const { client } = await makeClient({
      [SUB_A]: [
        () => {
          attempts++;
          throw new Error('rate limit (429) — please back off');
        },
        () => {
          attempts++;
          return ok({ subscriptions: [{ subscriptionId: SUB_A, totalCost: 1, byService: [] }] });
        },
      ],
    });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(attempts).toBe(2);
    expect(results[0]!.outcome).toBe('pass');
  });

  it('respects per-probe timeout and reports transient/timeout', async () => {
    const { client } = await makeClient({
      [SUB_A]: () => new Promise<ToolCallResult>(() => undefined),
    });
    const { results } = await probeBillingAccess(client, [SUB_A], { timeoutMs: 30 });
    // First attempt times out (transient), then a single retry — which
    // also times out. Final classification is transient/timeout.
    expect(results[0]!.outcome).toBe('transient');
    expect(results[0]!.classification).toBe('timeout');
  }, 15_000);

  it('runs probes concurrently across many subscriptions', async () => {
    const { client, transport } = await makeClient({
      [SUB_A]: () => ok({ subscriptions: [] }),
      [SUB_B]: () => wrappedError(RBAC_WRAPPED),
      [SUB_C]: () => ok({ subscriptions: [] }),
    });
    const { results } = await probeBillingAccess(client, [SUB_A, SUB_B, SUB_C], {
      concurrency: 3,
    });
    expect(results.map((r) => r.outcome)).toEqual(['pass', 'denied', 'pass']);
    expect(transport.calls.length).toBe(3);
  });

  it('reads from cache on hit and skips the underlying call', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-cache-'));
    try {
      const cache = new BillingProbeCache({
        path: join(tmp, 'cache.json'),
        endpoint: 'https://example.grafana.test',
      });
      const { client, transport } = await makeClient({
        [SUB_A]: () => ok({ subscriptions: [] }),
      });
      const first = await probeBillingAccess(client, [SUB_A], { cache });
      expect(first.results[0]!.outcome).toBe('pass');
      expect(first.stats.cache_misses).toBe(1);

      const second = await probeBillingAccess(client, [SUB_A], { cache });
      expect(second.results[0]!.outcome).toBe('pass');
      expect(second.results[0]!.cache_hit).toBe(true);
      expect(second.stats.cache_hits).toBe(1);
      // First run made a call; second run was a cache hit only.
      expect(transport.calls.length).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('classifies payload-embedded RBACAccessDenied wrap as denied', async () => {
    const wrap =
      'Failed to query cost analysis for subscription ' +
      `'${SUB_A}'. Error: err_calling_grafana_api. StatusCode: Unauthorized. ` +
      'Error message: {"error":{"code":"RBACAccessDenied","message":"forbidden"}}';
    const { client } = await makeClient({ [SUB_A]: () => wrappedError(wrap) });
    const { results } = await probeBillingAccess(client, [SUB_A]);
    expect(results[0]!.outcome).toBe('denied');
  });
});
