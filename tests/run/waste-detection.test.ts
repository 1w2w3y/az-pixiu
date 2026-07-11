import { describe, it, expect } from 'vitest';

import { WasteDetectionExecutor } from '../../src/run/waste-detection.js';
import { orphanPublicIpLane } from '../../src/playbooks/waste-lanes/orphan-public-ip.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MCPClient } from '../../src/mcp/client.js';
import { JsonFileRateSource } from '../../src/pricing/json-file-rate-source.js';
import type { CapabilityCatalog, Scope, ToolCallResult } from '../../src/schemas/index.js';
import type { MCPTransport } from '../../src/mcp/transport.js';

const wasteScope: Scope = {
  subscription_ids: [
    '77777777-7777-7777-7777-777777777777',
    '88888888-8888-8888-8888-888888888888',
  ],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: 'two subs',
};

describe('WasteDetectionExecutor — orphan-public-ip lane against the seeded fixture', () => {
  it('surfaces 5 orphan public IPs and emits one EvidenceRecord per candidate', async () => {
    const transport = new FixtureMCPTransport({ fixturePath: 'fixtures/waste-orphan-ip' });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });

    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });
    const result = await executor.execute({ scope: wasteScope });

    expect(result.lanes).toHaveLength(1);
    const lane = result.lanes[0]!;
    expect(lane.lane).toBe('orphan_public_ip');
    expect(lane.failed).toBe(false);
    expect(lane.candidates).toHaveLength(5);
    expect(lane.unparsed_row_count).toBe(0);
    expect(lane.rejected_row_count).toBe(0);
    expect(result.failures).toHaveLength(0);

    // Every candidate becomes its own EvidenceRecord; the executor
    // is the only source of waste_candidate evidence, so the count
    // matches the candidate count exactly.
    expect(result.evidence).toHaveLength(5);
    for (const ev of result.evidence) {
      expect(ev.query_intent).toBe('waste_candidate');
      expect(ev.source_capability).toBe('az_pixiu_waste_lane');
      // The cited predicate must live on the evidence record's payload
      // so a reasoner downstream can defend the classification.
      const payload = (ev.payload_ref.kind === 'inline'
        ? ev.payload_ref.data
        : undefined) as { classification_predicate?: string };
      expect(payload?.classification_predicate).toBe(orphanPublicIpLane.predicate_text);
    }
  });

  it('attaches a calibrated impact range for the Standard/Static IPs and "rate unavailable" for the Basic/Dynamic IP', async () => {
    const transport = new FixtureMCPTransport({ fixturePath: 'fixtures/waste-orphan-ip' });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });

    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });
    const result = await executor.execute({ scope: wasteScope });
    const lane = result.lanes[0]!;

    const standardCandidates = lane.candidates.filter(
      (c) => c.candidate.sku === 'PublicIPAddress_Standard_Static',
    );
    const basicCandidate = lane.candidates.find(
      (c) => c.candidate.sku === 'PublicIPAddress_Basic_Dynamic',
    );

    expect(standardCandidates).toHaveLength(4);
    expect(basicCandidate).toBeDefined();

    for (const c of standardCandidates) {
      expect(c.estimated_weekly_impact.kind).toBe('available');
      if (c.estimated_weekly_impact.kind === 'available') {
        expect(c.estimated_weekly_impact.low_usd).toBeGreaterThan(0);
        expect(c.estimated_weekly_impact.high_usd).toBeGreaterThan(c.estimated_weekly_impact.low_usd);
        expect(c.estimated_weekly_impact.source_url).toContain('azure.microsoft.com');
      }
    }
    expect(basicCandidate!.estimated_weekly_impact.kind).toBe('unavailable');

    // Lane total includes the four available estimates; the unavailable
    // candidate is counted separately so the total never silently
    // overstates coverage.
    expect(lane.lane_total.available_count).toBe(4);
    expect(lane.lane_total.unavailable_count).toBe(1);
    expect(lane.lane_total.unavailable_skus.map((s) => s.sku)).toContain(
      'PublicIPAddress_Basic_Dynamic',
    );
    expect(lane.rate_source_captured_at).toBe('2026-05-23');
  });

  it('records the wire-level ARG call in transport_summary so per-attempt observability survives', async () => {
    const transport = new FixtureMCPTransport({ fixturePath: 'fixtures/waste-orphan-ip' });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });

    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });
    const result = await executor.execute({ scope: wasteScope });

    expect(result.transport_summary).toHaveLength(1);
    const entry = result.transport_summary[0]!;
    expect(entry.capability).toBe('amgmcp_query_resource_graph');
    expect(entry.final_outcome).toBe('success');
    expect(entry.scope_subset?.subscription_ids).toEqual(wasteScope.subscription_ids);
  });

  it('propagates ToolCallResult.isError through the executor as a failed lane', async () => {
    const transport = new SingleArgTransport({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ data: [], count: 0 }) }],
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, totalBudgetMs: 1_000, paceAfterRateLimitMs: 0 },
    });

    const result = await executor.execute({ scope: wasteScope });

    expect(result.lanes).toEqual([
      expect.objectContaining({
        lane: 'orphan_public_ip',
        failed: true,
        candidates: [],
      }),
    ]);
    expect(result.evidence).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.transport_summary).toHaveLength(1);
    expect(result.transport_summary[0]?.final_outcome).not.toBe('success');
  });

  it('rejects out-of-scope and ARM-mismatched rows, emits schema_mismatch, and keeps valid evidence', async () => {
    const inScope = wasteScope.subscription_ids[0]!;
    const otherInScope = wasteScope.subscription_ids[1]!;
    const outOfScope = '99999999-9999-9999-9999-999999999999';
    const payload = {
      data: [
        {
          id: `/subscriptions/${inScope}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-valid`,
          name: 'pip-valid',
          subscriptionId: inScope,
          resourceGroup: 'rg',
          location: 'eastus',
          skuName: 'Standard',
          allocationMethod: 'Static',
          ipConfigurationId: '',
          natGatewayId: '',
        },
        {
          id: `/subscriptions/${outOfScope}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-leak`,
          name: 'pip-leak',
          subscriptionId: outOfScope,
          resourceGroup: 'rg',
          location: 'eastus',
          skuName: 'Standard',
          allocationMethod: 'Static',
          ipConfigurationId: '',
          natGatewayId: '',
        },
        {
          id: `/subscriptions/${otherInScope}/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-mismatch`,
          name: 'pip-mismatch',
          subscriptionId: inScope,
          resourceGroup: 'rg',
          location: 'eastus',
          skuName: 'Standard',
          allocationMethod: 'Static',
          ipConfigurationId: '',
          natGatewayId: '',
        },
        {
          id: `/subscriptions/${inScope}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/not-a-pip`,
          name: 'not-a-pip',
          subscriptionId: inScope,
          resourceGroup: 'rg',
          location: 'eastus',
          skuName: 'Standard',
          allocationMethod: 'Static',
          ipConfigurationId: '',
          natGatewayId: '',
        },
        'not-an-object-row',
      ],
      count: 5,
    };
    const transport = new SingleArgTransport({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });

    const result = await executor.execute({ scope: wasteScope });
    const lane = result.lanes[0]!;
    expect(lane.candidates.map((c) => c.candidate.name)).toEqual(['pip-valid']);
    expect(lane.unparsed_row_count).toBe(1);
    expect(lane.rejected_row_count).toBe(3);
    expect(result.evidence).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        category: 'schema_mismatch',
        capability: 'amgmcp_query_resource_graph',
      }),
    ]);
    expect(transport.lastParameters).not.toHaveProperty('subscription_ids');
    expect(String(transport.lastParameters?.query)).toContain('where subscriptionId in~');
    expect(result.transport_summary[0]?.scope_subset?.subscription_ids).toEqual(
      wasteScope.subscription_ids,
    );
  });

  it('treats an empty resource-group list as no filter instead of rejecting every row', async () => {
    const sub = wasteScope.subscription_ids[0]!;
    const transport = new SingleArgTransport({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: [
              {
                id: `/subscriptions/${sub}/resourceGroups/rg-any/providers/Microsoft.Network/publicIPAddresses/pip-valid`,
                name: 'pip-valid',
                subscriptionId: sub,
                resourceGroup: 'rg-any',
                location: 'eastus',
                skuName: 'Standard',
                allocationMethod: 'Static',
                ipConfigurationId: '',
                natGatewayId: '',
              },
            ],
            count: 1,
          }),
        },
      ],
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });

    const result = await executor.execute({
      scope: { ...wasteScope, resource_group_names: [] },
    });
    expect(result.lanes[0]?.candidates.map((candidate) => candidate.candidate.name)).toEqual([
      'pip-valid',
    ]);
    expect(result.lanes[0]?.rejected_row_count).toBe(0);
    expect(result.transport_summary[0]?.scope_subset?.resource_group_names).toBeNull();
  });

  it('normalizes whitespace and enforces the effective resource-type filter on returned ARM ids', async () => {
    const sub = wasteScope.subscription_ids[0]!;
    const transport = new SingleArgTransport({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: [
              {
                id: `/subscriptions/${sub}/resourceGroups/rg-any/providers/Microsoft.Network/publicIPAddresses/pip-filtered`,
                name: 'pip-filtered',
                subscriptionId: ` ${sub} `,
                resourceGroup: 'rg-any',
                location: 'eastus',
                skuName: 'Standard',
                allocationMethod: 'Static',
                ipConfigurationId: '',
                natGatewayId: '',
              },
            ],
            count: 1,
          }),
        },
      ],
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const rateSource = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
    const executor = new WasteDetectionExecutor({
      client,
      catalog,
      rateSource,
      lanes: [orphanPublicIpLane],
    });

    const result = await executor.execute({
      scope: {
        ...wasteScope,
        resource_group_names: ['  rg-any  '],
        resource_type_filter: ['  Microsoft.Compute/virtualMachines  '],
      },
    });
    expect(result.lanes[0]?.candidates).toHaveLength(0);
    expect(result.lanes[0]?.rejected_row_count).toBe(1);
    expect(String(transport.lastParameters?.query)).toContain(
      "where resourceGroup in~ ('rg-any')",
    );
    expect(String(transport.lastParameters?.query)).toContain(
      "where type in~ ('Microsoft.Compute/virtualMachines')",
    );
    expect(result.transport_summary[0]?.scope_subset?.resource_group_names).toEqual(['rg-any']);
  });
});

class SingleArgTransport implements MCPTransport {
  lastParameters: Record<string, unknown> | undefined;

  constructor(private readonly result: ToolCallResult) {}

  async listCapabilities(): Promise<CapabilityCatalog> {
    return {
      capabilities: [
        {
          name: 'amgmcp_query_resource_graph',
          version: '1.0.0',
          description: 'ARG test transport',
        },
      ],
    };
  }

  async invoke(
    _capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    this.lastParameters = parameters;
    return this.result;
  }

  async close(): Promise<void> {}
}
