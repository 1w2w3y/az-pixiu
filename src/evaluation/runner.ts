import { join, isAbsolute, resolve } from 'node:path';

import { FixtureMCPTransport } from '../mcp/fixture.js';
import { MCPClient } from '../mcp/client.js';
import { runAnalysis, type RunResult } from '../run/orchestrator.js';
import type { Config } from '../schemas/index.js';
import type { ModelClient } from '../model/client.js';
import type { CredentialIdentity } from '../run/credential-factory.js';
import type { ObservabilityMode } from '../observability/setup.js';
import { scoreAll, type AggregateScore } from './scoring.js';
import { checkExpectations, type ExpectationsAggregate } from './expectations.js';
import { loadDataset, fixturePathFor, type Dataset, type DatasetItem } from './dataset.js';

/**
 * Phase 1 step 12 eval runner. Iterates a dataset, replays each item
 * against its fixture, and combines the per-rubric scoring (§17 / step
 * 12) with the dataset-level expectations defined on each item.
 *
 * The runner is deliberately thin: it does not own a model client or a
 * credential — the caller supplies them. That keeps the runner usable
 * from the CLI (with real Foundry + AzureCliCredential), from tests
 * (with MockModelClient + a mock credential), and from future Phase 2
 * experimentation harnesses without entangling the runner with any of
 * those concerns.
 */

export interface EvalRunnerOptions {
  dataset: Dataset;
  config: Config;
  /**
   * Constructs a fresh ModelClient per dataset item. A factory (rather
   * than a single shared instance) keeps test mocks deterministic when
   * canned responses are sequence-based, and lets the CLI choose between
   * a real Foundry client and a mock without leaking the choice into
   * runner internals.
   */
  makeModel: (item: DatasetItem) => ModelClient;
  /** Provider name to record on RunMetadata. Matches CLI usage. */
  modelProvider: string;
  credentialIdentity: CredentialIdentity;
  /** Use the deterministic playbook in place of the planner LLM. */
  usePlaybook?: boolean;
  /**
   * Directory under which per-item run subdirs are written. Defaults to
   * `runs/eval/<dataset-id>/`. Each item writes a fresh `<runId>/`
   * underneath this (the orchestrator owns the inner naming).
   */
  runsDir?: string;
  /** Defaults to 'noop' so eval doesn't pollute the live trace store. */
  observabilityMode?: ObservabilityMode;
  /** Override the fixtures root. Defaults to 'fixtures'. */
  fixturesRoot?: string;
  /** Override prompts dir; mainly for tests. */
  promptsCwd?: string;
  /** Side-channel for streaming progress lines (CLI uses process.stdout). */
  onProgress?: (line: string) => void;
}

export interface EvalItemResult {
  item_id: string;
  fixture_id: string;
  run_id: string;
  run_dir: string;
  report_path: string;
  /** scoreAll across the four Phase 1 rubrics. */
  score: AggregateScore;
  /** Dataset-level expectations (`min_recommendations`, etc.). Empty results if the item had no expectations block. */
  expectations: ExpectationsAggregate;
  /**
   * Convenience: passed if every rubric passed AND every expectation
   * passed. The CLI uses this to compute its exit code.
   */
  passed_all: boolean;
  /** Error message when the item threw before scoring (fixture missing, credential rejected, …). */
  error?: string;
}

export interface EvalRunnerResult {
  dataset_path?: string;
  items: EvalItemResult[];
  passed_all: boolean;
  pass_count: number;
  fail_count: number;
}

export async function runEvaluation(options: EvalRunnerOptions): Promise<EvalRunnerResult> {
  const fixturesRoot = options.fixturesRoot ?? 'fixtures';
  const observabilityMode = options.observabilityMode ?? 'noop';
  const baseRunsDir = options.runsDir ?? 'runs/eval';

  const items: EvalItemResult[] = [];

  for (const item of options.dataset.items) {
    const log = (line: string): void => options.onProgress?.(line);
    log(`→ ${item.id} (fixture: ${item.fixture_id})`);

    const fixturePath = resolveFixturePath(fixturesRoot, item);
    let result: EvalItemResult;
    try {
      result = await runOne(item, fixturePath, baseRunsDir, observabilityMode, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ✖ runtime error: ${message}`);
      items.push({
        item_id: item.id,
        fixture_id: item.fixture_id,
        run_id: '',
        run_dir: '',
        report_path: '',
        score: { results: [], passed_all: false, pass_count: 0, fail_count: 0 },
        expectations: { results: [], passed_all: false, pass_count: 0, fail_count: 0 },
        passed_all: false,
        error: message,
      });
      continue;
    }

    const status = result.passed_all ? '✓' : '✖';
    log(
      `  ${status} rubrics ${result.score.pass_count}/${result.score.pass_count + result.score.fail_count}, ` +
        `expectations ${result.expectations.pass_count}/${result.expectations.pass_count + result.expectations.fail_count}`,
    );
    items.push(result);
  }

  const pass_count = items.filter((i) => i.passed_all).length;
  return {
    items,
    passed_all: items.every((i) => i.passed_all),
    pass_count,
    fail_count: items.length - pass_count,
  };
}

async function runOne(
  item: DatasetItem,
  fixturePath: string,
  baseRunsDir: string,
  observabilityMode: ObservabilityMode,
  options: EvalRunnerOptions,
): Promise<EvalItemResult> {
  const transport = new FixtureMCPTransport({ fixturePath });
  const client = new MCPClient({ transport });

  try {
    await client.discover();

    // Each item writes under runs/eval/<item-id>/<run-id>/. The
    // orchestrator owns the inner randomUUID so a re-run is never silent
    // about overwriting; intentional re-runs produce fresh subdirs.
    const runsDir = join(baseRunsDir, item.id);
    const result: RunResult = await runAnalysis({
      config: options.config,
      scope: item.scope,
      client,
      model: options.makeModel(item),
      modelProvider: options.modelProvider,
      credentialIdentity: options.credentialIdentity,
      usePlaybook: options.usePlaybook ?? false,
      runsDir,
      observabilityMode,
      ...(options.promptsCwd ? { promptsCwd: options.promptsCwd } : {}),
      fixtureId: item.fixture_id,
    });

    const score = scoreAll(result.reasoning);
    const expectations = checkExpectations({
      item,
      reasoning: result.reasoning,
      evidence: result.evidence,
      invoked_capabilities: result.evidence.map((e) => e.source_capability),
      input_dq_categories: result.input_dq_categories,
    });

    return {
      item_id: item.id,
      fixture_id: item.fixture_id,
      run_id: result.run_id,
      run_dir: result.run_dir,
      report_path: result.report_path,
      score,
      expectations,
      passed_all: score.passed_all && expectations.passed_all,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function resolveFixturePath(fixturesRoot: string, item: DatasetItem): string {
  const rel = fixturePathFor(item, fixturesRoot);
  return isAbsolute(rel) ? rel : resolve(process.cwd(), rel);
}

/**
 * Convenience wrapper: loads a dataset by path, then runs it. The CLI
 * uses this; tests usually call {@link runEvaluation} with an in-memory
 * dataset to avoid filesystem coupling.
 */
export async function runEvaluationByPath(
  datasetPath: string,
  options: Omit<EvalRunnerOptions, 'dataset'>,
): Promise<EvalRunnerResult> {
  const dataset = await loadDataset(datasetPath);
  const result = await runEvaluation({ ...options, dataset });
  return { ...result, dataset_path: datasetPath };
}
