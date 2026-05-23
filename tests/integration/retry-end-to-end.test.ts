import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MCPClient } from '../../src/mcp/client.js';
import { EvidenceExecutor } from '../../src/evidence/executor.js';
import { EvidenceNormalizer } from '../../src/evidence/normalizer.js';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import { writeRunArtifact, buildRunArtifact } from '../../src/report/runjson.js';
import { rollupTransportSummary } from '../../src/schemas/transport.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import type {
  CapabilityCatalog,
  EvidencePlan,
  ReasoningOutput,
  RunMetadata,
  Scope,
  ToolCallResult,
} from '../../src/schemas/index.js';

/**
 * Orchestrator-level integration test for the retry path
 * (self-review #2). The PR shipped with unit-level retry coverage only —
 * this test stitches executor → normalizer → renderMarkdownReport →
 * run.json with a FakeTransport that throws 429s so the full pipeline
 * is exercised end-to-end against the retry substrate.
 */

const subA = '11111111-1111-1111-1111-111111111111';

const scope: Scope = {
  subscription_ids: [subA],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: 'one sub, retry-path test',
};

const catalog: CapabilityCatalog = {
  capabilities: [{ name: 'amgmcp_cost_analysis', version: '1.0.0' }],
};

class ScriptedTransport implements MCPTransport {
  private calls = 0;
  constructor(
    private readonly script: Array<{ throwStatus?: number; content?: unknown }>,
  ) {}
  async listCapabilities() {
    return catalog;
  }
  async invoke(_cap: string, _params: Record<string, unknown>): Promise<ToolCallResult> {
    const step = this.script[this.calls];
    this.calls += 1;
    if (!step) throw new Error(`ScriptedTransport exhausted after ${this.calls} calls`);
    if (step.throwStatus !== undefined) {
      throw Object.assign(new Error(`HTTP ${step.throwStatus}`), { status: step.throwStatus });
    }
    return { content: step.content ?? {}, isError: false };
  }
  async close() {}
}

function plan(): EvidencePlan {
  return {
    requests: [
      {
        capability: 'amgmcp_cost_analysis',
        parameters: {
          subscription_id: subA,
          time_window: scope.time_window,
        },
        intent: 'cost_breakdown',
      },
    ],
  };
}

function emptyReasoning(): ReasoningOutput {
  return { facts: [], hypotheses: [], recommendations: [], data_quality: [] };
}

function metadata(): RunMetadata {
  return {
    run_id: '99999999-9999-9999-9999-999999999999',
    trace_id: 'retry-e2e',
    prompt_versions: { planner: 'v1', reasoner: 'v1' },
    model_provider: 'mock',
    model_name: 'mock-1',
    model_config_hash: 'h',
    credential_source: { implementation: 'MockCredential', identity: 'test' },
    amg_mcp_endpoint: 'https://example.grafana.azure.com',
    capability_versions: catalog.capabilities.reduce<Record<string, string>>(
      (acc, c) => {
        if (c.version) acc[c.name] = c.version;
        return acc;
      },
      {},
    ),
    started_at: '2026-05-18T12:00:00Z',
    ended_at: '2026-05-18T12:00:03Z',
    status: 'success',
  };
}

const fastSleep = () => Promise.resolve();
const noJitter = () => 0;

describe('integration — retry path through executor → normalizer → report → run.json', () => {
  it('recovered 429: report and run.json both reflect rate_limit_seen + recovery', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'azp-retry-e2e-'));
    try {
      const transport = new ScriptedTransport([
        { throwStatus: 429 },
        { throwStatus: 429 },
        { content: { subscriptions: [{ subscriptionId: subA, totalCost: 100, currency: 'USD' }] } },
      ]);
      const client = new MCPClient({ transport });
      const discovered = await client.discover();
      const recordedEvents: Array<Record<string, unknown>> = [];
      const executor = new EvidenceExecutor({
        client,
        catalog: discovered,
        sleep: fastSleep,
        jitter: noJitter,
        onEvent: (e) => recordedEvents.push({ ...e }),
      });
      const result = await executor.execute(plan());

      expect(result.failures).toHaveLength(0);
      expect(result.raw_evidence).toHaveLength(1);
      const entry = result.transport_summary[0]!;
      expect(entry.attempt_count).toBe(3);
      expect(entry.retry_count).toBe(2);
      expect(entry.final_outcome).toBe('success');
      expect(entry.observed_failure_categories).toEqual(['rate_limit']);

      // Per-attempt events fire alongside the run-level rollup.
      const retryEvents = recordedEvents.filter((e) => e.kind === 'retry_scheduled');
      expect(retryEvents).toHaveLength(2);

      const rollup = rollupTransportSummary(result.transport_summary);
      expect(rollup.recovered_count).toBe(1);
      expect(rollup.rate_limit_seen).toBe(true);
      expect(rollup.exhausted_count).toBe(0);

      const normalizer = new EvidenceNormalizer();
      const { records, data_quality } = normalizer.normalize(result.raw_evidence, {
        defaultTimeWindow: scope.time_window,
      });
      // No DQ for the recovered 429 (by design — see §Gap 7).
      expect(data_quality).toHaveLength(0);

      const md = renderMarkdownReport({
        scope,
        reasoning: emptyReasoning(),
        evidence: records,
        metadata: metadata(),
        inputDataQuality: data_quality,
        transportSummary: result.transport_summary,
      });
      const reportPath = join(tmpDir, 'report.md');
      const runJsonPath = join(tmpDir, 'run.json');
      await writeFile(reportPath, md, 'utf8');
      await writeRunArtifact({
        path: runJsonPath,
        artifact: buildRunArtifact(
          metadata(),
          scope,
          records,
          emptyReasoning(),
          data_quality,
          result.transport_summary,
        ),
      });

      // Rendered report describes the recovery in Run Quality.
      const reportContent = await readFile(reportPath, 'utf8');
      expect(reportContent).toContain('## Run Quality');
      // Quantified baseline includes retry count + cumulative backoff.
      expect(reportContent).toMatch(/2 retry attempt\(s\)/);
      // Per-capability recovered line names the cost capability.
      expect(reportContent).toMatch(/\*\*amgmcp_cost_analysis:\*\*/);
      expect(reportContent).toContain('all attempts ultimately succeeded');

      // run.json carries the rollup-derivable fields too.
      const runJson = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
        transport_summary?: Array<Record<string, unknown>>;
      };
      expect(runJson.transport_summary).toHaveLength(1);
      const persisted = runJson.transport_summary![0]!;
      expect(persisted.retry_count).toBe(2);
      expect(persisted.final_outcome).toBe('success');
      expect(persisted.observed_failure_categories).toEqual(['rate_limit']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('exhausted 429: report shows DQ + Run Quality reflects exhaustion', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'azp-retry-e2e-'));
    try {
      const transport = new ScriptedTransport([
        { throwStatus: 429 },
        { throwStatus: 429 },
        { throwStatus: 429 },
        { throwStatus: 429 },
      ]);
      const client = new MCPClient({ transport });
      const discovered = await client.discover();
      const executor = new EvidenceExecutor({
        client,
        catalog: discovered,
        sleep: fastSleep,
        jitter: noJitter,
      });
      const result = await executor.execute(plan());

      expect(result.raw_evidence).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.category).toBe('rate_limit');
      const entry = result.transport_summary[0]!;
      expect(entry.attempt_count).toBe(4);
      expect(entry.final_outcome).toBe('rate_limit');
      expect(entry.failure_category).toBe('rate_limit');

      const rollup = rollupTransportSummary(result.transport_summary);
      expect(rollup.exhausted_count).toBe(1);
      expect(rollup.recovered_count).toBe(0);
      expect(rollup.rate_limit_seen).toBe(true);

      const normalizer = new EvidenceNormalizer();
      const { records, data_quality } = normalizer.normalize(result.raw_evidence, {
        defaultTimeWindow: scope.time_window,
      });
      // Synthesise the failure-derived DQ the orchestrator would attach,
      // since this test exercises the wiring directly.
      const failureDq = result.failures.map((f, i) => ({
        dq_id: `dq-failure-${i + 1}`,
        category: f.category,
        affected_capability: f.capability,
        affected_scope_subset: null,
        consequence_for_analysis: f.message,
        impact_on_recommendations: [],
        actionable_hint: f.actionable_hint ?? null,
      }));
      const allDq = [...data_quality, ...failureDq];

      const md = renderMarkdownReport({
        scope,
        reasoning: emptyReasoning(),
        evidence: records,
        metadata: metadata(),
        inputDataQuality: allDq,
        transportSummary: result.transport_summary,
      });
      const reportPath = join(tmpDir, 'report.md');
      await writeFile(reportPath, md, 'utf8');
      const reportContent = await readFile(reportPath, 'utf8');
      expect(reportContent).toContain('## Run Quality');
      expect(reportContent).toContain('all retries exhausted');
      // Executive Summary coverage line surfaces the rate_limit failure.
      expect(reportContent).toMatch(/rate_limit/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
