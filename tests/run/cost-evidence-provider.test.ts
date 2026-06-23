import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostEvidenceProvider, summarizeCostPayload } from '../../src/run/cost-evidence-provider.js';
import { FileBillingCacheStore } from '../../src/billing-cache/index.js';
import { parameterDigest } from '../../src/mcp/digest.js';
import type { RawEvidence } from '../../src/evidence/executor.js';
import type { EvidencePlan, EvidenceRequest, Scope } from '../../src/schemas/index.js';

const ENDPOINT = 'https://example.grafana.azure.com';
const SUB = '11111111-1111-1111-1111-111111111111';
// "Today" for the maturity gate: 2026-06-22. April 2026 is finalized
// (well past 2026-05-06); June 2026 is not.
const NOW = () => Date.parse('2026-06-22T00:00:00Z');

function costRequest(window: { start: string; end: string }, sub = SUB): EvidenceRequest {
  return {
    capability: 'amgmcp_cost_analysis',
    parameters: {
      subscription_id: sub,
      time_window: window,
      granularity: 'Daily',
      grouping: ['ServiceName'],
    },
    intent: 'cost_breakdown',
  };
}

const NON_COST_REQUEST: EvidenceRequest = {
  capability: 'amgmcp_query_resource_graph',
  parameters: { subscription_ids: [SUB] },
  intent: 'inventory',
};

function tabularResult() {
  return {
    content: {
      columns: [
        { name: 'UsageDate', type: 'string' },
        { name: 'ServiceName', type: 'string' },
        { name: 'Cost', type: 'decimal' },
        { name: 'Currency', type: 'string' },
      ],
      rows: [
        ['2026-04-01', 'App Service', 100, 'USD'],
        ['2026-04-02', 'Storage', 50, 'USD'],
      ],
      total: { cost: 150, currency: 'USD' },
    },
    isError: false,
  };
}

function rawFor(window: { start: string; end: string }, sub = SUB): RawEvidence {
  const request = costRequest(window, sub);
  return {
    request,
    parameters_digest: parameterDigest(request.parameters),
    capability_version: '1.0.0',
    result: tabularResult(),
    retrieved_at: '2026-06-22T08:00:00.000Z',
  };
}

const APRIL = { start: '2026-04-01T00:00:00Z', end: '2026-05-01T00:00:00Z' };
const APRIL_7DAY = { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' };
const JUNE = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

function scopeFor(window: { start: string; end: string }): Scope {
  return {
    analysis_type: 'cost_summary',
    subscription_ids: [SUB],
    time_window: window,
    resource_group_names: null,
  } as unknown as Scope;
}

async function withProvider(
  window: { start: string; end: string },
  fn: (provider: CostEvidenceProvider, store: FileBillingCacheStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'azp-provider-'));
  try {
    const store = new FileBillingCacheStore({ root, endpoint: ENDPOINT, now: NOW });
    const provider = new CostEvidenceProvider({
      store,
      scope: scopeFor(window),
      costView: 'amortized',
      now: NOW,
    });
    await fn(provider, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('CostEvidenceProvider', () => {
  it('misses before write-through, leaving the plan untouched', async () => {
    await withProvider(APRIL, async (provider) => {
      const plan: EvidencePlan = { requests: [costRequest(APRIL), NON_COST_REQUEST] };
      const served = await provider.serveFromCache(plan);
      expect(served.hitCount).toBe(0);
      expect(served.remainingPlan.requests).toEqual(plan.requests);
      expect(served.servedRecords).toHaveLength(0);
    });
  });

  it('write-through then serves a finalized month from cache with zero live cost calls', async () => {
    await withProvider(APRIL, async (provider, store) => {
      // 1. Warm via write-through (simulating a prior live retrieval).
      expect(await provider.writeThrough([rawFor(APRIL)])).toBe(1);

      // The on-disk cell carries the audit summary and the replay payload.
      const cells = await store.list();
      expect(cells).toHaveLength(1);
      expect(cells[0]?.month).toBe('2026-04');

      // 2. Serve: the cost request leaves the live plan; the non-cost stays.
      const plan: EvidencePlan = { requests: [costRequest(APRIL), NON_COST_REQUEST] };
      const served = await provider.serveFromCache(plan);

      expect(served.hitCount).toBe(1);
      expect(served.remainingPlan.requests).toEqual([NON_COST_REQUEST]);
      expect(served.servedRecords).toHaveLength(1);

      const record = served.servedRecords[0]!;
      expect(record.source_capability).toBe('az_pixiu_billing_cache');
      expect(record.capability_version).toBe('billing-cache-v1');
      expect(record.scope_subset.subscription_ids).toEqual([SUB]);
      // Replayed faithfully through the normalizer (total cost preserved).
      expect((record.payload_summary as { total_cost?: number }).total_cost).toBe(150);
      expect(record.caveats.some((c) => c.includes('local billing cache'))).toBe(true);

      // A cache-served transport entry exists so coverage/run-outcome see a
      // cost substrate even though no wire call was made.
      expect(served.servedTransport).toHaveLength(1);
      expect(served.servedTransport[0]?.capability).toBe('az_pixiu_billing_cache');
      expect(served.servedTransport[0]?.final_outcome).toBe('success');
      expect(served.servedTransport[0]?.scope_subset?.subscription_ids).toEqual([SUB]);
    });
  });

  it('does not cache or serve a partial-month window (not cache-eligible)', async () => {
    await withProvider(APRIL_7DAY, async (provider) => {
      expect(await provider.writeThrough([rawFor(APRIL_7DAY)])).toBe(0);
      const plan: EvidencePlan = { requests: [costRequest(APRIL_7DAY)] };
      const served = await provider.serveFromCache(plan);
      expect(served.hitCount).toBe(0);
      expect(served.remainingPlan.requests).toEqual(plan.requests);
    });
  });

  it('does not cache a not-yet-mature month', async () => {
    await withProvider(JUNE, async (provider) => {
      // June 2026 is not finalized as of 2026-06-22.
      expect(await provider.writeThrough([rawFor(JUNE)])).toBe(0);
    });
  });

  it('caches and serves the LIVE planner param shape (camelCase startTime/endTime, MCP-enveloped payload)', async () => {
    await withProvider(APRIL, async (provider) => {
      // What the planner emits for live AMG-MCP: camelCase, startTime/endTime,
      // NO time_window object and NO granularity (the wire schema's allowed args).
      const liveRequest: EvidenceRequest = {
        capability: 'amgmcp_cost_analysis',
        parameters: {
          subscriptionId: SUB,
          startTime: APRIL.start,
          endTime: APRIL.end,
          azureMonitorDatasourceUid: 'amg-ds-1',
        },
        intent: 'cost_breakdown',
      };
      // The live response is the structured shape wrapped in the MCP text envelope.
      const liveResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              periodStart: APRIL.start,
              periodEnd: APRIL.end,
              subscriptions: [
                {
                  subscriptionId: SUB,
                  totalCost: 12253.01,
                  currency: 'USD',
                  byService: [{ name: 'Azure Database for PostgreSQL', cost: 12253.01 }],
                },
              ],
            }),
          },
        ],
        isError: false,
      };
      const liveRaw: RawEvidence = {
        request: liveRequest,
        parameters_digest: parameterDigest(liveRequest.parameters),
        capability_version: '1.0.0',
        result: liveResult,
        retrieved_at: '2026-06-22T08:00:00.000Z',
      };

      expect(await provider.writeThrough([liveRaw])).toBe(1);

      const served = await provider.serveFromCache({ requests: [liveRequest, NON_COST_REQUEST] });
      expect(served.hitCount).toBe(1);
      expect(served.remainingPlan.requests).toEqual([NON_COST_REQUEST]);
      const record = served.servedRecords[0]!;
      expect(record.source_capability).toBe('az_pixiu_billing_cache');
      expect(record.scope_subset.subscription_ids).toEqual([SUB]);
      // Replayed through the normalizer's live-shape rollup.
      expect((record.payload_summary as { total_cost?: number }).total_cost).toBe(12253.01);
    });
  });

  it('hits across runs even when the planner varies an incidental param (datasource uid)', async () => {
    await withProvider(APRIL, async (provider) => {
      const liveResult = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subscriptions: [
                { subscriptionId: SUB, totalCost: 100, currency: 'USD', byService: [{ name: 'Storage', cost: 100 }] },
              ],
            }),
          },
        ],
        isError: false,
      };
      const liveReq = (datasourceUid: string): EvidenceRequest => ({
        capability: 'amgmcp_cost_analysis',
        parameters: { subscriptionId: SUB, startTime: APRIL.start, endTime: APRIL.end, azureMonitorDatasourceUid: datasourceUid },
        intent: 'cost_breakdown',
      });
      // Warm with one datasource uid...
      await provider.writeThrough([
        { request: liveReq('amg-ds-1'), parameters_digest: parameterDigest(liveReq('amg-ds-1').parameters), capability_version: '1.0.0', result: liveResult, retrieved_at: '2026-06-22T08:00:00.000Z' },
      ]);
      // ...and serve a request that differs ONLY in the incidental uid: still a hit.
      const served = await provider.serveFromCache({ requests: [liveReq('amg-ds-2-DIFFERENT')] });
      expect(served.hitCount).toBe(1);
    });
  });

  it('only intercepts cost capabilities, never inventory requests', async () => {
    await withProvider(APRIL, async (provider) => {
      const served = await provider.serveFromCache({ requests: [NON_COST_REQUEST] });
      expect(served.hitCount).toBe(0);
      expect(served.remainingPlan.requests).toEqual([NON_COST_REQUEST]);
      expect(await provider.writeThrough([])).toBe(0);
    });
  });
});

describe('summarizeCostPayload dimension rollup', () => {
  it('rolls up byRegion and byResourceType when the live payload carries them', () => {
    const summary = summarizeCostPayload({
      periodStart: '2026-05-01T00:00:00Z',
      periodEnd: '2026-06-01T00:00:00Z',
      subscriptions: [
        {
          subscriptionId: SUB,
          totalCost: 300,
          currency: 'USD',
          byService: [
            { name: 'Azure Database for PostgreSQL', cost: 200 },
            { name: 'Storage', cost: 100 },
          ],
          byRegion: [
            { name: 'westus2', cost: 250 },
            { name: 'eastus', cost: 50 },
          ],
          byResourceType: [
            { name: 'microsoft.dbforpostgresql/flexibleservers', cost: 200 },
            { name: 'microsoft.storage/storageaccounts', cost: 100 },
          ],
        },
      ],
    });
    expect(summary).not.toBeNull();
    const s = summary!;
    expect(s.dimensions.region!.monthly.map((r) => r.name)).toEqual(['westus2', 'eastus']);
    expect(s.dimensions.resource_type!.monthly).toHaveLength(2);
    // ...and they are no longer reported as missing.
    expect(s.coverage.missing_dimensions).not.toContain('region');
    expect(s.coverage.missing_dimensions).not.toContain('resource_type');
    // resource_group remains unsupported by the cost capability.
    expect(s.coverage.missing_dimensions).toContain('resource_group');
    expect(s.dimensions.resource_group!.status).toBe('not_supported_by_current_capability');
  });

  it('flags region/resource_type as unavailable when the payload omits those axes', () => {
    const summary = summarizeCostPayload({
      subscriptions: [
        { subscriptionId: SUB, totalCost: 100, currency: 'USD', byService: [{ name: 'Storage', cost: 100 }] },
      ],
    });
    expect(summary).not.toBeNull();
    const s = summary!;
    expect(s.coverage.missing_dimensions).toContain('region');
    expect(s.coverage.missing_dimensions).toContain('resource_type');
    expect(s.dimensions.region!.status).toBe('not_available_in_source');
    expect(s.dimensions.resource_type!.status).toBe('not_available_in_source');
  });
});
