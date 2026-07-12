import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCannedMockModelClient } from '../../src/evaluation/canned-mock.js';
import { loadDataset } from '../../src/evaluation/dataset.js';
import type {
  DatasetRunItemPayload,
  LangfusePublisher,
} from '../../src/evaluation/langfuse-publisher.js';
import { runEvaluation } from '../../src/evaluation/runner.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import type { CredentialIdentity } from '../../src/run/credential-factory.js';
import type { Config } from '../../src/schemas/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempDirs: string[] = [];
const plannerPrompt =
  'Az-Pixiu test planner prompt loaded from the selected prompt directory.\n';
const reasonerV1Prompt =
  'Az-Pixiu test v1 reasoner prompt loaded from the selected prompt directory.\n';
const reasonerV2Prompt =
  'Az-Pixiu Phase 3 candidate reasoner.v2 prompt selected from the custom root.\n';

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makePromptRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'azp-eval-prompts-'));
  tempDirs.push(root);
  await mkdir(join(root, 'prompts'), { recursive: true });
  await writeFile(
    join(root, 'prompts', 'planner.v1.md'),
    plannerPrompt,
  );
  await writeFile(
    join(root, 'prompts', 'reasoner.v1.md'),
    reasonerV1Prompt,
  );
  await writeFile(join(root, 'prompts', 'reasoner.v2.md'), reasonerV2Prompt);
  return root;
}

describe('eval prompt directory provenance', () => {
  it('accepts --prompts-dir, uses it for the eval, and prints the resolved prompt directory', async () => {
    const promptRoot = await makePromptRoot();
    const outputDir = await mkdtemp(join(tmpdir(), 'azp-eval-output-'));
    tempDirs.push(outputDir);
    const configPath = join(outputDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const phase3Dataset = await loadDataset('eval/phase-3-cost-reasoning.json');
    const datasetPath = join(outputDir, 'phase-3-prompt-root.json');
    await writeFile(
      datasetPath,
      JSON.stringify({ ...phase3Dataset, items: [phase3Dataset.items[0]!] }),
    );

    const result = await execFileAsync(
      process.execPath,
      [
        tsxCli,
        'src/cli.ts',
        'eval',
        datasetPath,
        '--use-playbook',
        '--mock-model',
        '--config',
        configPath,
        '--prompts-dir',
        promptRoot,
        '--output-dir',
        outputDir,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, AZ_PIXIU_INSTRUMENTATION: 'openinference' },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    expect(result.stdout).toContain(`prompts: ${resolve(promptRoot, 'prompts')}`);
    expect(result.stdout).toContain('PASS: 1/1 item(s) green');
  }, 70_000);

  it('selects reasoner.v2 and publishes stable prompt hashes without the local prompt path', async () => {
    const promptRoot = await makePromptRoot();
    const outputDir = await mkdtemp(join(tmpdir(), 'azp-eval-runner-output-'));
    tempDirs.push(outputDir);
    const runItems: DatasetRunItemPayload[] = [];
    const models: MockModelClient[] = [];
    const publisher = {
      ensureDataset: vi.fn(async () => undefined),
      upsertItem: vi.fn(async () => undefined),
      pushScores: vi.fn(async () => undefined),
      createRunItem: vi.fn(async (payload: DatasetRunItemPayload) => {
        runItems.push(payload);
      }),
    } as unknown as LangfusePublisher;

    const loadedDataset = await loadDataset('eval/phase-3-cost-reasoning.json');
    const result = await runEvaluation({
      dataset: { ...loadedDataset, items: [loadedDataset.items[0]!] },
      config,
      makeModel: () => {
        const model = buildCannedMockModelClient() as MockModelClient;
        models.push(model);
        return model;
      },
      modelProvider: 'mock',
      credentialIdentity,
      usePlaybook: true,
      runsDir: outputDir,
      observabilityMode: 'memory',
      promptsCwd: promptRoot,
      langfusePublisher: publisher,
      langfuseDatasetName: 'prompt-variant-test',
      langfuseRunName: 'prompt-variant-test.run-1',
      langfuseRunMetadata: { model_name: 'mock', variant: 'candidate-a' },
    });

    const expectedPromptDir = resolve(promptRoot, 'prompts');
    const plannerHash = `sha256:${createHash('sha256').update(plannerPrompt, 'utf8').digest('hex')}`;
    const reasonerHash = `sha256:${createHash('sha256').update(reasonerV2Prompt, 'utf8').digest('hex')}`;
    expect(result.prompts_dir).toBe(expectedPromptDir);
    expect(result.items[0]?.prompt_versions).toEqual({
      planner: 'planner.v1',
      reasoner: 'reasoner.v2',
    });
    expect(result.items[0]?.prompt_content_hashes).toEqual({
      planner: plannerHash,
      reasoner: reasonerHash,
    });
    const reasonerCall = models[0]?.calls.find((call) => call.schemaName === 'reasoner_output');
    expect(reasonerCall?.systemPrompt).toBe(reasonerV2Prompt);
    expect(runItems).toHaveLength(1);
    expect(runItems[0]?.metadata).toEqual({
      model_name: 'mock',
      variant: 'candidate-a',
      prompt_planner_version: 'planner.v1',
      prompt_reasoner_version: 'reasoner.v2',
      prompt_planner_content_sha256: plannerHash,
      prompt_reasoner_content_sha256: reasonerHash,
    });
    expect(runItems[0]?.metadata).not.toHaveProperty('prompts_dir');
  });
});
