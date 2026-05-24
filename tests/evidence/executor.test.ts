import { describe, it, expect } from 'vitest';
import { EvidenceExecutor } from '../../src/evidence/executor.js';
import { DEFAULT_RETRY_POLICY } from '../../src/evidence/retry-policy.js';
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
  const fastSleep = () => Promise.resolve();
  const noJitter = () => 0;

  it('exhausts retries on persistent 429 and emits one classified failure', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap === 'amgmcp_cost_analysis') throw Object.assign(new Error('quota'), { status: 429 });
      return { content: 'ok' };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });

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
    expect(transport_summary[0]?.attempt_count).toBe(4);
    expect(transport_summary[0]?.retry_count).toBe(3);
    expect(transport_summary[0]?.final_outcome).toBe('rate_limit');
    expect(transport_summary[0]?.failure_category).toBe('rate_limit');
    // 30s + 60s + 120s = 210_000ms with zero jitter
    expect(transport_summary[0]?.cumulative_backoff_ms).toBe(210_000);
    expect(transport_summary[1]?.final_outcome).toBe('success');
  });

  it('does not retry non-retriable categories (authz_gap)', async () => {
    const transport = new FakeTransport(phase1Catalog, async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });

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
    expect(transport_summary.every((s) => s.attempt_count === 1)).toBe(true);
    expect(transport_summary.every((s) => s.final_outcome === 'other')).toBe(true);
    expect(transport_summary.every((s) => s.failure_category === 'authz_gap')).toBe(true);
  });
});

describe('EvidenceExecutor — retry semantics (Phase 3 §Gap 7)', () => {
  const fastSleep = () => Promise.resolve();
  const noJitter = () => 0;

  function makeRetryingTransport(throwTimes: number, status: number) {
    let calls = 0;
    return new FakeTransport(phase1Catalog, async (cap) => {
      calls += 1;
      if (calls <= throwTimes) {
        throw Object.assign(new Error('transient'), { status });
      }
      return { content: { capability: cap, attempt: calls } };
    });
  }

  it('recovers when 429 clears within the retry budget — no DQ, raw evidence emitted', async () => {
    const transport = makeRetryingTransport(2, 429);
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const sleeps: number[] = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: noJitter,
    });
    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
      ],
    };
    const { raw_evidence, failures, transport_summary } = await executor.execute(plan);
    expect(raw_evidence).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(transport_summary[0]?.attempt_count).toBe(3);
    expect(transport_summary[0]?.retry_count).toBe(2);
    expect(transport_summary[0]?.final_outcome).toBe('success');
    expect(transport_summary[0]?.cumulative_backoff_ms).toBe(90_000);
    expect(sleeps).toEqual([30_000, 60_000]);
    // Recovered 429 still flags rate_limit on the row via the additive
    // observed_failure_categories field — so the rollup's rate_limit_seen
    // flips true even though final_outcome is `success`.
    expect(transport_summary[0]?.observed_failure_categories).toEqual(['rate_limit']);
  });

  it('recovered 429 rolls up to rate_limit_seen === true', async () => {
    const { rollupTransportSummary } = await import('../../src/schemas/transport.js');
    const transport = makeRetryingTransport(1, 429);
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });
    const { transport_summary } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
      ],
    });
    const rollup = rollupTransportSummary(transport_summary);
    expect(rollup.recovered_count).toBe(1);
    expect(rollup.rate_limit_seen).toBe(true);
    expect(rollup.by_capability['amgmcp_cost_analysis']?.rate_limit_seen).toBe(true);
  });

  it('retries timeout-class failures (504)', async () => {
    const transport = makeRetryingTransport(1, 504);
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });
    const { raw_evidence, failures, transport_summary } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
      ],
    });
    expect(raw_evidence).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(transport_summary[0]?.attempt_count).toBe(2);
    expect(transport_summary[0]?.retry_count).toBe(1);
  });

  it('emits per-attempt onEvent hooks for retry and pacing', async () => {
    // Codex should-fix #3 / self-review #1: per-attempt observability
    // is what the §Gap 7 design called for so operator debugging "which
    // attempt of which call burned 180s?" stays answerable in the trace.
    let costCalls = 0;
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      costCalls += 1;
      if (costCalls === 1) throw Object.assign(new Error('quota'), { status: 429 });
      return { content: { call: costCalls } };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const events: Array<Record<string, unknown>> = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
      onEvent: (e) => events.push({ ...e }),
    });
    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { i: 1 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 2 }, intent: 'cost_breakdown' },
      ],
    };
    await executor.execute(plan);
    // First request: one retry_scheduled event (429 → backoff → success).
    // Second request: one pacing_applied event (capability was rate-
    // limited earlier in the run).
    const retries = events.filter((e) => e.kind === 'retry_scheduled');
    const paces = events.filter((e) => e.kind === 'pacing_applied');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      logical_request_id: 'req-1',
      capability: 'amgmcp_cost_analysis',
      attempt: 1,
      failure_category: 'rate_limit',
      backoff_ms: 30_000,
    });
    expect(paces).toHaveLength(1);
    expect(paces[0]).toMatchObject({
      logical_request_id: 'req-2',
      capability: 'amgmcp_cost_analysis',
      pacing_ms: 30_000,
    });
  });

  it('paces subsequent calls to a capability after first observed 429', async () => {
    // First call: 429 then success. Second call: success on first attempt
    // but is expected to be preceded by the inter-call pace.
    let costCalls = 0;
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      costCalls += 1;
      if (costCalls === 1) throw Object.assign(new Error('quota'), { status: 429 });
      return { content: { call: costCalls } };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const sleeps: number[] = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: noJitter,
    });
    const plan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { i: 1 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 2 }, intent: 'cost_breakdown' },
      ],
    };
    const { raw_evidence, transport_summary } = await executor.execute(plan);
    expect(raw_evidence).toHaveLength(2);
    // First call: one retry backoff (30s). Second call: pacing (30s). Total: 60_000.
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(transport_summary[1]?.pacing_applied).toBe(true);
    expect(transport_summary[0]?.pacing_applied).toBe(false);
  });

  it('paces independently of the retry-backoff budget (Codex should-fix #2)', async () => {
    // Prior behaviour: pacing sleeps were charged against totalBudgetMs,
    // so a long retry tail on capability A could silently disable
    // pacing on subsequent calls of capability B. Now: pacing has its
    // own totalPacingBudgetMs and retry backoff is unaffected.
    let costCalls = 0;
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      costCalls += 1;
      if (costCalls === 1) throw Object.assign(new Error('quota'), { status: 429 });
      return { content: { call: costCalls } };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const sleeps: number[] = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      retryPolicy: {
        maxAttempts: 4,
        baseDelayMs: 30_000,
        maxDelayMs: 180_000,
        jitterMs: 30_000,
        // Tiny backoff budget — would have starved pacing under the old
        // semantics — but pacing has its own pool now.
        totalBudgetMs: 30_000,
        paceAfterRateLimitMs: 30_000,
        totalPacingBudgetMs: 150_000,
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: noJitter,
    });
    const { transport_summary } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { i: 1 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 2 }, intent: 'cost_breakdown' },
      ],
    });
    // Backoff for req-1 (30s) + pacing for req-2 (30s) — pacing was not
    // skipped despite backoff budget being fully consumed by req-1.
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(transport_summary[1]?.pacing_applied).toBe(true);
  });

  it('stops pacing once totalPacingBudgetMs is exhausted', async () => {
    // Three calls, all paced after an initial 429. Budget allows only
    // two pacing sleeps; the third request dispatches with no pace.
    let firstFailed = false;
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      if (!firstFailed) {
        firstFailed = true;
        throw Object.assign(new Error('quota'), { status: 429 });
      }
      return { content: 'ok' };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const sleeps: number[] = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      retryPolicy: {
        ...DEFAULT_RETRY_POLICY,
        // Two pacings worth of budget.
        totalPacingBudgetMs: 60_000,
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: noJitter,
    });
    const { transport_summary } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { i: 1 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 2 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 3 }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { i: 4 }, intent: 'cost_breakdown' },
      ],
    });
    // 30s backoff (req-1) + 30s pace (req-2) + 30s pace (req-3); req-4
    // would have paced but budget is exhausted, so no fourth sleep.
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(transport_summary[3]?.pacing_applied).toBe(false);
  });

  it('honours total run-level backoff budget', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap === 'amgmcp_cost_analysis') throw Object.assign(new Error('quota'), { status: 429 });
      return { content: cap };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const sleeps: number[] = [];
    const executor = new EvidenceExecutor({
      client,
      catalog,
      retryPolicy: {
        maxAttempts: 4,
        baseDelayMs: 30_000,
        maxDelayMs: 180_000,
        jitterMs: 30_000,
        // Cut the per-run budget below a single full retry tail to prove
        // the executor doesn't sleep past it.
        totalBudgetMs: 45_000,
        paceAfterRateLimitMs: 30_000,
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      jitter: noJitter,
    });
    const { failures } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
      ],
    });
    expect(failures).toHaveLength(1);
    // First retry asks for 30s; second would be 60s but budget allows only 15s.
    expect(sleeps).toEqual([30_000, 15_000]);
  });
});

describe('EvidenceExecutor — embedded payload failures (design/embedded-rate-limit.md)', () => {
  const fastSleep = () => Promise.resolve();
  const noJitter = () => 0;

  function embeddedRateLimitPayload(subscriptionId: string): Record<string, unknown> {
    return {
      periodStart: '2026-05-17',
      periodEnd: '2026-05-24',
      subscriptions: [
        {
          subscriptionId,
          totalCost: 0,
          byService: [],
          byRegion: [],
          byResourceType: [],
          error: `Cost Management API rate limit (429) hit for subscription '${subscriptionId}'.`,
        },
      ],
    };
  }

  function cleanCostPayload(subscriptionId: string): Record<string, unknown> {
    return {
      periodStart: '2026-05-17',
      periodEnd: '2026-05-24',
      subscriptions: [
        {
          subscriptionId,
          totalCost: 42.5,
          byService: [{ service: 'Storage', cost: 42.5 }],
          byRegion: [],
          byResourceType: [],
        },
      ],
    };
  }

  it('treats embedded-429 payloads as retriable rate_limit failures (recovers on attempt 3)', async () => {
    const subId = '00000000-0000-0000-0000-00000000aaaa';
    let calls = 0;
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      calls += 1;
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      if (calls <= 2) return { content: embeddedRateLimitPayload(subId), isError: false };
      return { content: cleanCostPayload(subId), isError: false };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });

    const { raw_evidence, failures, transport_summary } = await executor.execute({
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: { subscriptionId: subId },
          intent: 'cost_breakdown',
        },
      ],
    });

    // Recovered: raw evidence pushed once (the clean payload), no
    // terminal failure, transport row reflects the retry path.
    expect(raw_evidence).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(transport_summary).toHaveLength(1);
    expect(transport_summary[0]?.attempt_count).toBe(3);
    expect(transport_summary[0]?.retry_count).toBe(2);
    expect(transport_summary[0]?.final_outcome).toBe('success');
    expect(transport_summary[0]?.observed_failure_categories).toEqual(['rate_limit']);
    // Only the clean payload should have made it into raw_evidence.
    const evContent = raw_evidence[0]?.result.content as Record<string, unknown> | undefined;
    expect(evContent?.subscriptions).toBeDefined();
    const subs = evContent?.subscriptions as Array<Record<string, unknown>>;
    expect(subs[0]?.totalCost).toBe(42.5);
  });

  it('exhausts retries on persistent embedded-429 and emits a rate_limit failure with no raw_evidence', async () => {
    const subId = '00000000-0000-0000-0000-00000000bbbb';
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      return { content: embeddedRateLimitPayload(subId), isError: false };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });

    const { raw_evidence, failures, transport_summary } = await executor.execute({
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: { subscriptionId: subId },
          intent: 'cost_breakdown',
        },
      ],
    });

    expect(raw_evidence).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe('rate_limit');
    expect(failures[0]?.source).toBe('payload-embedded');
    expect(transport_summary).toHaveLength(1);
    expect(transport_summary[0]?.attempt_count).toBe(4);
    expect(transport_summary[0]?.retry_count).toBe(3);
    expect(transport_summary[0]?.final_outcome).toBe('rate_limit');
    expect(transport_summary[0]?.failure_category).toBe('rate_limit');
    expect(transport_summary[0]?.observed_failure_categories ?? []).not.toContain('rate_limit');
    // 30s + 60s + 120s = 210_000 with zero jitter
    expect(transport_summary[0]?.cumulative_backoff_ms).toBe(210_000);
  });

  it('rolls up exhausted embedded-429 as rate_limit_seen=true and run outcome exhausted', async () => {
    const { rollupTransportSummary, runOutcomeFromRollup } = await import(
      '../../src/schemas/transport.js'
    );
    const subId = '00000000-0000-0000-0000-00000000cccc';
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      return { content: embeddedRateLimitPayload(subId), isError: false };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });
    const { transport_summary } = await executor.execute({
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: { subscriptionId: subId },
          intent: 'cost_breakdown',
        },
      ],
    });
    const rollup = rollupTransportSummary(transport_summary);
    expect(rollup.rate_limit_seen).toBe(true);
    expect(rollup.exhausted_count).toBe(1);
    expect(runOutcomeFromRollup(rollup)).toBe('exhausted');
  });

  it('does not retry embedded auth failures (not retriable)', async () => {
    const transport = new FakeTransport(phase1Catalog, async (cap) => {
      if (cap !== 'amgmcp_cost_analysis') return { content: cap };
      return {
        content: {
          subscriptions: [
            {
              subscriptionId: 'sub-x',
              totalCost: 0,
              byService: [],
              error: 'Unauthorized: token expired',
            },
          ],
        },
        isError: false,
      };
    });
    const client = new MCPClient({ transport });
    const catalog = await client.discover();
    const executor = new EvidenceExecutor({
      client,
      catalog,
      sleep: fastSleep,
      jitter: noJitter,
    });
    const { raw_evidence, failures, transport_summary } = await executor.execute({
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: {}, intent: 'cost_breakdown' },
      ],
    });
    expect(raw_evidence).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.category).toBe('auth');
    expect(transport_summary[0]?.attempt_count).toBe(1);
    expect(transport_summary[0]?.retry_count).toBe(0);
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
