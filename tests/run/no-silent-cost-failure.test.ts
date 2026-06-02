import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAnalysis } from '../../src/run/orchestrator.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import { describeCredential } from '../../src/run/credential-factory.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MCPClient } from '../../src/mcp/client.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import type {
  CapabilityCatalog,
  Config,
  ReasoningOutput,
  ToolCallResult,
} from '../../src/schemas/index.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type { RetryPolicy } from '../../src/evidence/retry-policy.js';

/**
 * Tests for fix/no-silent-cost-failure (DESIGN-NOTE.md).
 *
 * Bug A.1: when every amgmcp_cost_analysis call fails (rate_limit /
 *          auth / transport), the orchestrator must surface a `failed`
 *          cost_retrieval_outcome, the metadata.status must reflect it,
 *          and the report must carry an unambiguous "Run outcome:
 *          FAILED" banner. The run folder + report.md + run.json must
 *          still be written so the trace is preserved.
 *
 * Bug A.2: when the reasoner cites evidence IDs not present in the pool,
 *          post-process drops the offending facts/hypotheses/
 *          recommendations and the run must expose a structured
 *          reasoning_drops breakdown that the CLI can print loudly.
 */

// The cost-summary-001 fixture was recorded against this subscription id;
// using it lets the fixture's amgmcp_cost_analysis response match by
// `parameters_digest` so the success and partial-coverage tests resolve
// without recording new fixtures. See fixtures/cost-summary-001/manifest.json.
const subId = '33333333-3333-3333-3333-333333333333';

const config: Config = {
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-5.4',
    deployment_sku: 'GlobalStandard',
    api_version: '2024-10-21',
  },
  amg: {
    endpoint: 'https://example.grafana.azure.com',
  },
};

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

/**
 * Tight retry policy + zero-sleep so the failure paths complete in
 * milliseconds rather than burning the default 540s backoff budget.
 * The orchestrator's executorOverrides hook threads this all the way
 * down to the EvidenceExecutor — see `src/run/orchestrator.ts` and
 * DESIGN-NOTE.md.
 */
const FAST_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitterMs: 0,
  totalBudgetMs: 0,
  paceAfterRateLimitMs: 0,
  totalPacingBudgetMs: 0,
};
const fastSleep = () => Promise.resolve();
const noJitter = () => 0;

/**
 * Wraps a {@link FixtureMCPTransport} and rewrites every call to one
 * configured capability into a thrown error. Lets the test simulate
 * "AMG-MCP itself is healthy but the Cost Management upstream is
 * 429-ing" without rewiring the whole fixture system.
 */
class FailingCapabilityTransport implements MCPTransport {
  constructor(
    private readonly inner: MCPTransport,
    private readonly failingCapability: string,
    private readonly failure: () => Error,
  ) {}
  listCapabilities(): Promise<CapabilityCatalog> {
    return this.inner.listCapabilities();
  }
  invoke(capability: string, parameters: Record<string, unknown>): Promise<ToolCallResult> {
    if (capability === this.failingCapability) throw this.failure();
    return this.inner.invoke(capability, parameters);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

function http429(): Error {
  // Mirrors the failure shape `classifyFailure` keys off — a status
  // property on the error → category=rate_limit in the taxonomy.
  return Object.assign(new Error('429 Too Many Requests'), { status: 429 });
}

function emptyReasoning(): ReasoningOutput {
  return { facts: [], hypotheses: [], recommendations: [], data_quality: [] };
}

describe('Bug A.1 — cost-evidence retrieval failure surfaces loudly', () => {
  it('cost_summary with all amgmcp_cost_analysis calls 429-ing marks the run failed and still writes artefacts', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-cost-failed-'));
    try {
      const scope = intakeScope({
        subscription_ids: [subId],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        analysis_type: 'cost_summary',
      });

      const transport = new FailingCapabilityTransport(
        new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' }),
        'amgmcp_cost_analysis',
        http429,
      );

      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({ transport }),
        model: new MockModelClient({ responses: emptyReasoning() }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
        executorOverrides: {
          retryPolicy: FAST_POLICY,
          sleep: fastSleep,
          jitter: noJitter,
        },
      });

      expect(result.cost_retrieval_outcome).toBe('failed');
      expect(result.metadata.status).toBe('failed_analysis');

      // The report and run.json are preserved so the trace stays
      // navigable even though the analysis is not actionable.
      const md = await readFile(result.report_path, 'utf8');
      expect(md).toContain('## Run Quality');
      expect(md).toMatch(/\*\*Run outcome:\*\* FAILED/);
      expect(md).toContain('cost-evidence retrieval failed across all subscriptions in scope');

      const runJson = JSON.parse(await readFile(result.run_json_path, 'utf8')) as {
        metadata: { status: string };
      };
      expect(runJson.metadata.status).toBe('failed_analysis');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('partial cost coverage marks the run partial (not failed)', async () => {
    // The cost-summary-001 fixture is a single-sub fixture; we run a
    // *multi*-sub scope where one sub's cost call resolves from the
    // fixture (matches the recorded parameters_digest) and another
    // sub's cost call has no recorded response → classified failure.
    // Net: 1 of 2 subs covered → partial.
    const tmp = await mkdtemp(join(tmpdir(), 'azp-cost-partial-'));
    try {
      const otherSub = '22222222-2222-2222-2222-222222222222';
      const scope = intakeScope({
        subscription_ids: [subId, otherSub],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        analysis_type: 'cost_summary',
      });

      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({
          transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' }),
        }),
        model: new MockModelClient({ responses: emptyReasoning() }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
        executorOverrides: {
          retryPolicy: FAST_POLICY,
          sleep: fastSleep,
          jitter: noJitter,
        },
      });

      // One sub covered, one missing → partial, never failed. The cost
      // capability for sub 1 has a recorded fixture match against the
      // scope's time window; sub 2 does not, so its call ends with a
      // FixtureNotFoundError classified as `unsupported_capability`.
      expect(result.cost_retrieval_outcome).toBe('partial');
      expect(result.metadata.status).toBe('partial');

      const md = await readFile(result.report_path, 'utf8');
      expect(md).toMatch(/\*\*Run outcome:\*\* PARTIAL/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('clean cost_summary run with no drops reports SUCCESS', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-cost-success-'));
    try {
      const scope = intakeScope({
        subscription_ids: [subId],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        analysis_type: 'cost_summary',
      });

      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({
          transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' }),
        }),
        model: new MockModelClient({ responses: emptyReasoning() }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      expect(result.cost_retrieval_outcome).toBe('success');
      expect(result.metadata.status).toBe('success');
      expect(result.reasoning_drops.total).toBe(0);

      const md = await readFile(result.report_path, 'utf8');
      expect(md).toMatch(/\*\*Run outcome:\*\* SUCCESS/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Bug A.2 — reasoner drops are exposed as a structured breakdown', () => {
  it('counts dropped facts, hypotheses, and recommendations when citations are dangling', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-drops-'));
    try {
      const scope = intakeScope({
        subscription_ids: [subId],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        analysis_type: 'cost_summary',
      });

      // Citations deliberately point at evidence IDs not in the pool.
      // postProcessReasoning should drop the fact (dangling evidence
      // citation), and then drop the hypothesis and recommendation
      // because their support also evaporates.
      const reasoningResponse: ReasoningOutput = {
        facts: [
          {
            fact_id: 'fact-1',
            statement: 'fabricated fact',
            evidence_ids: ['ev-does-not-exist'],
            scope_subset: {
              subscription_ids: [subId],
              resource_group_names: null,
              resource_ids: null,
            },
          },
        ],
        hypotheses: [
          {
            hypothesis_id: 'hyp-1',
            statement: 'fabricated hypothesis',
            confidence: { level: 'high', rationale: 'no grounding', dimensions: strongDims },
            supported_by_fact_ids: ['fact-1'],
            counter_evidence_fact_ids: [],
            missing_evidence_to_decide: [],
          },
        ],
        recommendations: [
          {
            recommendation_id: 'rec-1',
            priority: 'high',
            confidence: { level: 'high', rationale: 'no grounding', dimensions: strongDims },
            impact: 'material',
            statement: 'fabricated recommendation',
            supported_by_hypothesis_ids: ['hyp-1'],
            supported_by_fact_ids: ['fact-1'],
            assumptions: ['baseline cost window is representative'],
            validation_steps: ['compare 14-day utilization metrics'],
            false_positive_considerations: ['legitimate workload growth'],
            suggested_audience: 'platform_engineer',
            suggested_human_actions: ['review the deployment record'],
            recommendation_signature: 'fabricated-1',
          },
        ],
        data_quality: [],
      };

      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({
          transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' }),
        }),
        model: new MockModelClient({ responses: reasoningResponse }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      // Drops are accounted for in the structured breakdown; the
      // post-process synthesises one schema_mismatch DQ per drop.
      expect(result.reasoning_drops.facts).toBe(1);
      expect(result.reasoning_drops.hypotheses).toBe(1);
      expect(result.reasoning_drops.recommendations).toBe(1);
      expect(result.reasoning_drops.total).toBe(3);
      expect(result.reasoning.facts).toHaveLength(0);
      expect(result.reasoning.hypotheses).toHaveLength(0);
      expect(result.reasoning.recommendations).toHaveLength(0);

      // The Run Quality banner reflects the truncation even when
      // cost retrieval itself succeeded.
      const md = await readFile(result.report_path, 'utf8');
      expect(md).toMatch(/\*\*Run outcome:\*\* PARTIAL/);
      expect(md).toContain('reasoner output was truncated');
      // The synthetic schema_mismatch DQ rows still surface in the
      // existing Data Quality section so the user can audit which
      // ids were dropped.
      expect(md).toMatch(/dq-synth-/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('clean run produces zero drops and a SUCCESS banner', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-no-drops-'));
    try {
      const scope = intakeScope({
        subscription_ids: [subId],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        analysis_type: 'cost_summary',
      });

      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({
          transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' }),
        }),
        model: new MockModelClient({ responses: emptyReasoning() }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      expect(result.reasoning_drops).toEqual({
        facts: 0,
        hypotheses: 0,
        recommendations: 0,
        total: 0,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
