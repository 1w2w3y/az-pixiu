import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAnalysis } from '../../src/run/orchestrator.js';
import { FixtureMCPTransport } from '../../src/mcp/fixture.js';
import { MCPClient } from '../../src/mcp/client.js';
import { buildCannedMockModelClient } from '../../src/evaluation/canned-mock.js';
import type { CapabilityCatalog, Config, Scope, ToolCallResult } from '../../src/schemas/index.js';
import type { MCPTransport } from '../../src/mcp/transport.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('waste-detection live contract through the orchestrator', () => {
  it('turns an incomplete lane enumeration into schema_mismatch DQ and never a clean no-match', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'azp-waste-contract-'));
    tempDirs.push(runsDir);
    const inner = new FixtureMCPTransport({ fixturePath: 'fixtures/cost-summary-001' });
    const client = new MCPClient({ transport: new MalformedLaneTransport(inner) });

    const result = await runAnalysis({
      config,
      scope,
      client,
      model: buildCannedMockModelClient(),
      modelProvider: 'mock',
      credentialIdentity: { implementation: 'MockCredential', identity: 'mock' },
      usePlaybook: true,
      runsDir,
      observabilityMode: 'noop',
      fixtureId: 'cost-summary-001-malformed-waste-lane',
    });

    const artifact = JSON.parse(await readFile(result.run_json_path, 'utf8')) as {
      metadata: { status: string };
      input_data_quality?: Array<{ category: string; affected_capability: string | null }>;
      waste_lanes?: Array<{
        name: string;
        candidates: unknown[];
        unparsed_row_count: number;
        rejected_row_count: number;
      }>;
    };
    expect(artifact.metadata.status).toBe('partial');
    expect(artifact.input_data_quality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'schema_mismatch',
          affected_capability: 'amgmcp_query_resource_graph',
        }),
      ]),
    );
    expect(artifact.waste_lanes?.[0]).toEqual(
      expect.objectContaining({
        name: 'orphan_public_ip',
        candidates: [],
        unparsed_row_count: 1,
        rejected_row_count: 0,
      }),
    );

    const markdown = await readFile(result.report_path, 'utf8');
    expect(markdown).toContain('Run outcome:** PARTIAL');
    expect(markdown).toContain('Enumeration incomplete');
    expect(markdown).not.toContain('_No matching resources in scope._');
  });
});

const config: Config = {
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'mock-deployment',
    deployment_sku: 'GlobalStandard',
    api_version: '2024-10-21',
  },
  amg: { endpoint: 'https://example.grafana.azure.com' },
};

const scope: Scope = {
  subscription_ids: ['33333333-3333-3333-3333-333333333333'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: 'one subscription',
};

class MalformedLaneTransport implements MCPTransport {
  constructor(private readonly inner: MCPTransport) {}

  listCapabilities(): Promise<CapabilityCatalog> {
    return this.inner.listCapabilities();
  }

  invoke(capability: string, parameters: Record<string, unknown>): Promise<ToolCallResult> {
    if (
      capability === 'amgmcp_query_resource_graph' &&
      String(parameters.query).includes("type =~ 'microsoft.network/publicipaddresses'")
    ) {
      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ data: ['row-without-domain-fields'], count: 1 }),
          },
        ],
      });
    }
    return this.inner.invoke(capability, parameters);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
