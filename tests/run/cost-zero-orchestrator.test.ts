import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MCPClient } from '../../src/mcp/client.js';
import type { MCPTransport } from '../../src/mcp/transport.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import { QUARANTINED_COST_SOURCE_CAPABILITY } from '../../src/run/cost-zero-assessment.js';
import { describeCredential } from '../../src/run/credential-factory.js';
import { runAnalysis } from '../../src/run/orchestrator.js';
import { intakeScope } from '../../src/run/scope-intake.js';
import type {
  CapabilityCatalog,
  Config,
  ReasoningOutput,
  ToolCallResult,
} from '../../src/schemas/index.js';

const SUB = '33333333-3333-3333-3333-333333333333';
const OTHER_SUB = '44444444-4444-4444-4444-444444444444';

const config: Config = {
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-5.4',
    deployment_sku: 'GlobalStandard',
    api_version: '2024-10-21',
  },
  amg: { endpoint: 'https://example.grafana.azure.com' },
};

class UnresolvedZeroTransport implements MCPTransport {
  private readonly catalogSource = new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' });

  listCapabilities(): Promise<CapabilityCatalog> {
    return this.catalogSource.listCapabilities();
  }

  async invoke(capability: string): Promise<ToolCallResult> {
    const payload =
      capability === 'amgmcp_query_azure_subscriptions'
        ? {
            subscriptions: [
              { subscriptionId: SUB, displayName: 'active-sub', resourceCount: 12 },
            ],
          }
        : capability === 'amgmcp_cost_analysis'
          ? {
              periodStart: '2026-06-01T00:00:00Z',
              periodEnd: '2026-07-01T00:00:00Z',
              subscriptions: [
                { subscriptionId: SUB, totalCost: 0, currency: 'USD', byService: [] },
              ],
            }
          : { data: [], count: 0 };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  async close(): Promise<void> {
    await this.catalogSource.close();
  }
}

class MissingTotalTransport extends UnresolvedZeroTransport {
  override async invoke(capability: string): Promise<ToolCallResult> {
    const payload =
      capability === 'amgmcp_query_azure_subscriptions'
        ? {
            subscriptions: [
              { subscriptionId: SUB, displayName: 'active-sub', resourceCount: 12 },
            ],
          }
        : capability === 'amgmcp_cost_analysis'
          ? {
              periodStart: '2026-06-01T00:00:00Z',
              periodEnd: '2026-07-01T00:00:00Z',
              subscriptions: [],
            }
          : { data: [], count: 0 };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }
}

class ScopeMismatchCostTransport extends UnresolvedZeroTransport {
  override async invoke(capability: string): Promise<ToolCallResult> {
    const payload =
      capability === 'amgmcp_query_azure_subscriptions'
        ? {
            subscriptions: [
              { subscriptionId: SUB, displayName: 'active-sub', resourceCount: 12 },
            ],
          }
        : capability === 'amgmcp_cost_analysis'
          ? {
              subscriptions: [
                {
                  subscriptionId: OTHER_SUB,
                  totalCost: 42,
                  currency: 'USD',
                  byService: [{ name: 'Storage', cost: 42 }],
                },
              ],
            }
          : { data: [], count: 0 };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }
}

const emptyReasoning: ReasoningOutput = {
  facts: [],
  hypotheses: [],
  recommendations: [],
  data_quality: [],
};

describe('runAnalysis suspicious-zero quarantine', () => {
  it('marks an unresolved zero partial, removes it from reasoner arithmetic, and preserves provenance', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-zero-orchestrator-'));
    try {
      const scope = intakeScope({
        subscription_ids: [SUB],
        time_window_start: '2026-06-01T00:00:00Z',
        time_window_end: '2026-07-01T00:00:00Z',
        analysis_type: 'cost_summary',
      });
      const model = new MockModelClient({ responses: emptyReasoning });
      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({ transport: new UnresolvedZeroTransport() }),
        model,
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      expect(result.cost_retrieval_outcome).toBe('partial');
      expect(result.metadata.status).toBe('partial');
      expect(result.input_dq_categories).toContain('zero_unresolved');
      expect(
        result.evidence.some(
          (record) => record.source_capability === QUARANTINED_COST_SOURCE_CAPABILITY,
        ),
      ).toBe(true);

      const reasonerCall = model.calls.find((call) => call.schemaName === 'reasoner_output');
      expect(reasonerCall?.userPrompt).not.toContain(QUARANTINED_COST_SOURCE_CAPABILITY);

      const report = await readFile(result.report_path, 'utf8');
      expect(report).toContain('Run outcome:** PARTIAL');
      expect(report).toContain('zero_unresolved');
      expect(report).not.toContain('**Total observed cost:** 0.00 USD');

      const artifact = JSON.parse(await readFile(result.run_json_path, 'utf8')) as {
        input_data_quality?: Array<{ category: string }>;
        evidence: Array<{ source_capability: string }>;
      };
      expect(artifact.input_data_quality?.some((finding) => finding.category === 'zero_unresolved')).toBe(true);
      expect(
        artifact.evidence.some(
          (record) => record.source_capability === QUARANTINED_COST_SOURCE_CAPABILITY,
        ),
      ).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('quarantines a missing aggregate instead of manufacturing authoritative zero cost', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-missing-total-'));
    try {
      const scope = intakeScope({
        subscription_ids: [SUB],
        time_window_start: '2026-06-01T00:00:00Z',
        time_window_end: '2026-07-01T00:00:00Z',
        analysis_type: 'cost_summary',
      });
      const model = new MockModelClient({ responses: emptyReasoning });
      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({ transport: new MissingTotalTransport() }),
        model,
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      expect(result.cost_retrieval_outcome).toBe('partial');
      expect(result.metadata.status).toBe('partial');
      expect(result.input_dq_categories).toContain('zero_unresolved');
      const quarantined = result.evidence.find(
        (record) => record.source_capability === QUARANTINED_COST_SOURCE_CAPABILITY,
      );
      expect(quarantined).toBeDefined();
      expect(
        (quarantined?.payload_summary as { total_cost?: number }).total_cost,
      ).toBeUndefined();

      const reasonerCall = model.calls.find((call) => call.schemaName === 'reasoner_output');
      expect(reasonerCall?.userPrompt).not.toContain(QUARANTINED_COST_SOURCE_CAPABILITY);
      const report = await readFile(result.report_path, 'utf8');
      expect(report).toContain('Run outcome:** PARTIAL');
      expect(report).not.toContain('**Total observed cost:** 0.00 USD');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('quarantines non-zero cost returned for a different subscription', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-cost-scope-mismatch-'));
    try {
      const scope = intakeScope({
        subscription_ids: [SUB],
        time_window_start: '2026-06-01T00:00:00Z',
        time_window_end: '2026-07-01T00:00:00Z',
        analysis_type: 'cost_summary',
      });
      const model = new MockModelClient({ responses: emptyReasoning });
      const result = await runAnalysis({
        config,
        scope,
        client: new MCPClient({ transport: new ScopeMismatchCostTransport() }),
        model,
        modelProvider: 'mock',
        credentialIdentity: describeCredential('mock'),
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'memory',
      });

      expect(result.metadata.status).toBe('partial');
      expect(result.input_dq_categories).toContain('cost_scope_mismatch');
      expect(
        result.evidence.some(
          (record) => record.source_capability === QUARANTINED_COST_SOURCE_CAPABILITY,
        ),
      ).toBe(true);
      const reasonerCall = model.calls.find((call) => call.schemaName === 'reasoner_output');
      expect(reasonerCall?.userPrompt).not.toContain(OTHER_SUB);
      const report = await readFile(result.report_path, 'utf8');
      expect(report).not.toContain('**Total observed cost:** 42.00 USD');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
