import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAnalysis } from '../../src/run/orchestrator.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import { describeCredential } from '../../src/run/credential-factory.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import type { Config, ReasoningOutput } from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';

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

describe('runAnalysis — fixture transport + mock model + playbook', () => {
  it('produces a report.md and run.json with at least one recommendation', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-orc-'));
    try {
      const scope = intakeScope({
        subscription_id: subId,
        resource_group_names: ['rg-db-prod'],
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        baseline_window_start: '2026-04-24T00:00:00Z',
        baseline_window_end: '2026-05-01T00:00:00Z',
      });

      // Canned reasoning output (the orchestrator only calls reason() once
      // because usePlaybook=true skips the planner).
      const reasoningResponse: ReasoningOutput = {
        facts: [
          {
            fact_id: 'fact-1',
            statement: 'cost rose materially over the analysis window',
            evidence_ids: ['ev-amgmcp_cost_analysis-67a86186'],
            scope_subset: { subscription_ids: [subId] },
          },
        ],
        hypotheses: [
          {
            hypothesis_id: 'hyp-1',
            statement: 'recent SKU upgrade explains the cost shift',
            confidence: { level: 'high', rationale: 'timing aligns', dimensions: strongDims },
            supported_by_fact_ids: ['fact-1'],
            counter_evidence_fact_ids: [],
            missing_evidence_to_decide: [],
          },
        ],
        recommendations: [
          {
            recommendation_id: 'rec-1',
            priority: 'high',
            confidence: { level: 'high', rationale: 'aligned signals', dimensions: strongDims },
            impact: 'material',
            statement: 'investigate the recent PostgreSQL SKU upgrade against workload telemetry',
            supported_by_hypothesis_ids: ['hyp-1'],
            supported_by_fact_ids: [],
            assumptions: ['baseline window is representative'],
            validation_steps: ['compare utilization metrics week-over-week'],
            false_positive_considerations: ['legitimate sustained workload growth'],
            suggested_audience: 'platform_engineer',
            suggested_human_actions: ['review the recent deployment timeline'],
          },
        ],
        data_quality: [],
      };

      const result = await runAnalysis({
        config,
        scope,
        transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
        model: new MockModelClient({ responses: reasoningResponse }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
        fixtureId: 'cost-surprise-001',
      });

      expect(result.reasoning.recommendations).toHaveLength(1);
      expect(result.score.passed_all).toBe(true);

      const md = await readFile(result.report_path, 'utf8');
      expect(md).toContain('# Az-Pixiu Cost-Surprise Report');
      expect(md).toContain('rec-1');

      const runJson = JSON.parse(await readFile(result.run_json_path, 'utf8')) as {
        schema_version: string;
        metadata: { fixture_id: string };
      };
      expect(runJson.schema_version).toBe('1');
      expect(runJson.metadata.fixture_id).toBe('cost-surprise-001');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('counts classified failures and surfaces them as run-level diagnostics', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-orc-'));
    try {
      const scope = intakeScope({
        subscription_id: subId,
        time_window_start: '2026-05-01T00:00:00Z',
        time_window_end: '2026-05-08T00:00:00Z',
        baseline_window_start: '2026-04-24T00:00:00Z',
        baseline_window_end: '2026-05-01T00:00:00Z',
      });
      // No resource_group_names → the playbook emits an
      // unrecorded-parameter query_resource_graph call. The fixture
      // doesn't match → FixtureNotFoundError → classified failure.
      const reasoningResponse: ReasoningOutput = {
        facts: [],
        hypotheses: [],
        recommendations: [],
        data_quality: [],
      };
      const result = await runAnalysis({
        config,
        scope,
        transport: new FixtureMCPTransport({ fixturePath: 'fixtures/cost-surprise-001' }),
        model: new MockModelClient({ responses: reasoningResponse }),
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });
      expect(result.failures_classified).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
