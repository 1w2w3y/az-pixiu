import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemRunHistoryStore } from '../../src/history/filesystem-store.js';
import { computeScopeSignature } from '../../src/run/scope-signature.js';
import type { RunArtifact } from '../../src/report/runjson.js';

const subId = '11111111-1111-1111-1111-111111111111';

const baseScope: RunArtifact['scope'] = {
  subscription_ids: [subId],
  resource_group_names: ['rg-a'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: '1 sub, 1 rg',
};

const strongDims = {
  evidence_coverage: 'strong' as const,
  signal_quality: 'strong' as const,
  signal_agreement: 'aligned' as const,
};

function makeArtifact(overrides: {
  run_id: string;
  started_at: string;
  scope?: RunArtifact['scope'];
  recommendation_signature?: string;
}): RunArtifact {
  const scope = overrides.scope ?? baseScope;
  return {
    schema_version: '1',
    metadata: {
      run_id: overrides.run_id,
      trace_id: `run-${overrides.run_id}`,
      prompt_versions: { planner: 'planner.v1', reasoner: 'reasoner.v1' },
      model_provider: 'mock',
      model_name: 'mock-1',
      model_config_hash: 'abc12345',
      credential_source: { implementation: 'MockCredential', identity: 'test' },
      amg_mcp_endpoint: 'https://example.grafana.azure.com',
      capability_versions: {},
      started_at: overrides.started_at,
      status: 'success',
    },
    scope,
    evidence: [],
    reasoning: {
      facts: [
        {
          fact_id: 'fact-1',
          statement: 'observed condition',
          evidence_ids: ['ev-1'],
          scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
        },
      ],
      hypotheses: [],
      recommendations: [
        {
          recommendation_id: 'rec-1',
          priority: 'high',
          confidence: { level: 'high', rationale: 'aligned', dimensions: strongDims },
          impact: 'material',
          statement: `consider reviewing in ${overrides.run_id}`,
          supported_by_hypothesis_ids: [],
          supported_by_fact_ids: ['fact-1'],
          assumptions: [],
          validation_steps: ['inspect the evidence'],
          false_positive_considerations: [],
          suggested_audience: 'platform_engineer',
          suggested_human_actions: ['review the prior signal'],
          recommendation_signature:
            overrides.recommendation_signature ?? 'restored-pg-cleanup-eus2',
        },
      ],
      data_quality: [],
    },
  };
}

async function writeRun(
  runsDir: string,
  artifact: RunArtifact,
  subdirPath: readonly string[] = [],
): Promise<void> {
  const runDir = join(runsDir, ...subdirPath, artifact.metadata.run_id);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
}

describe('FilesystemRunHistoryStore', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'azp-history-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns [] when the runs directory does not exist', async () => {
    const store = new FilesystemRunHistoryStore({ runsDir: join(tmp, 'does-not-exist') });
    const result = await store.findPriorRuns({
      scope_signature: 'whatever',
      analysis_type: 'cost_summary',
    });
    expect(result).toEqual([]);
  });

  it('returns matching runs in descending started_at order', async () => {
    const sig = computeScopeSignature(baseScope);
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000002', started_at: '2026-05-08T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000003', started_at: '2026-05-15T00:00:00Z' }),
    );

    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: sig,
      analysis_type: 'cost_summary',
    });
    expect(result.map((r) => r.run_id)).toEqual([
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
    ]);
  });

  it('filters out runs against a different scope', async () => {
    const otherScope: RunArtifact['scope'] = {
      ...baseScope,
      subscription_ids: ['99999999-9999-9999-9999-999999999999'],
    };
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({
        run_id: '00000000-0000-0000-0000-000000000002',
        started_at: '2026-05-02T00:00:00Z',
        scope: otherScope,
      }),
    );

    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const matched = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.run_id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('filters out runs of a different analysis_type', async () => {
    const surpriseScope: RunArtifact['scope'] = {
      ...baseScope,
      analysis_type: 'cost_surprise',
      baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
    };
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({
        run_id: '00000000-0000-0000-0000-000000000002',
        started_at: '2026-05-02T00:00:00Z',
        scope: surpriseScope,
      }),
    );

    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const summary = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(summary).toHaveLength(1);
    expect(summary[0]?.run_id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('honours limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await writeRun(
        tmp,
        makeArtifact({
          run_id: `00000000-0000-0000-0000-00000000000${i}`,
          started_at: `2026-05-0${i}T00:00:00Z`,
        }),
      );
    }
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
      limit: 2,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.started_at).toBe('2026-05-05T00:00:00Z');
  });

  it('honours startedAtMin', async () => {
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-04-01T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000002', started_at: '2026-05-08T00:00:00Z' }),
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
      startedAtMin: '2026-05-01T00:00:00Z',
    });
    expect(result.map((r) => r.run_id)).toEqual(['00000000-0000-0000-0000-000000000002']);
  });

  it('excludes the current run id', async () => {
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
    );
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000002', started_at: '2026-05-08T00:00:00Z' }),
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
      excludeRunId: '00000000-0000-0000-0000-000000000002',
    });
    expect(result.map((r) => r.run_id)).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('walks one level deep so eval-runner runs are included', async () => {
    // Eval runner layout: `runs/eval/<item-id>/<run-id>/run.json`.
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
      ['eval', 'cost-summary-001'],
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(result).toHaveLength(1);
  });

  it('skips malformed run.json without throwing', async () => {
    await mkdir(join(tmp, 'bad'), { recursive: true });
    await writeFile(join(tmp, 'bad', 'run.json'), 'not valid json', 'utf8');
    await writeRun(
      tmp,
      makeArtifact({ run_id: '00000000-0000-0000-0000-000000000001', started_at: '2026-05-01T00:00:00Z' }),
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(result).toHaveLength(1);
  });

  it('surfaces recommendation_signature in the summary', async () => {
    await writeRun(
      tmp,
      makeArtifact({
        run_id: '00000000-0000-0000-0000-000000000001',
        started_at: '2026-05-01T00:00:00Z',
        recommendation_signature: 'orphan-ip-cleanup-liftrtools',
      }),
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(result[0]?.recommendations[0]?.recommendation_signature).toBe(
      'orphan-ip-cleanup-liftrtools',
    );
  });

  it('omits transport_rollup for artefacts without transport_summary (back-compat)', async () => {
    await writeRun(
      tmp,
      makeArtifact({
        run_id: '00000000-0000-0000-0000-000000000001',
        started_at: '2026-05-01T00:00:00Z',
      }),
    );
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    expect(result[0]?.transport_rollup).toBeUndefined();
  });

  it('rolls up transport_summary entries when present on the artefact', async () => {
    const artifact = makeArtifact({
      run_id: '00000000-0000-0000-0000-000000000002',
      started_at: '2026-05-02T00:00:00Z',
    });
    artifact.transport_summary = [
      {
        logical_request_id: 'req-1',
        capability: 'amgmcp_cost_analysis',
        scope_subset: null,
        parameters_digest: 'a'.repeat(64),
        attempt_count: 1,
        retry_count: 0,
        final_outcome: 'success',
        pacing_applied: false,
        cumulative_backoff_ms: 0,
      },
      {
        logical_request_id: 'req-2',
        capability: 'amgmcp_cost_analysis',
        scope_subset: null,
        parameters_digest: 'b'.repeat(64),
        attempt_count: 1,
        retry_count: 0,
        final_outcome: 'rate_limit',
        failure_category: 'rate_limit',
        pacing_applied: false,
        cumulative_backoff_ms: 0,
      },
    ];
    await writeRun(tmp, artifact);
    const store = new FilesystemRunHistoryStore({ runsDir: tmp });
    const result = await store.findPriorRuns({
      scope_signature: computeScopeSignature(baseScope),
      analysis_type: 'cost_summary',
    });
    const rollup = result[0]?.transport_rollup;
    expect(rollup?.total_calls).toBe(2);
    expect(rollup?.exhausted_count).toBe(1);
    expect(rollup?.rate_limit_seen).toBe(true);
    expect(rollup?.by_capability.amgmcp_cost_analysis?.calls).toBe(2);
  });
});
