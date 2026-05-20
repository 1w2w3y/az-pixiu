import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunArtifact, buildRunArtifact, RUN_JSON_SCHEMA_VERSION } from '../../src/report/runjson.js';
import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  DataQualityFinding,
} from '../../src/schemas/index.js';

const subId = '11111111-1111-1111-1111-111111111111';
const scope: Scope = {
  subscription_ids: [subId],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: 'one sub',
};

const metadata: RunMetadata = {
  run_id: '22222222-2222-2222-2222-222222222222',
  trace_id: 'trace-abc',
  prompt_versions: { planner: 'planner.v1', reasoner: 'reasoner.v1' },
  model_provider: 'foundry',
  model_name: 'gpt-5.4',
  model_config_hash: 'abc12345',
  model_deployment_sku: 'GlobalStandard',
  credential_source: { implementation: 'AzureCliCredential', identity: 'op@example.com' },
  amg_mcp_endpoint: 'https://amg.example.com',
  capability_versions: {},
  started_at: '2026-05-18T12:00:00Z',
  status: 'success',
};

const reasoning: ReasoningOutput = {
  facts: [],
  hypotheses: [],
  recommendations: [],
  data_quality: [],
};

const evidence: EvidenceRecord[] = [];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'azp-run-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('buildRunArtifact', () => {
  it('wraps the four sub-objects with schema_version', () => {
    const a = buildRunArtifact(metadata, scope, evidence, reasoning);
    expect(a.schema_version).toBe(RUN_JSON_SCHEMA_VERSION);
    expect(a.metadata).toBe(metadata);
    expect(a.scope).toBe(scope);
    expect(a.evidence).toBe(evidence);
    expect(a.reasoning).toBe(reasoning);
    expect(a.input_data_quality).toBeUndefined();
  });

  it('persists input_data_quality (pre-reasoner findings) when supplied', () => {
    const inputDq: DataQualityFinding[] = [
      {
        dq_id: 'dq-1',
        category: 'tagging_gap',
        affected_capability: 'amgmcp_query_resource_graph',
        affected_scope_subset: null,
        consequence_for_analysis: 'half the inventoried resources lack tags',
        impact_on_recommendations: [],
        actionable_hint: 'apply a tagging policy',
      },
    ];
    const a = buildRunArtifact(metadata, scope, evidence, reasoning, inputDq);
    expect(a.input_data_quality).toEqual(inputDq);
  });

  it('omits input_data_quality when the array is empty', () => {
    const a = buildRunArtifact(metadata, scope, evidence, reasoning, []);
    expect(a.input_data_quality).toBeUndefined();
  });
});

describe('writeRunArtifact', () => {
  it('writes the JSON file and returns the absolute path', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'run.json');
      const written = await writeRunArtifact({
        path,
        artifact: buildRunArtifact(metadata, scope, evidence, reasoning),
      });
      expect(written).toBe(path);
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.schema_version).toBe(RUN_JSON_SCHEMA_VERSION);
      expect(parsed.metadata.run_id).toBe(metadata.run_id);
    });
  });

  it('creates intermediate directories under runs/', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'runs', 'r-123', 'run.json');
      await writeRunArtifact({ path, artifact: buildRunArtifact(metadata, scope, evidence, reasoning) });
      const entries = await readdir(join(dir, 'runs', 'r-123'));
      expect(entries).toContain('run.json');
    });
  });

  it('atomic mode leaves no .tmp file after success', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'run.json');
      await writeRunArtifact({ path, artifact: buildRunArtifact(metadata, scope, evidence, reasoning) });
      const entries = await readdir(dir);
      expect(entries.every((e) => !e.includes('.tmp-'))).toBe(true);
    });
  });

  it('non-atomic mode writes directly', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'run.json');
      await writeRunArtifact({
        path,
        artifact: buildRunArtifact(metadata, scope, evidence, reasoning),
        atomic: false,
      });
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.schema_version).toBe(RUN_JSON_SCHEMA_VERSION);
    });
  });
});
