import { join, isAbsolute, resolve } from 'node:path';

import { FixtureMCPTransport } from '../mcp/fixture.js';
import { MCPClient } from '../mcp/client.js';
import { runAnalysis, type RunResult } from '../run/orchestrator.js';
import type {
  Config,
  PromptContentHashes,
  PromptVersions,
} from '../schemas/index.js';
import type { ModelClient } from '../model/client.js';
import type { CredentialIdentity } from '../run/credential-factory.js';
import type { ObservabilityMode } from '../observability/setup.js';
import type { AggregateScore } from './scoring.js';
import { checkExpectations, type ExpectationsAggregate } from './expectations.js';
import { loadDataset, fixturePathFor, type Dataset, type DatasetItem } from './dataset.js';
import { LangfusePublisher, LangfusePublishError, type ScorePayload } from './langfuse-publisher.js';

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
  /** Optional App Insights connection string used when observabilityMode is ms-otel. */
  applicationInsightsConnectionString?: string;
  /** Override the fixtures root. Defaults to 'fixtures'. */
  fixturesRoot?: string;
  /** Override prompts dir; mainly for tests. */
  promptsCwd?: string;
  /** Side-channel for streaming progress lines (CLI uses process.stdout). */
  onProgress?: (line: string) => void;
  /**
   * Optional Langfuse publisher. When set, the runner pushes per-rubric
   * and per-expectation Scores onto each run's Langfuse trace and links
   * the trace to a Langfuse Dataset Run (the "Experiment" view). When
   * unset, the runner behaves as before — local artefacts only.
   *
   * The runner does not construct the publisher itself; the CLI is the
   * place where the LANGFUSE_* env vars are read, so passing the
   * already-constructed instance keeps this module free of env coupling
   * and easy to test with a mock.
   */
  langfusePublisher?: LangfusePublisher;
  /**
   * Langfuse-side dataset name to publish under. Required when
   * {@link langfusePublisher} is set. Defaults to the dataset's local
   * basename (without extension) when the runner is reached via
   * {@link runEvaluationByPath}.
   */
  langfuseDatasetName?: string;
  /**
   * Run name for the Langfuse Dataset Run / Experiment. All items in
   * this invocation are grouped under this name so a sweep over models
   * produces one run-name per model, easily comparable side-by-side in
   * the Langfuse Experiment UI.
   */
  langfuseRunName?: string;
  /**
   * Optional metadata attached to each Dataset Run Item (e.g. model id,
   * git SHA). Surfaces in the Langfuse UI alongside each item's trace.
   */
  langfuseRunMetadata?: Record<string, unknown>;
}

export interface EvalItemResult {
  item_id: string;
  fixture_id: string;
  run_id: string;
  run_dir: string;
  report_path: string;
  /** OTel trace id of the agent run, when observability assigned one. Used by the Langfuse publisher. */
  otel_trace_id?: string;
  /** Stable prompt labels recorded by the analyzed run. Absent only when the item failed before loading prompts. */
  prompt_versions?: PromptVersions;
  /** Content-addressed prompt provenance. Absent for historical/error-only results. */
  prompt_content_hashes?: PromptContentHashes;
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
  /** True when Langfuse score / dataset-run-item publishing for this item failed; the run still counts otherwise. */
  langfuse_publish_error?: string;
}

export interface EvalRunnerResult {
  dataset_path?: string;
  /** Absolute prompt directory used by every item in this invocation. */
  prompts_dir: string;
  items: EvalItemResult[];
  passed_all: boolean;
  pass_count: number;
  fail_count: number;
}

export async function runEvaluation(options: EvalRunnerOptions): Promise<EvalRunnerResult> {
  const fixturesRoot = options.fixturesRoot ?? 'fixtures';
  const observabilityMode = options.observabilityMode ?? 'noop';
  const baseRunsDir = options.runsDir ?? 'runs/eval';

  if (options.langfusePublisher) {
    validateLangfuseOptions(options);
    // Ensure the dataset + all items exist server-side once per
    // invocation. Repeated invocations are idempotent (upsert on id).
    await prepareLangfuseDataset(options);
  }

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

    if (options.langfusePublisher && result.otel_trace_id && !result.error) {
      try {
        await publishItemToLangfuse(options, item, result);
        log(`  ↗ published scores + experiment to Langfuse`);
      } catch (err) {
        const msg = err instanceof LangfusePublishError
          ? err.message
          : err instanceof Error ? err.message : String(err);
        log(`  ⚠ Langfuse publish failed: ${msg}`);
        result.langfuse_publish_error = msg;
      }
    }

    items.push(result);
  }

  const pass_count = items.filter((i) => i.passed_all).length;
  return {
    prompts_dir: selectedPromptsDir(options),
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
      ...(options.applicationInsightsConnectionString
        ? { applicationInsightsConnectionString: options.applicationInsightsConnectionString }
        : {}),
      ...(options.promptsCwd ? { promptsCwd: options.promptsCwd } : {}),
      fixtureId: item.fixture_id,
    });

    // Reuse the orchestrator's score: it was computed against the exact
    // evidence universe the reasoner received. `result.evidence` also keeps
    // quarantined provenance for run.json, so rescoring that superset here
    // would make eval disagree with the analyzed run.
    const score = result.score;
    const expectations = checkExpectations({
      item,
      reasoning: result.reasoning,
      evidence: result.evidence,
      invoked_capabilities: result.invoked_capabilities,
      input_dq_categories: result.input_dq_categories,
      waste_lanes: result.waste_lanes,
    });

    return {
      item_id: item.id,
      fixture_id: item.fixture_id,
      run_id: result.run_id,
      run_dir: result.run_dir,
      report_path: result.report_path,
      ...(result.otel_trace_id ? { otel_trace_id: result.otel_trace_id } : {}),
      prompt_versions: result.metadata.prompt_versions,
      ...(result.metadata.prompt_content_hashes
        ? { prompt_content_hashes: result.metadata.prompt_content_hashes }
        : {}),
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

function validateLangfuseOptions(options: EvalRunnerOptions): void {
  if (!options.langfuseDatasetName || options.langfuseDatasetName.trim() === '') {
    throw new Error(
      'langfusePublisher requires langfuseDatasetName so items can be upserted into a named dataset.',
    );
  }
  if (!options.langfuseRunName || options.langfuseRunName.trim() === '') {
    throw new Error(
      'langfusePublisher requires langfuseRunName so each invocation creates a distinct Experiment.',
    );
  }
}

async function prepareLangfuseDataset(options: EvalRunnerOptions): Promise<void> {
  const publisher = options.langfusePublisher!;
  const datasetName = options.langfuseDatasetName!;
  await publisher.ensureDataset(datasetName, `Az-Pixiu eval dataset: ${datasetName}`);
  for (const item of options.dataset.items) {
    await publisher.upsertItem(datasetName, {
      id: item.id,
      input: {
        scope: item.scope,
        fixture_id: item.fixture_id,
      },
      expectedOutput: item.expectations ?? {},
      metadata: { description: item.description ?? '' },
    });
  }
}

/**
 * Push the per-rubric and per-expectation results as Langfuse Scores
 * onto the trace, then link the trace into the dataset run. We emit one
 * BOOLEAN score per rubric and per expectation so the Langfuse UI shows
 * a per-dimension column; the aggregate booleans (`passed_all`) ride on
 * top so a single sort lands the failing items at the top of the
 * Experiment view.
 */
async function publishItemToLangfuse(
  options: EvalRunnerOptions,
  item: DatasetItem,
  result: EvalItemResult,
): Promise<void> {
  const publisher = options.langfusePublisher!;
  const traceId = result.otel_trace_id!;
  const runName = options.langfuseRunName!;
  const datasetName = options.langfuseDatasetName!;

  const scores: ScorePayload[] = [];
  for (const r of result.score.results) {
    scores.push({
      traceId,
      name: `rubric.${r.rubric}`,
      value: r.passed ? 1 : 0,
      dataType: 'BOOLEAN',
      ...(r.details ? { comment: r.details } : {}),
    });
  }
  for (const e of result.expectations.results) {
    scores.push({
      traceId,
      name: `expectation.${e.expectation}`,
      value: e.passed ? 1 : 0,
      dataType: 'BOOLEAN',
      ...(e.details ? { comment: e.details } : {}),
    });
  }
  // Aggregates: cheap to attach, useful for filtering / charting.
  scores.push({
    traceId,
    name: 'rubric.passed_all',
    value: result.score.passed_all ? 1 : 0,
    dataType: 'BOOLEAN',
  });
  scores.push({
    traceId,
    name: 'expectation.passed_all',
    value: result.expectations.passed_all ? 1 : 0,
    dataType: 'BOOLEAN',
  });
  scores.push({
    traceId,
    name: 'eval.passed_all',
    value: result.passed_all ? 1 : 0,
    dataType: 'BOOLEAN',
  });

  await publisher.pushScores(scores);
  // A prompt root is useful to the local operator but is neither stable
  // across machines nor appropriate to export. Publish only version labels
  // and content hashes so experiments stay attributable without leaking a
  // workstation path.
  const stableRunMetadata = { ...(options.langfuseRunMetadata ?? {}) };
  delete stableRunMetadata.prompts_dir;
  await publisher.createRunItem({
    runName,
    datasetItemId: item.id,
    traceId,
    metadata: {
      ...stableRunMetadata,
      ...(result.prompt_versions
        ? {
            prompt_planner_version: result.prompt_versions.planner,
            prompt_reasoner_version: result.prompt_versions.reasoner,
          }
        : {}),
      ...(result.prompt_content_hashes
        ? {
            prompt_planner_content_sha256: result.prompt_content_hashes.planner,
            prompt_reasoner_content_sha256: result.prompt_content_hashes.reasoner,
          }
        : {}),
    },
  });
}

function selectedPromptsDir(options: EvalRunnerOptions): string {
  return resolve(options.promptsCwd ?? process.cwd(), 'prompts');
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
