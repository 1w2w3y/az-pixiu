import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'azp-cli-analyze-'));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, AZ_PIXIU_INSTRUMENTATION: 'openinference' },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : -1,
    };
  }
}

describe('compiled-shape analyze CLI', () => {
  it('rejects --mock-model without --use-playbook before loading config or contacting AMG', async () => {
    const result = await runCli([
      'analyze',
      'cost-summary',
      '--mock-model',
      '--config',
      join(await makeTempDir(), 'missing-config.json'),
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'analyze --mock-model requires --use-playbook (the planner LLM is not mocked).',
    );
    expect(result.stdout).not.toContain('discovering');
  }, 40_000);

  it('runs fixture replay through the real CLI and writes complete waste-lane artefacts', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.json');
    const outputDir = join(dir, 'runs');
    await writeFile(
      configPath,
      JSON.stringify({
        foundry: {
          endpoint: 'https://example.openai.azure.com',
          deployment: 'mock-deployment',
        },
        amg: { endpoint: 'https://example.grafana.azure.com' },
      }),
    );

    const result = await runCli([
      'analyze',
      'cost-summary',
      '--fixture',
      'waste-orphan-ip',
      '--use-playbook',
      '--mock-model',
      '--credential',
      'mock',
      '--observability',
      'noop',
      '--no-billing-cache',
      '--config',
      configPath,
      '--output-dir',
      outputDir,
      '--subscription',
      '77777777-7777-7777-7777-777777777777',
      '--subscription',
      '88888888-8888-8888-8888-888888888888',
      '--from',
      '2026-05-01T00:00:00Z',
      '--to',
      '2026-05-08T00:00:00Z',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('waste-detection: 1 lane(s) ran, 5 candidate(s) surfaced');
    expect(result.stdout).toContain('Done. 1 recommendation(s).');

    const runDirectories = await readdir(outputDir, { withFileTypes: true });
    const runDirectory = runDirectories.find((entry) => entry.isDirectory());
    expect(runDirectory).toBeDefined();
    const runPath = join(outputDir, runDirectory!.name);
    const runJsonPath = join(runPath, 'run.json');
    const reportPath = join(runPath, 'report.md');
    const htmlPath = join(runPath, 'report.html');
    const runJson = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
      metadata: { status: string; fixture_id?: string; model_provider: string };
      scope: { analysis_type: string; subscription_ids: string[] };
      reasoning: { recommendations: unknown[] };
      waste_lanes: Array<{
        name: string;
        failed: boolean;
        unparsed_row_count: number;
        rejected_row_count: number;
        candidates: unknown[];
      }>;
    };

    expect(runJson.metadata).toMatchObject({
      status: 'success',
      fixture_id: 'waste-orphan-ip',
      model_provider: 'mock',
    });
    expect(runJson.scope.analysis_type).toBe('cost_summary');
    expect(runJson.scope.subscription_ids).toEqual([
      '77777777-7777-7777-7777-777777777777',
      '88888888-8888-8888-8888-888888888888',
    ]);
    expect(runJson.reasoning.recommendations).toHaveLength(1);
    expect(runJson.waste_lanes).toHaveLength(1);
    expect(runJson.waste_lanes[0]).toMatchObject({
      name: 'orphan_public_ip',
      failed: false,
      unparsed_row_count: 0,
      rejected_row_count: 0,
    });
    expect(runJson.waste_lanes[0]!.candidates).toHaveLength(5);

    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain('## Waste Candidates');
    expect(report).toContain('pip-test-vhx-inbound-001');
    expect(report).not.toContain('No matching resources.');
    expect((await stat(htmlPath)).size).toBeGreaterThan(0);
  }, 40_000);

  it('runs explicit subscriptions as independent sequential analyses', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.json');
    const outputDir = join(dir, 'runs');
    await writeFile(
      configPath,
      JSON.stringify({
        foundry: {
          endpoint: 'https://example.openai.azure.com',
          deployment: 'mock-deployment',
        },
        amg: { endpoint: 'https://example.grafana.azure.com' },
      }),
    );

    const subscriptions = [
      '77777777-7777-7777-7777-777777777777',
      '88888888-8888-8888-8888-888888888888',
    ];
    const result = await runCli([
      'analyze',
      'cost-summary',
      '--fixture',
      'waste-orphan-ip',
      '--serial-subscriptions',
      '--use-playbook',
      '--mock-model',
      '--credential',
      'mock',
      '--observability',
      'noop',
      '--no-billing-cache',
      '--config',
      configPath,
      '--output-dir',
      outputDir,
      '--subscription',
      subscriptions[0]!,
      '--subscription',
      subscriptions[1]!,
      '--from',
      '2026-05-01T00:00:00Z',
      '--to',
      '2026-05-08T00:00:00Z',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Serial subscription mode: 2 independent run(s); LLM concurrency=1.',
    );
    expect(result.stdout.indexOf(`[1/2] (${subscriptions[0]})`)).toBeLessThan(
      result.stdout.indexOf(`[2/2] (${subscriptions[1]})`),
    );
    expect(result.stdout).toContain('Serial batch complete: 2 subscription run(s).');

    const runDirectories = (await readdir(outputDir, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    expect(runDirectories).toHaveLength(2);
    const scopes = await Promise.all(
      runDirectories.map(async (entry) => {
        const runJson = JSON.parse(
          await readFile(join(outputDir, entry.name, 'run.json'), 'utf8'),
        ) as { scope: { subscription_ids: string[] } };
        return runJson.scope.subscription_ids;
      }),
    );
    expect(scopes.every((ids) => ids.length === 1)).toBe(true);
    expect(scopes.flat().sort()).toEqual([...subscriptions].sort());
  }, 40_000);
});
