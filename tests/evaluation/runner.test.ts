import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEvaluation, runEvaluationByPath } from '../../src/evaluation/runner.js';
import { buildCannedMockModelClient } from '../../src/evaluation/canned-mock.js';
import { loadDataset } from '../../src/evaluation/dataset.js';
import type { Config } from '../../src/schemas/index.js';
import type { CredentialIdentity } from '../../src/run/credential-factory.js';

const config: Config = {
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'mock-deployment',
    deployment_sku: 'GlobalStandard',
    api_version: '2024-10-21',
  },
  amg: { endpoint: 'https://example.grafana.azure.com' },
};

const credentialIdentity: CredentialIdentity = {
  implementation: 'MockCredential',
  identity: 'mock',
};

describe('runEvaluation — Phase 1 dataset against seeded fixtures (mock model + playbook)', () => {
  it('runs all three items and produces per-item rubric + expectations results', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-eval-runner-'));
    try {
      const dataset = await loadDataset('eval/phase-1.json');
      const result = await runEvaluation({
        dataset,
        config,
        makeModel: () => buildCannedMockModelClient(),
        modelProvider: 'mock',
        credentialIdentity,
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'noop',
      });

      expect(result.items).toHaveLength(3);

      const byId = Object.fromEntries(result.items.map((i) => [i.item_id, i]));

      // cost-surprise-001: clean run, expects tagging_gap. The normalizer
      // flags db-prod-2 as untagged (1/2 untagged = 50%, threshold ≥0.5).
      const surprise001 = byId['cost-surprise-001']!;
      expect(surprise001.error).toBeUndefined();
      expect(surprise001.score.passed_all).toBe(true);
      expect(surprise001.expectations.passed_all).toBe(true);
      expect(
        surprise001.expectations.results.find((r) => r.expectation === 'expected_dq_categories')
          ?.passed,
      ).toBe(true);

      // cost-surprise-002: activity_log fixture is a wrapped 403 →
      // normalizer emits authz_gap; rubrics still pass on the canned
      // reasoning.
      const surprise002 = byId['cost-surprise-002']!;
      expect(surprise002.error).toBeUndefined();
      expect(surprise002.score.passed_all).toBe(true);
      expect(surprise002.expectations.passed_all).toBe(true);

      // cost-summary-001: cost_summary analysis type end-to-end.
      const summary001 = byId['cost-summary-001']!;
      expect(summary001.error).toBeUndefined();
      expect(summary001.score.passed_all).toBe(true);
      expect(summary001.expectations.passed_all).toBe(true);

      expect(result.passed_all).toBe(true);
      expect(result.pass_count).toBe(3);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('runEvaluationByPath — convenience wrapper', () => {
  it('loads the dataset from disk and returns the same shape with dataset_path filled in', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'azp-eval-by-path-'));
    try {
      const result = await runEvaluationByPath('eval/cost-surprise-001.json', {
        config,
        makeModel: () => buildCannedMockModelClient(),
        modelProvider: 'mock',
        credentialIdentity,
        usePlaybook: true,
        runsDir: tmp,
        observabilityMode: 'noop',
      });

      expect(result.dataset_path).toBe('eval/cost-surprise-001.json');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.item_id).toBe('cost-surprise-001');
      expect(result.passed_all).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
