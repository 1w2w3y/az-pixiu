import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MCPClient, assertRequiredCapabilities } from '../../src/mcp/client.js';
import { EvidenceExecutor } from '../../src/evidence/executor.js';
import { EvidenceNormalizer } from '../../src/evidence/normalizer.js';
import { Planner } from '../../src/reasoning/planner.js';
import { Reasoner } from '../../src/reasoning/reasoner.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import { writeRunArtifact, buildRunArtifact } from '../../src/report/runjson.js';
import { initializeTracing, shutdownTracing } from '../../src/observability/setup.js';
import { withSpan, SpanNames, ATTR } from '../../src/observability/spans.js';
import { scoreAll } from '../../src/evaluation/scoring.js';
import { loadDataset, fixturePathFor } from '../../src/evaluation/dataset.js';
import { loadPrompt } from '../../src/prompts/loader.js';
import { modelConfigHash } from '../../src/model/client.js';

import type {
  EvidencePlan,
  ReasoningOutput,
  RunMetadata,
} from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

describe('Phase 1 end-to-end pipeline (against the seeded fixture, mocked LLM)', () => {
  it('runs every component in design order and produces a scored report', async () => {
    const state = await initializeTracing({ mode: 'memory' });
    const tmpDir = await mkdtemp(join(tmpdir(), 'azp-e2e-'));

    try {
      // 1. Load dataset + prompts
      const dataset = await loadDataset('eval/cost-surprise-001.json');
      const item = dataset.items[0]!;
      const plannerPrompt = await loadPrompt({ filename: 'planner.v1.md' });
      const reasonerPrompt = await loadPrompt({ filename: 'reasoner.v1.md' });

      // 2. Open MCP session, discover capabilities (with span)
      const transport = new FixtureMCPTransport({ fixturePath: fixturePathFor(item) });
      const client = new MCPClient({ transport });
      const catalog = await withSpan(SpanNames.CapabilityDiscovery, async () => client.discover());
      assertRequiredCapabilities(catalog, 'cost_surprise');

      // 3. Plan (mocked) — emits the two cost_analysis windows + activity log
      const cannedPlan: EvidencePlan = {
        requests: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: {
              subscription_id: subId,
              time_window: item.scope.time_window,
              granularity: 'Daily',
              grouping: ['ServiceName'],
            },
            intent: 'cost_breakdown',
          },
          {
            capability: 'amgmcp_cost_analysis',
            parameters: {
              subscription_id: subId,
              time_window: item.scope.baseline_window,
              granularity: 'Daily',
              grouping: ['ServiceName'],
            },
            intent: 'cost_breakdown',
          },
          {
            capability: 'amgmcp_query_resource_graph',
            parameters: {
              subscription_ids: [subId],
              query:
                "Resources | where type =~ 'Microsoft.DBforPostgreSQL/flexibleServers' | project id, name, location, sku, tags",
            },
            intent: 'inventory',
          },
          {
            capability: 'amgmcp_query_activity_log',
            parameters: {
              subscription_id: subId,
              time_window: item.scope.time_window,
              resource_group_name: 'rg-db-prod',
            },
            intent: 'activity',
          },
        ],
      };
      // Re-encode parameters as JSON strings to match the planner's LLM
      // wire format (OpenAI strict-mode requirement; see planner.ts).
      const cannedLLMPlan = {
        requests: cannedPlan.requests.map((r) => ({
          capability: r.capability,
          parameters: JSON.stringify(r.parameters),
          intent: r.intent,
          ...(r.expected_role !== undefined && r.expected_role !== null
            ? { expected_role: r.expected_role }
            : {}),
        })),
      };
      const planner = new Planner({
        model: new MockModelClient({ responses: cannedLLMPlan }),
        systemPrompt: plannerPrompt.content,
      });
      const plan = await withSpan(SpanNames.EvidencePlanning, async () => planner.plan(item.scope, catalog));
      expect(plan.requests.length).toBeGreaterThan(0);

      // 4. Execute the plan against the fixture
      const executor = new EvidenceExecutor({ client, catalog });
      const { raw_evidence, failures } = await withSpan(SpanNames.EvidenceRetrieval, async () =>
        executor.execute(plan),
      );
      expect(failures).toHaveLength(0);
      expect(raw_evidence).toHaveLength(plan.requests.length);

      // 5. Normalize
      const normalizer = new EvidenceNormalizer();
      const { records, data_quality } = normalizer.normalize(raw_evidence, {
        defaultTimeWindow: item.scope.time_window,
      });
      expect(records.length).toBe(raw_evidence.length);

      // 6. Reason (mocked) — canned output cites real evidence ids
      const recId = 'rec-1';
      const hypId = 'hyp-1';
      const factId = 'fact-1';
      const cannedReasoning: ReasoningOutput = {
        facts: [
          {
            fact_id: factId,
            statement: 'PostgreSQL cost rose from 446.91 to 617.58 USD over the analysis window',
            evidence_ids: [records[0]!.evidence_id, records[1]!.evidence_id],
            scope_subset: { subscription_ids: [subId] },
          },
        ],
        hypotheses: [
          {
            hypothesis_id: hypId,
            statement: 'A SKU upgrade on 2026-05-03 caused the workload shift',
            confidence: { level: 'high', rationale: 'timing aligns', dimensions: strongDims },
            supported_by_fact_ids: [factId],
            counter_evidence_fact_ids: [],
            missing_evidence_to_decide: [],
          },
        ],
        recommendations: [
          {
            recommendation_id: recId,
            priority: 'high',
            confidence: { level: 'high', rationale: 'aligned signals', dimensions: strongDims },
            impact: 'material',
            statement: 'investigate the 2026-05-03 PostgreSQL SKU upgrade for sustained workload alignment',
            supported_by_hypothesis_ids: [hypId],
            supported_by_fact_ids: [factId],
            assumptions: ['baseline cost window is representative'],
            validation_steps: ['compare 14-day utilization metrics before and after the upgrade'],
            false_positive_considerations: ['legitimate sustained workload growth'],
            suggested_audience: 'platform_engineer',
            suggested_human_actions: ['review the deployment record for db-prod-2'],
          },
        ],
        data_quality: [],
      };
      const reasoner = new Reasoner({
        model: new MockModelClient({ responses: cannedReasoning }),
        systemPrompt: reasonerPrompt.content,
      });
      const { output: reasoning, issues } = await withSpan(SpanNames.Reasoning, async () =>
        reasoner.reason({ scope: item.scope, evidence: records, data_quality }),
      );
      expect(issues).toHaveLength(0);
      expect(reasoning.recommendations).toHaveLength(1);

      // 7. Score against the rubric
      const score = scoreAll(reasoning);
      expect(score.passed_all).toBe(true);
      expect(score.pass_count).toBe(4);

      // 8. Build run metadata + artifact
      const metadata: RunMetadata = {
        run_id: '99999999-9999-9999-9999-999999999999',
        trace_id: 'e2e-trace',
        prompt_versions: { planner: plannerPrompt.version, reasoner: reasonerPrompt.version },
        model_provider: 'mock',
        model_name: 'mock-1',
        model_config_hash: modelConfigHash({ provider: 'mock', name: 'mock-1', temperature: 0 }),
        model_deployment_sku: 'GlobalStandard',
        credential_source: { implementation: 'MockCredential', identity: 'test' },
        amg_mcp_endpoint: 'https://example.grafana.azure.com',
        capability_versions: catalog.capability_versions,
        fixture_id: item.fixture_id,
        started_at: '2026-05-18T12:00:00Z',
        ended_at: '2026-05-18T12:00:03Z',
        status: 'success',
      };

      // 9. Render report + write run.json
      const reportPath = join(tmpDir, 'report.md');
      const runJsonPath = join(tmpDir, 'run.json');
      const md = await withSpan(SpanNames.ReportAssembly, async () =>
        renderMarkdownReport({ scope: item.scope, reasoning, evidence: records, metadata }),
      );
      await (await import('node:fs/promises')).writeFile(reportPath, md, 'utf8');
      await writeRunArtifact({
        path: runJsonPath,
        artifact: buildRunArtifact(metadata, item.scope, records, reasoning),
      });

      // 10. Verify on-disk artifacts
      const reportContent = await readFile(reportPath, 'utf8');
      expect(reportContent).toContain('# Az-Pixiu Cost-Surprise Report');
      expect(reportContent).toContain(recId);
      expect(reportContent).toContain('investigate the 2026-05-03 PostgreSQL SKU upgrade');

      const runJson = JSON.parse(await readFile(runJsonPath, 'utf8')) as { schema_version: string; reasoning: { recommendations: unknown[] } };
      expect(runJson.schema_version).toBe('1');
      expect(runJson.reasoning.recommendations).toHaveLength(1);

      // 11. Verify trace structure (memory exporter)
      await state.inMemoryExporter!.forceFlush();
      const spans = state.inMemoryExporter!.getFinishedSpans();
      const spanNames = spans.map((s) => s.name).sort();
      expect(spanNames).toContain(SpanNames.CapabilityDiscovery);
      expect(spanNames).toContain(SpanNames.EvidencePlanning);
      expect(spanNames).toContain(SpanNames.EvidenceRetrieval);
      expect(spanNames).toContain(SpanNames.Reasoning);
      expect(spanNames).toContain(SpanNames.ReportAssembly);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
      await shutdownTracing();
    }
  });
});
