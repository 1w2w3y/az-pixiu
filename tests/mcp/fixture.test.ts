import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixtureMCPTransport,
  FixtureError,
  FixtureNotFoundError,
} from '../../src/mcp/fixture.js';
import { parameterDigest, shortDigest } from '../../src/mcp/digest.js';

interface FixtureSetup {
  capabilities?: unknown;
  responses?: Array<{
    capability: string;
    parameters: Record<string, unknown>;
    response: unknown;
    // For corruption tests:
    override_digest?: string;
    override_capability_in_file?: string;
  }>;
  /** Files to skip writing — used to set up missing-file scenarios. */
  skip?: Array<'capabilities'>;
}

async function withFixture(
  setup: FixtureSetup,
  fn: (fixturePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'azp-fx-'));
  try {
    await mkdir(join(root, 'responses'), { recursive: true });

    if (!setup.skip?.includes('capabilities')) {
      const caps = setup.capabilities ?? { capabilities: [] };
      await writeFile(join(root, 'capabilities.json'), JSON.stringify(caps, null, 2));
    }

    for (const r of setup.responses ?? []) {
      const digest = parameterDigest(r.parameters);
      const filename = `${r.capability}__${shortDigest(digest)}.json`;
      const payload = {
        capability: r.override_capability_in_file ?? r.capability,
        parameters: r.parameters,
        parameters_digest: r.override_digest ?? digest,
        response: r.response,
      };
      await writeFile(join(root, 'responses', filename), JSON.stringify(payload, null, 2));
    }

    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('FixtureMCPTransport — listCapabilities', () => {
  it('reads and parses the capabilities.json catalog', async () => {
    await withFixture(
      {
        capabilities: {
          capabilities: [
            { name: 'amgmcp_cost_analysis', version: '1.0.0', description: 'cost' },
            { name: 'amgmcp_query_resource_graph', version: '2.0.0' },
          ],
        },
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        const catalog = await t.listCapabilities();
        expect(catalog.capabilities).toHaveLength(2);
        expect(catalog.capabilities[0]?.name).toBe('amgmcp_cost_analysis');
        expect(catalog.capabilities[1]?.version).toBe('2.0.0');
      },
    );
  });

  it('caches the catalog on second call (same instance returned)', async () => {
    await withFixture({ capabilities: { capabilities: [{ name: 'a' }] } }, async (path) => {
      const t = new FixtureMCPTransport({ fixturePath: path });
      const first = await t.listCapabilities();
      const second = await t.listCapabilities();
      expect(second).toBe(first);
    });
  });

  it('throws FixtureError when capabilities.json is missing', async () => {
    await withFixture({ skip: ['capabilities'] }, async (path) => {
      const t = new FixtureMCPTransport({ fixturePath: path });
      await expect(t.listCapabilities()).rejects.toBeInstanceOf(FixtureError);
    });
  });

  it('throws FixtureError when capabilities.json is malformed JSON', async () => {
    await withFixture({ skip: ['capabilities'] }, async (path) => {
      await writeFile(join(path, 'capabilities.json'), '{ not json');
      const t = new FixtureMCPTransport({ fixturePath: path });
      await expect(t.listCapabilities()).rejects.toBeInstanceOf(FixtureError);
    });
  });

  it('throws FixtureError when capabilities.json fails schema validation', async () => {
    await withFixture({ capabilities: { capabilities: [{}] } }, async (path) => {
      // empty descriptor — name is required
      const t = new FixtureMCPTransport({ fixturePath: path });
      await expect(t.listCapabilities()).rejects.toBeInstanceOf(FixtureError);
    });
  });

  it('preserves passthrough fields not in the schema', async () => {
    await withFixture(
      {
        capabilities: {
          capabilities: [{ name: 'a', annotations: { mutating: false } }],
          server_version: '0.42.0',
        },
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        const catalog = await t.listCapabilities();
        expect((catalog as { server_version?: string }).server_version).toBe('0.42.0');
        const first = catalog.capabilities[0] as { annotations?: { mutating: boolean } };
        expect(first.annotations?.mutating).toBe(false);
      },
    );
  });
});

describe('FixtureMCPTransport — invoke', () => {
  const sampleParams = { subscription_id: 'abc', granularity: 'Daily' };
  const sampleResponse = { content: { rows: [['a', 1]] }, isError: false };

  it('returns the recorded response for matching parameters', async () => {
    await withFixture(
      {
        responses: [{ capability: 'amgmcp_cost_analysis', parameters: sampleParams, response: sampleResponse }],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        const result = await t.invoke('amgmcp_cost_analysis', sampleParams);
        expect(result.isError).toBe(false);
        expect(result.content).toEqual({ rows: [['a', 1]] });
      },
    );
  });

  it('matches regardless of parameter key order', async () => {
    await withFixture(
      {
        responses: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: { a: 1, b: 2 },
            response: { content: 'ok' },
          },
        ],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        const result = await t.invoke('amgmcp_cost_analysis', { b: 2, a: 1 });
        expect(result.content).toBe('ok');
      },
    );
  });

  it('throws FixtureNotFoundError when no fixture matches the parameters', async () => {
    await withFixture(
      {
        responses: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: { x: 1 },
            response: { content: 'unused' },
          },
        ],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        await expect(t.invoke('amgmcp_cost_analysis', { x: 2 })).rejects.toBeInstanceOf(
          FixtureNotFoundError,
        );
      },
    );
  });

  it('FixtureNotFoundError exposes the capability and digest', async () => {
    await withFixture({}, async (path) => {
      const t = new FixtureMCPTransport({ fixturePath: path });
      try {
        await t.invoke('unknown_capability', { p: 1 });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(FixtureNotFoundError);
        const e = err as FixtureNotFoundError;
        expect(e.capability).toBe('unknown_capability');
        expect(e.parametersDigest).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('throws FixtureError when the recorded digest does not match (corruption check)', async () => {
    await withFixture(
      {
        responses: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: sampleParams,
            response: sampleResponse,
            override_digest: '0'.repeat(64),
          },
        ],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        await expect(t.invoke('amgmcp_cost_analysis', sampleParams)).rejects.toBeInstanceOf(FixtureError);
      },
    );
  });

  it('throws FixtureError when the file capability does not match the call capability', async () => {
    await withFixture(
      {
        responses: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: sampleParams,
            response: sampleResponse,
            override_capability_in_file: 'wrong_capability',
          },
        ],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        await expect(t.invoke('amgmcp_cost_analysis', sampleParams)).rejects.toBeInstanceOf(FixtureError);
      },
    );
  });

  it('throws FixtureError when the recorded response fails ToolCallResultSchema', async () => {
    await withFixture(
      {
        responses: [
          {
            capability: 'amgmcp_cost_analysis',
            parameters: sampleParams,
            // missing content field
            response: { isError: false },
          },
        ],
      },
      async (path) => {
        const t = new FixtureMCPTransport({ fixturePath: path });
        // ToolCallResult.content is z.unknown() so missing field is treated
        // as undefined and accepted. Use a definitely-wrong shape instead:
        // make response a number, which is not an object.
        await rm(join(path, 'responses'), { recursive: true, force: true });
        await mkdir(join(path, 'responses'), { recursive: true });
        const digest = parameterDigest(sampleParams);
        const filename = `cost_analysis__${shortDigest(digest)}.json`;
        await writeFile(
          join(path, 'responses', filename),
          JSON.stringify({
            capability: 'amgmcp_cost_analysis',
            parameters: sampleParams,
            parameters_digest: digest,
            response: 42, // not an object
          }),
        );
        await expect(t.invoke('amgmcp_cost_analysis', sampleParams)).rejects.toBeInstanceOf(FixtureError);
      },
    );
  });

  it('close() resolves without error', async () => {
    await withFixture({}, async (path) => {
      const t = new FixtureMCPTransport({ fixturePath: path });
      await expect(t.close()).resolves.toBeUndefined();
    });
  });
});

describe('FixtureMCPTransport — against the seeded cost-surprise-001 fixture', () => {
  // Integration test against the real seeded fixture (committed to the repo).
  // Confirms the seed script and the transport agree on the digest format.
  const FIXTURE_PATH = 'fixtures/cost-surprise-001';

  it('lists all 7 Phase 1 capabilities', async () => {
    const t = new FixtureMCPTransport({ fixturePath: FIXTURE_PATH });
    const catalog = await t.listCapabilities();
    const names = catalog.capabilities.map((c) => c.name);
    expect(names).toEqual([
      'amgmcp_query_azure_subscriptions',
      'amgmcp_cost_analysis',
      'amgmcp_query_resource_graph',
      'amgmcp_query_resource_metric_definition',
      'amgmcp_query_resource_metric',
      'amgmcp_query_activity_log',
      'amgmcp_query_resource_health',
    ]);
  });

  it('returns the recorded cost_analysis response for the analysis window', async () => {
    const t = new FixtureMCPTransport({ fixturePath: FIXTURE_PATH });
    const result = await t.invoke('amgmcp_cost_analysis', {
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      startTime: '2026-05-01T00:00:00Z',
      endTime: '2026-05-08T00:00:00Z',
    });
    expect(result.isError).toBe(false);
    const content = result.content as { total: { cost: number } };
    expect(content.total.cost).toBeGreaterThan(0);
  });

  it('returns a different recorded cost_analysis response for the baseline window', async () => {
    const t = new FixtureMCPTransport({ fixturePath: FIXTURE_PATH });
    const result = await t.invoke('amgmcp_cost_analysis', {
      subscriptionId: '11111111-1111-1111-1111-111111111111',
      startTime: '2026-04-24T00:00:00Z',
      endTime: '2026-05-01T00:00:00Z',
    });
    expect(result.isError).toBe(false);
  });

  it('throws FixtureNotFoundError for an unrecorded parameter combination', async () => {
    const t = new FixtureMCPTransport({ fixturePath: FIXTURE_PATH });
    await expect(
      t.invoke('amgmcp_cost_analysis', { subscription_id: 'different', granularity: 'Hourly' }),
    ).rejects.toBeInstanceOf(FixtureNotFoundError);
  });
});
