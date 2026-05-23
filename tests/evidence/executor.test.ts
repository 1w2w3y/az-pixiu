import { describe, it, expect } from 'vitest';
import { EvidenceExecutor } from '../../src/evidence/executor.js';
import { MCPClient, type DiscoveredCatalog } from '../../src/mcp/client.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type {
  CapabilityCatalog,
  EvidencePlan,
  ToolCallResult,
} from '../../src/schemas/index.js';

class FakeTransport implements MCPTransport {
  constructor(
    private readonly catalog: CapabilityCatalog,
    private readonly invokeImpl: (cap: string, params: Record<string, unknown>) => Promise<ToolCallResult>,
  ) {}
  async listCapabilities() {
    return this.catalog;
  }
  async invoke(cap: string, params: Record<string, unknown>) {
    return this.invokeImpl(cap, params);
  }
  async close() {}
}

const phase1Catalog: CapabilityCatalog = {
  capabilities: [
    { name: 'amgmcp_cost_analysis', version: '1.0.0' },
    { name: 'amgmcp_query_resource_graph', version: '1.2.0' },
  ],
};

const fixedNow = () => new Date('2026-05-18T12:00:00Z');

describe('EvidenceExecutor — happy path', () => {
  it('runs every request and collects raw_evidence with provenance', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => ({
      content: { capability: cap, ok: true },
      isError: false,
    }));
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog, now: fixedNow });

    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { sub: 'a' }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_query_resource_graph', parameters: { q: 'select *' }, intent: 'inventory' },
      ],
    };

    const { raw_evidence, failures, transport_summary } = await executor.execute(plan);
    expect(failures).toHaveLength(0);
    expect(raw_evidence).toHaveLength(2);
    expect(raw_evidence[0]?.capability_version).toBe('1.0.0');
    expect(raw_evidence[1]?.capability_version).toBe('1.2.0');
    expect(raw_evidence[0]?.parameters_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(raw_evidence[0]?.retrieved_at).toBe('2026-05-18T12:00:00.000Z');
    // Phase 3 §S4: one transport summary row per logical request,
    // single-attempt for PR 1.
    expect(transport_summary).toHaveLength(2);
    expect(transport_summary[0]).toMatchObject({
      logical_request_id: 'req-1',
      capability: 'amgmcp_cost_analysis',
      attempt_count: 1,
      retry_count: 0,
      final_outcome: 'success',
      cumulative_backoff_ms: 0,
    });
    expect(transport_summary[0]?.parameters_digest).toBe(raw_evidence[0]?.parameters_digest);
  });

  it('preserves the request order in raw_evidence', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => ({ content: cap }));
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });
    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_query_resource_graph', parameters: { i: 1 }, intent: 'inventory' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 2 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_query_resource_graph', parameters: { i: 3 }, intent: 'inventory' },
      ],
    };
    const { raw_evidence } = await executor.execute(plan);
    expect(raw_evidence.map((e) => e.request.capability)).toEqual([
      'amgmcp_query_resource_graph',
      'amgmcp_cost_analysis',
      'amgmcp_query_resource_graph',
    ]);
  });

  it('captures the per-call subscription scope on transport_summary entries', async () => {
    const transport = new FakeTransport(phase1Catalog, async () => ({ content: 'ok' }));
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });
    const subId = '11111111-1111-1111-1111-111111111111';
    const plan: EvidencePlan = {
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: { subscription_id: subId, time_window: {} },
          intent: 'cost_breakdown',
        },
        {
          capability: 'amgmcp_query_resource_graph',
          parameters: { query: 'select *' },
          intent: 'inventory',
        },
      ],
    };
    const { transport_summary } = await executor.execute(plan);
    expect(transport_summary[0]?.scope_subset?.subscription_ids).toEqual([subId]);
    expect(transport_summary[1]?.scope_subset).toBeNull();
  });

  it('falls back to "unknown" capability_version when discovery did not record one', async () => {
    const catalog: CapabilityCatalog = { capabilities: [{ name: 'amgmcp_cost_analysis' }] };
    const transport = new FakeTransport(catalog, async () => ({ content: {} }));
    const client = new MCPClient({ transport });
    const discovered = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog: discovered });
    const { raw_evidence } = await executor.execute({
      requests: [{ capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' }],
    });
    expect(raw_evidence[0]?.capability_version).toBe('unknown');
  });
});

describe('EvidenceExecutor — failure paths', () => {
  it('collects per-request failures as ClassifiedFailures (does not throw)', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap === 'amgmcp_cost_analysis') throw Object.assign(new Error('quota'), { status: 429 });
      return { content: 'ok' };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });

    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
        { capability: 'amgmcp_query_resource_graph', parameters: {}, intent: 'inventory' },
      ],
    };

    const { raw_evidence, failures, transport_summary } = await executor.execute(plan);
    expect(raw_evidence).toHaveLength(1);
    expect(raw_evidence[0]?.request.capability).toBe('amgmcp_query_resource_graph');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe('rate_limit');
    expect(failures[0]?.capability).toBe('amgmcp_cost_analysis');
    expect(transport_summary).toHaveLength(2);
    expect(transport_summary[0]?.final_outcome).toBe('rate_limit');
    expect(transport_summary[0]?.failure_category).toBe('rate_limit');
    expect(transport_summary[1]?.final_outcome).toBe('success');
  });

  it('continues after multiple failures so analysis can produce bounded results (§11)', async () => {
    const transport = new FakeTransport(phase1Catalog, async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });

    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
        { capability: 'amgmcp_query_resource_graph', parameters: {}, intent: 'inventory' },
      ],
    };
    const { raw_evidence, failures, transport_summary } = await executor.execute(plan);
    expect(raw_evidence).toHaveLength(0);
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.category === 'authz_gap')).toBe(true);
    expect(transport_summary).toHaveLength(2);
    expect(transport_summary.every((s) => s.final_outcome === 'other')).toBe(true);
    expect(transport_summary.every((s) => s.failure_category === 'authz_gap')).toBe(true);
  });
});

describe('EvidenceExecutor — against the seeded fixture', () => {
  it('returns raw evidence for the seeded cost-surprise plan', async () => {
    const client = new MCPClient({
      transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
    });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });

    const plan: EvidencePlan = {
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: {
            subscription_id: '11111111-1111-1111-1111-111111111111',
            time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
            granularity: 'Daily',
            grouping: ['ServiceName'],
          },
          intent: 'cost_breakdown',
        },
        {
          capability: 'amgmcp_cost_analysis',
          parameters: {
            subscription_id: '11111111-1111-1111-1111-111111111111',
            time_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
            granularity: 'Daily',
            grouping: ['ServiceName'],
          },
          intent: 'cost_breakdown',
        },
      ],
    };

    const { raw_evidence, failures } = await executor.execute(plan);
    expect(failures).toHaveLength(0);
    expect(raw_evidence).toHaveLength(2);
    expect(raw_evidence[0]?.capability_version).toBe('1.0.0');
  });

  it('produces a classified failure for an unrecorded parameter combination', async () => {
    const client = new MCPClient({
      transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
    });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({ client, catalog });
    const { raw_evidence, failures } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { unrecorded: true }, intent: 'cost_breakdown' },
      ],
    });
    expect(raw_evidence).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe('unsupported_capability');
  });
});
