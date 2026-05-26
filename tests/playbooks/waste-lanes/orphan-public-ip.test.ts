import { describe, it, expect } from 'vitest';
import { orphanPublicIpLane, formatPublicIpSku } from '../../../src/playbooks/waste-lanes/orphan-public-ip.js';
import type { Scope, ToolCallResult } from '../../../src/schemas/index.js';
import type { PricingRateSource } from '../../../src/pricing/source.js';

const scope: Scope = {
  subscription_ids: [
    '77777777-7777-7777-7777-777777777777',
    '88888888-8888-8888-8888-888888888888',
  ],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: 'two subs',
};

const stubRateSource: PricingRateSource = {
  lookup: () => undefined,
  capturedAt: () => '2026-05-23',
};

describe('formatPublicIpSku', () => {
  it('joins skuName and allocationMethod under a stable prefix', () => {
    expect(formatPublicIpSku('Standard', 'Static')).toBe('PublicIPAddress_Standard_Static');
    expect(formatPublicIpSku('Basic', 'Dynamic')).toBe('PublicIPAddress_Basic_Dynamic');
  });

  it("uses 'Unknown' segment when a field is empty so the rate lookup still misses cleanly", () => {
    expect(formatPublicIpSku('', '')).toBe('PublicIPAddress_Unknown_Unknown');
    expect(formatPublicIpSku('Standard', '')).toBe('PublicIPAddress_Standard_Unknown');
  });
});

describe('orphanPublicIpLane.buildRequest', () => {
  it('targets amgmcp_query_resource_graph with the in-scope subscription set', () => {
    const req = orphanPublicIpLane.buildRequest({ scope, rateSource: stubRateSource });
    expect(req.capability).toBe('amgmcp_query_resource_graph');
    expect(req.intent).toBe('waste_candidate');
    expect(req.parameters.subscription_ids).toEqual(scope.subscription_ids);
  });

  it('emits an ARG query whose where-clause cites the classification predicate verbatim', () => {
    const req = orphanPublicIpLane.buildRequest({ scope, rateSource: stubRateSource });
    const query = req.parameters.query as string;
    expect(query).toContain("type =~ 'microsoft.network/publicipaddresses'");
    expect(query).toContain('isnull(properties.ipConfiguration)');
    // The lane's published predicate_text must be a substring of the
    // executed query so the report's "classification predicate" cite
    // is honest about what ran.
    expect(query).toContain(orphanPublicIpLane.predicate_text);
  });

  it('does NOT include microsoft.network/publicipprefixes in scope', () => {
    // Both prior agents flagged this — the design table only names
    // publicipaddresses, and broadening to publicipprefixes would
    // silently change what "orphan" means. Hard-test the boundary.
    const req = orphanPublicIpLane.buildRequest({ scope, rateSource: stubRateSource });
    expect(req.parameters.query).not.toContain('publicipprefixes');
  });
});

describe('orphanPublicIpLane.parseRows', () => {
  function makeResult(content: unknown): ToolCallResult {
    return { content } as ToolCallResult;
  }

  it('maps each ARG row to a WasteCandidate with the SKU joined from skuName + allocationMethod', () => {
    const result = makeResult({
      data: [
        {
          id: '/subscriptions/aaa/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip-1',
          name: 'pip-1',
          subscriptionId: 'aaa',
          resourceGroup: 'rg',
          location: 'eastus',
          skuName: 'Standard',
          allocationMethod: 'Static',
        },
      ],
    });
    const { candidates, unparsed_row_count } = orphanPublicIpLane.parseRows(result);
    expect(unparsed_row_count).toBe(0);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c.resource_id).toContain('pip-1');
    expect(c.sku).toBe('PublicIPAddress_Standard_Static');
    expect(c.fields).toEqual({ skuName: 'Standard', allocationMethod: 'Static' });
  });

  it('counts rows missing the load-bearing fields (id, subscriptionId) as unparsed instead of fabricating candidates', () => {
    const result = makeResult({
      data: [
        // Missing id — must not surface a candidate that cannot be cited.
        { name: 'pip-noid', subscriptionId: 'aaa', location: 'eastus', skuName: 'Standard', allocationMethod: 'Static' },
        // Missing subscriptionId — must not surface either.
        { id: '/x/pip-nosub', subscriptionId: '', location: 'eastus' },
      ],
    });
    const { candidates, unparsed_row_count } = orphanPublicIpLane.parseRows(result);
    expect(candidates).toHaveLength(0);
    expect(unparsed_row_count).toBe(2);
  });

  it('returns no candidates when the response is empty (lane ran cleanly, no orphans in scope)', () => {
    const { candidates, unparsed_row_count } = orphanPublicIpLane.parseRows(makeResult({ data: [], count: 0 }));
    expect(candidates).toHaveLength(0);
    expect(unparsed_row_count).toBe(0);
  });

  it('tolerates the bare-array shape (in case AMG-MCP changes its envelope)', () => {
    const result = makeResult([
      {
        id: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/pip',
        name: 'pip',
        subscriptionId: 'x',
        resourceGroup: 'rg',
        location: 'westus2',
        skuName: 'Standard',
        allocationMethod: 'Static',
      },
    ]);
    const { candidates } = orphanPublicIpLane.parseRows(result);
    expect(candidates).toHaveLength(1);
  });
});
