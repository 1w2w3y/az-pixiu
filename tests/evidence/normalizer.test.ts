import { describe, it, expect } from 'vitest';
import { EvidenceNormalizer } from '../../src/evidence/normalizer.js';
import { MCPClient } from '../../src/mcp/client.js';
import { EvidenceExecutor } from '../../src/evidence/executor.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import type { RawEvidence } from '../../src/evidence/executor.js';
import type { EvidencePlan, TimeWindow } from '../../src/schemas/index.js';

const defaultWindow: TimeWindow = {
  start: '2026-05-01T00:00:00Z',
  end: '2026-05-08T00:00:00Z',
};

function rawEvidence(overrides: Partial<RawEvidence> = {}): RawEvidence {
  return {
    request: {
      capability: 'amgmcp_cost_analysis',
      // already prefixed above; this comment is a no-op edit anchor

      parameters: { subscription_id: '11111111-1111-1111-1111-111111111111' },
      intent: 'cost_breakdown',
    },
    parameters_digest: 'a'.repeat(64),
    capability_version: '1.0.0',
    result: { content: { rows: [['x', 1]], total: { cost: 1, currency: 'USD' } } },
    retrieved_at: '2026-05-18T12:00:00Z',
    ...overrides,
  };
}

describe('EvidenceNormalizer — happy path', () => {
  it('produces one EvidenceRecord per RawEvidence with deterministic evidence_id', () => {
    const n = new EvidenceNormalizer();
    const { records, data_quality } = n.normalize([rawEvidence()], { defaultTimeWindow: defaultWindow });
    expect(records).toHaveLength(1);
    expect(records[0]?.evidence_id).toBe(`ev-amgmcp_cost_analysis-${'a'.repeat(8)}`);
    expect(data_quality).toHaveLength(0);
  });

  it('extracts subscription_id (singular) into scope_subset.subscription_ids', () => {
    const n = new EvidenceNormalizer();
    const subId = '22222222-2222-2222-2222-222222222222';
    const { records } = n.normalize(
      [
        rawEvidence({
          request: { capability: 'amgmcp_cost_analysis', parameters: { subscription_id: subId }, intent: 'cost_breakdown' },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.scope_subset.subscription_ids).toEqual([subId]);
  });

  it('extracts subscription_ids (plural) as-is', () => {
    const n = new EvidenceNormalizer();
    const subs = [
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            capability: 'amgmcp_query_resource_graph',
            parameters: { subscription_ids: subs },
            intent: 'inventory',
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.scope_subset.subscription_ids).toEqual(subs);
  });

  it('recognises camelCase subscriptionIds (planner-LLM convention)', () => {
    const n = new EvidenceNormalizer();
    const subs = [
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ];
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            capability: 'amgmcp_query_resource_graph',
            parameters: { subscriptionIds: subs },
            intent: 'inventory',
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.scope_subset.subscription_ids).toEqual(subs);
  });

  it('derives cost_analysis scope_subset from response subscriptions[] when request params omit it', () => {
    const n = new EvidenceNormalizer();
    const subs = [
      '55555555-5555-5555-5555-555555555555',
      '66666666-6666-6666-6666-666666666666',
    ];
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            // Planner LLM may pass no scope params at all and let the
            // capability default to "all visible subs" — coverage must
            // still be derivable from the response.
            capability: 'amgmcp_cost_analysis',
            parameters: {},
            intent: 'cost_breakdown',
          },
          result: {
            content: {
              periodStart: '2026-05-01',
              periodEnd: '2026-05-08',
              subscriptions: subs.map((id) => ({
                subscriptionId: id,
                totalCost: 100,
                currency: 'USD',
                byService: [],
              })),
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.scope_subset.subscription_ids).toEqual(expect.arrayContaining(subs));
  });

  it('prefers response subscriptions over request params when payload covers fewer subs', () => {
    // Codex must-fix #2: when the planner requests [A, B, C] but AMG-MCP
    // returns a payload covering only [A], the EvidenceRecord's
    // scope_subset must reflect what the payload actually covers ([A]),
    // not the request ∪ response union. Otherwise coverage detection
    // claims full coverage for a partial payload.
    const subA = '11111111-1111-1111-1111-111111111111';
    const subB = '22222222-2222-2222-2222-222222222222';
    const subC = '33333333-3333-3333-3333-333333333333';
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            capability: 'amgmcp_cost_analysis',
            parameters: { subscriptionIds: [subA, subB, subC] },
            intent: 'cost_breakdown',
          },
          result: {
            content: {
              periodStart: '2026-05-01',
              periodEnd: '2026-05-08',
              subscriptions: [
                {
                  subscriptionId: subA,
                  totalCost: 100,
                  currency: 'USD',
                  byService: [],
                },
              ],
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.scope_subset.subscription_ids).toEqual([subA]);
  });

  it('uses request.parameters.time_window when present', () => {
    const customWindow = { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' };
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            capability: 'amgmcp_cost_analysis',
            parameters: { time_window: customWindow },
            intent: 'cost_breakdown',
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.time_window).toEqual(customWindow);
  });

  it('falls back to defaultTimeWindow when params omit a window', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          request: {
            capability: 'amgmcp_query_azure_subscriptions',
            parameters: {},
            intent: 'inventory',
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.time_window).toEqual(defaultWindow);
  });

  it('inlines the payload via payload_ref.kind = "inline"', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize([rawEvidence()], { defaultTimeWindow: defaultWindow });
    const ref = records[0]?.payload_ref;
    if (!ref || ref.kind !== 'inline') throw new Error('expected inline payload_ref');
    expect(ref.data).toBeDefined();
  });
});

describe('EvidenceNormalizer — per-capability summaries', () => {
  it('summarizes cost_analysis with row_count + total_cost + currency', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          result: {
            content: {
              rows: [['a', 1], ['b', 2], ['c', 3]],
              total: { cost: 6, currency: 'USD' },
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.payload_summary).toEqual({
      capability: 'amgmcp_cost_analysis',
      row_count: 3,
      total_cost: 6,
      currency: 'USD',
    });
  });

  it('summarizes cost_analysis live AMG-MCP shape (subscriptions[].totalCost + byService)', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          result: {
            content: {
              periodStart: '2026-05-12',
              periodEnd: '2026-05-19',
              subscriptions: [
                {
                  subscriptionId: '11111111-1111-1111-1111-111111111111',
                  totalCost: 100,
                  currency: 'USD',
                  byService: [
                    { name: 'App Service', cost: 60 },
                    { name: 'Storage', cost: 40 },
                  ],
                },
                {
                  subscriptionId: '22222222-2222-2222-2222-222222222222',
                  totalCost: 25.5,
                  currency: 'USD',
                  byService: [{ name: 'App Service', cost: 25.5 }],
                },
              ],
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.payload_summary).toEqual({
      capability: 'amgmcp_cost_analysis',
      row_count: 3,
      total_cost: 125.5,
      currency: 'USD',
    });
  });

  it('summarizes query_resource_graph with count + sample_names', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          request: { capability: 'amgmcp_query_resource_graph', parameters: {}, intent: 'inventory' },
          result: {
            content: {
              data: [
                { id: '/sub/x/rg/.../db-1', name: 'db-1', tags: { owner: 'x' } },
                { id: '/sub/x/rg/.../db-2', name: 'db-2', tags: { owner: 'x' } },
                { id: '/sub/x/rg/.../db-3', name: 'db-3', tags: { owner: 'x' } },
                { id: '/sub/x/rg/.../db-4', name: 'db-4', tags: { owner: 'x' } },
              ],
              count: 4,
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    const summary = records[0]?.payload_summary as { count: number; sample_names: string[] };
    expect(summary.count).toBe(4);
    expect(summary.sample_names).toEqual(['db-1', 'db-2', 'db-3']);
  });

  it('summarizes query_activity_log with operations set', () => {
    const n = new EvidenceNormalizer();
    const { records } = n.normalize(
      [
        rawEvidence({
          request: { capability: 'amgmcp_query_activity_log', parameters: {}, intent: 'activity' },
          result: {
            content: {
              entries: [
                { operation: 'op.a' },
                { operation: 'op.b' },
                { operation: 'op.a' },
              ],
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    const summary = records[0]?.payload_summary as { entry_count: number; operations: string[] };
    expect(summary.entry_count).toBe(3);
    expect(summary.operations.sort()).toEqual(['op.a', 'op.b']);
  });
});

describe('EvidenceNormalizer — data quality findings', () => {
  it('emits empty_result DQ when content is structurally empty', () => {
    const n = new EvidenceNormalizer();
    const { records, data_quality } = n.normalize(
      [rawEvidence({ result: { content: { rows: [] } } })],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.caveats).toContain('empty payload from upstream');
    expect(data_quality).toHaveLength(1);
    expect(data_quality[0]?.category).toBe('empty_result');
    expect(data_quality[0]?.affected_capability).toBe('amgmcp_cost_analysis');
  });

  it('emits tagging_gap when >= 50% of resource_graph rows are untagged', () => {
    const n = new EvidenceNormalizer();
    const { records, data_quality } = n.normalize(
      [
        rawEvidence({
          request: { capability: 'amgmcp_query_resource_graph', parameters: {}, intent: 'inventory' },
          result: {
            content: {
              data: [
                { id: 'a', tags: { owner: 'x' } },
                { id: 'b', tags: {} },
                { id: 'c', tags: {} },
                { id: 'd' }, // missing tags entirely
              ],
              count: 4,
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(records[0]?.caveats.some((c) => c.includes('untagged'))).toBe(true);
    expect(data_quality.map((d) => d.category)).toContain('tagging_gap');
  });

  it('does not emit tagging_gap when most resources are tagged', () => {
    const n = new EvidenceNormalizer();
    const { data_quality } = n.normalize(
      [
        rawEvidence({
          request: { capability: 'amgmcp_query_resource_graph', parameters: {}, intent: 'inventory' },
          result: {
            content: {
              data: [
                { id: 'a', tags: { owner: 'x' } },
                { id: 'b', tags: { owner: 'y' } },
                { id: 'c', tags: { owner: 'z' } },
                { id: 'd', tags: {} },
              ],
              count: 4,
            },
          },
        }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(data_quality).toHaveLength(0);
  });

  it('emits unique dq_ids across multiple findings in one normalize call', () => {
    const n = new EvidenceNormalizer();
    const { data_quality } = n.normalize(
      [
        rawEvidence({ result: { content: { rows: [] } } }),
        rawEvidence({ result: { content: { rows: [] } } }),
      ],
      { defaultTimeWindow: defaultWindow },
    );
    expect(data_quality).toHaveLength(2);
    expect(new Set(data_quality.map((d) => d.dq_id)).size).toBe(2);
  });
});

describe('EvidenceNormalizer — against seeded fixture end-to-end', () => {
  it('normalizes the cost-surprise plan to records with summaries', async () => {
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
          capability: 'amgmcp_query_resource_graph',
          parameters: {
            subscription_ids: ['11111111-1111-1111-1111-111111111111'],
            query:
              "Resources | where type =~ 'Microsoft.DBforPostgreSQL/flexibleServers' | project id, name, location, sku, tags",
          },
          intent: 'inventory',
        },
      ],
    };
    const { raw_evidence } = await executor.execute(plan);
    const normalizer = new EvidenceNormalizer();
    const { records, data_quality } = normalizer.normalize(raw_evidence, {
      defaultTimeWindow: defaultWindow,
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.source_capability).toBe('amgmcp_cost_analysis');
    expect(records[1]?.source_capability).toBe('amgmcp_query_resource_graph');
    // The seeded resource_graph response has one tagged + one untagged → 50% → tagging_gap
    expect(data_quality.map((d) => d.category)).toContain('tagging_gap');
  });
});
