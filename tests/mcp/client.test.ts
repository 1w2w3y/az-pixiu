import { describe, it, expect } from 'vitest';
import {
  MCPClient,
  assertRequiredCapabilities,
  CapabilityNotAllowedError,
  RequiredCapabilityMissingError,
  DiscoveryNotPerformedError,
} from '../../src/mcp/client.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type { CapabilityCatalog, ToolCallResult } from '../../src/schemas/index.js';

class FakeMCPTransport implements MCPTransport {
  public closeCalled = 0;
  public invokes: Array<{ capability: string; parameters: Record<string, unknown> }> = [];

  constructor(
    private readonly catalog: CapabilityCatalog,
    private readonly invokeImpl?: (
      cap: string,
      params: Record<string, unknown>,
    ) => Promise<ToolCallResult>,
  ) {}

  async listCapabilities(): Promise<CapabilityCatalog> {
    return this.catalog;
  }

  async invoke(
    capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    this.invokes.push({ capability, parameters });
    if (this.invokeImpl) return this.invokeImpl(capability, parameters);
    return { content: { ok: true } };
  }

  async close(): Promise<void> {
    this.closeCalled += 1;
  }
}

const phase1Catalog: CapabilityCatalog = {
  capabilities: [
    { name: 'amgmcp_query_azure_subscriptions', version: '1.0.0' },
    { name: 'amgmcp_cost_analysis', version: '1.0.0' },
    { name: 'amgmcp_query_resource_graph', version: '1.2.0' },
    { name: 'amgmcp_query_resource_metric_definition', version: '1.0.0' },
    { name: 'amgmcp_query_resource_metric', version: '1.0.0' },
    { name: 'amgmcp_query_activity_log', version: '1.0.0' },
    { name: 'amgmcp_query_resource_health', version: '1.0.0' },
  ],
};

describe('MCPClient.discover', () => {
  it('returns the seven Phase 1 capabilities as allowed when AMG-MCP advertises them', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    const catalog = await client.discover();
    expect(catalog.allowed.map((c) => c.name).sort()).toEqual([
      'amgmcp_cost_analysis',
      'amgmcp_query_activity_log',
      'amgmcp_query_azure_subscriptions',
      'amgmcp_query_resource_graph',
      'amgmcp_query_resource_health',
      'amgmcp_query_resource_metric',
      'amgmcp_query_resource_metric_definition',
    ]);
  });

  it('collects capability_versions for RunMetadata (§5.7)', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    const catalog = await client.discover();
    expect(catalog.capability_versions).toEqual({
      amgmcp_query_azure_subscriptions: '1.0.0',
      amgmcp_cost_analysis: '1.0.0',
      amgmcp_query_resource_graph: '1.2.0',
      amgmcp_query_resource_metric_definition: '1.0.0',
      amgmcp_query_resource_metric: '1.0.0',
      amgmcp_query_activity_log: '1.0.0',
      amgmcp_query_resource_health: '1.0.0',
    });
  });

  it('separates mutating-name capabilities into mutating_denied (§14 trace event hook)', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: [
        ...phase1Catalog.capabilities,
        { name: 'dashboard_update' },
        { name: 'create_alert_rule' },
      ],
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const discovered = await client.discover();
    const mutatingNames = discovered.mutating_denied.map((c) => c.name).sort();
    expect(mutatingNames).toEqual(['create_alert_rule', 'dashboard_update']);
    expect(discovered.allowed.map((c) => c.name)).not.toContain('dashboard_update');
    expect(discovered.allowed.map((c) => c.name)).not.toContain('create_alert_rule');
    // mutating_denied is a subset of denied
    for (const name of mutatingNames) {
      expect(discovered.denied.map((c) => c.name)).toContain(name);
    }
  });

  it('places not-in-allowlist read capabilities into denied but not mutating_denied', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: [
        ...phase1Catalog.capabilities,
        { name: 'amgmcp_kusto_query' }, // read-only, but Phase 2 (§15.4)
        { name: 'amgmcp_pulse_check' },
      ],
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const d = await client.discover();
    expect(d.denied.map((c) => c.name).sort()).toEqual(['amgmcp_kusto_query', 'amgmcp_pulse_check']);
    expect(d.mutating_denied).toHaveLength(0);
  });

  it('caches the catalog — second call returns the same object', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    const a = await client.discover();
    const b = await client.discover();
    expect(b).toBe(a);
  });

  it('skips capabilities that lack a version when building capability_versions', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: [
        { name: 'amgmcp_cost_analysis' }, // no version
        { name: 'amgmcp_query_resource_graph', version: '1.0.0' },
      ],
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const d = await client.discover();
    expect(d.capability_versions).toEqual({ amgmcp_query_resource_graph: '1.0.0' });
  });
});

describe('MCPClient.invoke', () => {
  it('delegates to the transport for an allowed, advertised capability', async () => {
    const transport = new FakeMCPTransport(phase1Catalog);
    const client = new MCPClient({ transport });
    await client.discover();
    await client.invoke('amgmcp_cost_analysis', { granularity: 'Daily' });
    expect(transport.invokes).toHaveLength(1);
    expect(transport.invokes[0]?.capability).toBe('amgmcp_cost_analysis');
  });

  it('throws DiscoveryNotPerformedError when invoke is called before discover', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    await expect(client.invoke('amgmcp_cost_analysis', {})).rejects.toBeInstanceOf(
      DiscoveryNotPerformedError,
    );
  });

  it('throws CapabilityNotAllowedError when capability is not in the allowlist', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    await client.discover();
    await expect(client.invoke('amgmcp_kusto_query', {})).rejects.toBeInstanceOf(
      CapabilityNotAllowedError,
    );
  });

  it('throws CapabilityNotAllowedError when capability is mutating (defense in depth)', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    await client.discover();
    await expect(client.invoke('dashboard_update', {})).rejects.toBeInstanceOf(
      CapabilityNotAllowedError,
    );
  });

  it('throws CapabilityNotAllowedError when allowed by static set but not advertised by AMG-MCP', async () => {
    // AMG-MCP advertises only 1 of the 7 — invoking another should fail
    const sparseCatalog: CapabilityCatalog = {
      capabilities: [{ name: 'amgmcp_cost_analysis', version: '1.0.0' }],
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(sparseCatalog) });
    await client.discover();
    await expect(client.invoke('amgmcp_query_resource_metric', {})).rejects.toBeInstanceOf(
      CapabilityNotAllowedError,
    );
  });

  it('CapabilityNotAllowedError exposes the offending capability and reason', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    await client.discover();
    try {
      await client.invoke('amgmcp_kusto_query', {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotAllowedError);
      const e = err as CapabilityNotAllowedError;
      expect(e.capability).toBe('amgmcp_kusto_query');
      expect(e.reason).toMatch(/allowlist/);
    }
  });
});

describe('MCPClient.close', () => {
  it('delegates to the transport', async () => {
    const transport = new FakeMCPTransport(phase1Catalog);
    const client = new MCPClient({ transport });
    await client.close();
    expect(transport.closeCalled).toBe(1);
  });
});

describe('assertRequiredCapabilities', () => {
  it('passes when all required capabilities for cost_surprise are present', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    const d = await client.discover();
    expect(() => assertRequiredCapabilities(d, 'cost_surprise')).not.toThrow();
  });

  it('throws when amgmcp_cost_analysis is missing (the central signal)', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: phase1Catalog.capabilities.filter((c) => c.name !== 'amgmcp_cost_analysis'),
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const d = await client.discover();
    expect(() => assertRequiredCapabilities(d, 'cost_surprise')).toThrow(
      RequiredCapabilityMissingError,
    );
  });

  it('passes when only optional capabilities are missing (degradable per §11)', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: phase1Catalog.capabilities.filter(
        (c) => !['amgmcp_query_resource_health', 'amgmcp_query_activity_log'].includes(c.name),
      ),
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const d = await client.discover();
    expect(() => assertRequiredCapabilities(d, 'cost_surprise')).not.toThrow();
  });

  it('lists all missing required capabilities in the error', async () => {
    const catalog: CapabilityCatalog = {
      capabilities: phase1Catalog.capabilities.filter(
        (c) => !['amgmcp_cost_analysis', 'amgmcp_query_resource_graph'].includes(c.name),
      ),
    };
    const client = new MCPClient({ transport: new FakeMCPTransport(catalog) });
    const d = await client.discover();
    try {
      assertRequiredCapabilities(d, 'cost_surprise');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RequiredCapabilityMissingError);
      const e = err as RequiredCapabilityMissingError;
      expect(e.missing).toContain('amgmcp_cost_analysis');
      expect(e.missing).toContain('amgmcp_query_resource_graph');
      expect(e.analysisType).toBe('cost_surprise');
    }
  });

  it('throws when called for a Phase 2 analysis type (no map)', async () => {
    const client = new MCPClient({ transport: new FakeMCPTransport(phase1Catalog) });
    const d = await client.discover();
    expect(() => assertRequiredCapabilities(d, 'idle_underused')).toThrow(
      /Phase 1 supports cost_surprise/,
    );
  });
});

describe('MCPClient + seeded fixture integration', () => {
  it('discovers exactly the seven Phase 1 capabilities from the seeded fixture', async () => {
    // Import lazily so the fixture path is the repo's real fixture file
    const { FixtureMCPTransport } = await import('../../src/mcp/fixture.js');
    const client = new MCPClient({
      transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
    });
    const d = await client.discover();
    expect(d.allowed).toHaveLength(7);
    expect(() => assertRequiredCapabilities(d, 'cost_surprise')).not.toThrow();
  });

  it('invoke against the seeded fixture round-trips a amgmcp_cost_analysis response', async () => {
    const { FixtureMCPTransport } = await import('../../src/mcp/fixture.js');
    const client = new MCPClient({
      transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
    });
    await client.discover();
    const result = await client.invoke('amgmcp_cost_analysis', {
      subscription_id: '11111111-1111-1111-1111-111111111111',
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      granularity: 'Daily',
      grouping: ['ServiceName'],
    });
    expect(result.isError).toBe(false);
    const content = result.content as { total: { cost: number } };
    expect(content.total.cost).toBeGreaterThan(0);
  });
});
