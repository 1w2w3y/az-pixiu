import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MCPClient, assertRequiredCapabilities } from '../mcp/client.js';
import { EvidenceExecutor } from '../evidence/executor.js';
import { EvidenceNormalizer } from '../evidence/normalizer.js';
import { Planner } from '../reasoning/planner.js';
import { Reasoner } from '../reasoning/reasoner.js';
import type { ModelClient } from '../model/client.js';
import { modelConfigHash } from '../model/client.js';
import { renderMarkdownReport } from '../report/markdown.js';
import { buildRunArtifact, writeRunArtifact } from '../report/runjson.js';
import {
  propagateAttributes,
  setActiveTraceIO,
  updateActiveObservation,
} from '@langfuse/tracing';
import {
  initializeTracing,
  shutdownTracing,
  currentInstrumentationFlavor,
  type ObservabilityMode,
} from '../observability/setup.js';
import {
  withSpan,
  emitEvent,
  SpanNames,
  ATTR,
} from '../observability/spans.js';
import { costSurprisePlaybook } from '../playbooks/cost-surprise.js';
import { costSummaryPlaybook } from '../playbooks/cost-summary.js';
import { loadPrompt, type LoadedPrompt } from '../prompts/loader.js';
import { scoreAll, type AggregateScore } from '../evaluation/scoring.js';
import type { ScorePayload } from '../evaluation/langfuse-publisher.js';
import {
  discoverTopSubscriptions,
  formatSubscription,
} from './subscription-discovery.js';
import { intakeScope, type ScopeIntakeInput } from './scope-intake.js';
import { computeScopeSignature } from './scope-signature.js';
import { buildPriorRunContextEvidence } from './prior-run-evidence.js';
import { checkFreshness } from './freshness.js';
import { WasteDetectionExecutor } from './waste-detection.js';
import { getEnabledWasteLanes } from '../playbooks/waste-lanes/registry.js';
import { JsonFileRateSource } from '../pricing/json-file-rate-source.js';
import type { PricingRateSource } from '../pricing/source.js';
import { NoopRunHistoryStore, type RunHistoryStore } from '../history/store.js';
import {
  rollupTransportSummary,
  runOutcomeFromRollup,
} from '../schemas/transport.js';
import type {
  Config,
  Scope,
  EvidencePlan,
  EvidenceRecord,
  RunMetadata,
  ReasoningOutput,
  DataQualityFinding,
  DataQualityCategory,
  AnalysisType,
} from '../schemas/index.js';
import { DataQualityFindingSchema } from '../schemas/index.js';
import type { ClassifiedFailure } from '../failure/taxonomy.js';
import type { CredentialIdentity } from './credential-factory.js';

export interface RunOptions {
  config: Config;
  /**
   * Pre-resolved scope. Either this or {@link discoverSubscriptions}
   * must be set. Tests and explicit-subscription CLI invocations supply
   * `scope` directly; auto-discovery from the CLI supplies
   * `discoverSubscriptions` instead and the orchestrator builds the
   * scope inside RunRoot, after discovery, so the discovery span is
   * part of the same Langfuse trace as the analysis it feeds.
   */
  scope?: Scope;
  /**
   * Run AMG-MCP subscription auto-discovery as the first child of
   * RunRoot, then build the scope from the discovered subscription ids
   * plus {@link DiscoverSubscriptionsOption.scopeIntake}. Mutually
   * exclusive with {@link RunOptions.scope}.
   */
  discoverSubscriptions?: DiscoverSubscriptionsOption;
  /**
   * MCPClient with its transport already constructed. The orchestrator
   * calls .discover() on it (idempotent — caches), so callers may call
   * discover() ahead of time (e.g., for subscription auto-discovery)
   * and pass the same client through; the second discover() returns the
   * cached catalog without a network round trip.
   */
  client: MCPClient;
  model: ModelClient;
  modelProvider: string;
  credentialIdentity: CredentialIdentity;
  /** Use the deterministic playbook instead of the planner LLM. */
  usePlaybook?: boolean;
  /** Custom prompts directory for tests; defaults to the repo `prompts/`. */
  promptsCwd?: string;
  /** Output directory for `<run_id>/` subdir; defaults to `runs/`. */
  runsDir?: string;
  /** Observability mode; defaults to 'memory' (no external export). */
  observabilityMode?: ObservabilityMode;
  /** Fixture id if running against a fixture transport. */
  fixtureId?: string;
  /**
   * Optional Langfuse score publisher. Normal CLI runs pass this when
   * observability is `langfuse`; tests pass a fake. Publishing failures
   * are warnings only and never change the analysis result.
   */
  langfusePublisher?: AnalyzeScorePublisher;
  /**
   * Cross-run continuity store (Phase 2.5 — design/cost-summary-depth.md
   * §Gap 5). When supplied, the orchestrator queries it for prior runs
   * against the same scope_signature and analysis_type, and injects a
   * synthetic `prior_run_context` EvidenceRecord into the reasoner's
   * input. Defaults to a no-op store so offline / mock-model / test
   * paths see no behaviour change unless the operator opts in.
   */
  runHistoryStore?: RunHistoryStore;
  /**
   * Pricing rate source for the waste-detection executor (Phase 3 —
   * design/cost-summary-depth.md §Gap 1/§Gap 3). When supplied, used
   * directly; when omitted, the orchestrator loads the seed JSON card
   * at `pricing/azure-rate-card.json` lazily on the first cost_summary
   * run. Tests inject a mock rate source so they do not touch disk.
   */
  rateSource?: PricingRateSource;
  /**
   * Disable the waste-detection executor even on `cost_summary` runs.
   * Tests use this to keep the cost-summary path identical to its
   * pre-Phase-3 shape. Defaults to false (lanes run for cost_summary).
   */
  disableWasteDetection?: boolean;
}

export interface AnalyzeScorePublisher {
  pushScores(scores: ScorePayload[]): Promise<void>;
}

export interface DiscoverSubscriptionsOption {
  /** Max top-N subscriptions to select by resource count. */
  maxSubscriptions: number;
  /**
   * Optional case-insensitive substring filter applied to the
   * subscription *display name* before the top-N-by-resource-count
   * selection. When set, subscriptions without a display name are
   * excluded (no name to match against). Available for any analysis
   * type that auto-discovers subscriptions.
   */
  nameFilter?: string;
  /**
   * Scope-intake input minus `subscription_ids`. The orchestrator fills
   * in `subscription_ids` from the discovery result and calls
   * `intakeScope` to build the final {@link Scope}.
   */
  scopeIntake: Omit<ScopeIntakeInput, 'subscription_ids'>;
}

export interface RunResult {
  run_id: string;
  run_dir: string;
  report_path: string;
  run_json_path: string;
  /**
   * Agent-side logical trace identifier (`run-<run_id>`). Stable across
   * observability modes; written into RunMetadata.trace_id. Note this is
   * NOT the OTel/Langfuse trace ID — see {@link RunResult.otel_trace_id}.
   */
  trace_id: string;
  /**
   * The OpenTelemetry trace ID (32 hex chars) of the RunRoot span, when
   * observability was active enough to assign one. This is the ID under
   * which Langfuse stored the trace; downstream consumers (eval-time
   * score publishing, experiment grouping) must attach by this ID, not
   * by {@link RunResult.trace_id}.
   */
  otel_trace_id?: string;
  metadata: RunMetadata;
  reasoning: ReasoningOutput;
  /**
   * Normalized EvidenceRecords as they were handed to the reasoner. Useful
   * to downstream consumers (eval runner) that need to inspect which
   * capabilities actually produced evidence without round-tripping through
   * run.json.
   */
  evidence: EvidenceRecord[];
  /**
   * DataQualityCategory values surfaced to the pipeline before the
   * reasoner sees them (normalizer findings + failure-taxonomy findings).
   * Distinct from {@link reasoning}.data_quality, which is what the
   * reasoner chose to emit on its own output. The eval runner checks
   * `expected_dq_categories` against this *plus* the reasoner output so
   * the assertion holds whether or not the reasoner echoed the input
   * findings forward.
   */
  input_dq_categories: DataQualityCategory[];
  score: AggregateScore;
  failures_classified: number;
  /** Whether any §7.5 post-process issues were synthesized. */
  post_process_issues: number;
}

/**
 * The runtime entry point that wires every Phase 1 component together
 * (design §7). Mirrors the §22 end-to-end sequencing:
 *   config → scope intake → tracing → mcp discovery → plan
 *   → execute → normalize → reason → score → render → write artifacts.
 *
 * Each subspan emits the §14 vocabulary. `mutating_capabilities_excluded`
 * is emitted as a span event on the discovery span when AMG-MCP
 * advertises any capability matching the deny patterns.
 */
export async function runAnalysis(options: RunOptions): Promise<RunResult> {
  if (!options.scope && !options.discoverSubscriptions) {
    throw new Error(
      'runAnalysis: either `scope` or `discoverSubscriptions` must be set.',
    );
  }
  if (options.scope && options.discoverSubscriptions) {
    throw new Error(
      'runAnalysis: `scope` and `discoverSubscriptions` are mutually exclusive.',
    );
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const runsDir = options.runsDir ?? 'runs';
  const runDir = join(runsDir, runId);
  const reportPath = join(runDir, 'report.md');
  const runJsonPath = join(runDir, 'run.json');

  const observabilityMode = options.observabilityMode ?? 'memory';
  await initializeTracing({ mode: observabilityMode });

  // Analysis type is known up front from either input — used for tags
  // and traceName so the trace is filterable from the moment RunRoot
  // opens, even if the scope itself is still being discovered.
  const analysisType: AnalysisType =
    options.scope?.analysis_type ??
    options.discoverSubscriptions?.scopeIntake.analysis_type ??
    'cost_surprise';

  // Operator transparency (design §4.2): echo what is about to happen.
  process.stdout.write(`Az-Pixiu run ${runId}\n`);
  if (options.scope) {
    process.stdout.write(`  scope: ${options.scope.effective_scope_summary}\n`);
  } else {
    process.stdout.write(
      `  scope: (auto-discovering top ${options.discoverSubscriptions!.maxSubscriptions} subscription(s); analysis_type=${analysisType})\n`,
    );
  }
  process.stdout.write(`  amg_mcp_endpoint: ${options.config.amg.endpoint}\n`);
  const modelInfo = resolveModelInfo(options.config);
  process.stdout.write(
    `  model: ${modelInfo.provider}/${modelInfo.modelName} @ ${modelInfo.endpoint}` +
      `${modelInfo.deploymentSku ? ` (sku=${modelInfo.deploymentSku})` : ''}\n`,
  );
  process.stdout.write(
    `  credential: ${options.credentialIdentity.implementation} (${options.credentialIdentity.identity})\n`,
  );
  const instrumentationFlavor = currentInstrumentationFlavor();
  process.stdout.write(`  observability: ${observabilityMode}\n`);
  process.stdout.write(`  instrumentation: ${instrumentationFlavor}\n`);

  const traceId = `run-${runId}`;

  // Trace-level attributes that should ride down into every child span
  // and surface on the Langfuse trace itself (Langfuse skill baseline
  // §"Discover Additional Context Needs"):
  //   - traceName: `analyze.<type>` so traces are filterable by analysis
  //   - userId:    Azure account identity (the natural "actor")
  //   - sessionId: AMG endpoint (groups every run that hit the same
  //                Grafana instance — useful when comparing across
  //                tenants/environments)
  //   - tags:      analysis_type + 'fixture' when running offline, so
  //                the UI can filter offline vs live runs
  const tags = [`analysis:${analysisType}`];
  if (options.fixtureId) tags.push('fixture');

  let otelTraceId: string | undefined;
  try {
    const result = await withSpan(
      SpanNames.RunRoot,
      async (rootSpan) => {
        const ctx = rootSpan.spanContext();
        if (ctx.traceId && ctx.traceId !== '0'.repeat(32)) {
          otelTraceId = ctx.traceId;
        }
        return propagateAttributes(
          {
            traceName: `analyze.${analysisType}`,
            userId: options.credentialIdentity.identity,
            sessionId: options.config.amg.endpoint,
            tags,
            metadata: {
              run_id: runId,
              amg_mcp_endpoint: options.config.amg.endpoint,
              model_deployment: modelInfo.modelName,
              ...(modelInfo.deploymentSku
                ? { model_deployment_sku: modelInfo.deploymentSku }
                : {}),
              credential_source: options.credentialIdentity.implementation,
              instrumentation_flavor: instrumentationFlavor,
              ...(options.fixtureId ? { fixture_id: options.fixtureId } : {}),
            },
          },
          async () => {
            // Resolve the scope first — discovery (if requested) runs as
            // a child span of RunRoot so its evidence and selection land
            // on the same Langfuse trace as the analysis that consumes
            // them. setActiveTraceIO is deferred until we have the final
            // scope so the trace input reflects what was actually
            // analyzed, not a placeholder.
            const scope = options.scope
              ? options.scope
              : await runSubscriptionDiscovery(
                  options.client,
                  options.discoverSubscriptions!,
                );

            // Trace-level input is the operator's effective ask; trace-level
            // output is set after doRun returns so Langfuse renders the
            // request → response pair on the trace card.
            setActiveTraceIO({
              input: {
                scope: {
                  subscription_ids: scope.subscription_ids,
                  analysis_type: scope.analysis_type,
                  time_window: scope.time_window,
                  baseline_window: scope.baseline_window,
                  resource_group_names: scope.resource_group_names,
                  effective_scope_summary: scope.effective_scope_summary,
                },
              },
            });
            // Annotate the root span itself with a structured input too,
            // so it's discoverable when filtering on root-span observations.
            updateActiveObservation({ input: { scope_summary: scope.effective_scope_summary } });
            const r = await doRun({
              ...options,
              scope,
              runId,
              startedAt,
              runDir,
              reportPath,
              runJsonPath,
              traceId,
            });
            const outputSummary = {
              run_id: r.run_id,
              status: r.metadata.status,
              recommendations: r.reasoning.recommendations.length,
              facts: r.reasoning.facts.length,
              hypotheses: r.reasoning.hypotheses.length,
              data_quality_findings: r.reasoning.data_quality.length,
              report_path: r.report_path,
              passed_all_rubrics: r.score.passed_all,
            };
            setActiveTraceIO({ output: outputSummary });
            updateActiveObservation({ output: outputSummary });
            await publishAnalyzeScores(options.langfusePublisher, otelTraceId, r);
            rootSpan.setAttribute(ATTR.status, r.metadata.status);
            return r;
          },
        );
      },
      {
        [ATTR.agentName]: 'az-pixiu',
        [ATTR.agentDomain]: 'finops',
        [ATTR.analysisType]: analysisType,
        [ATTR.modelProvider]: options.modelProvider,
        [ATTR.modelName]: modelInfo.modelName,
        ...(modelInfo.deploymentSku
          ? { [ATTR.modelDeploymentSku]: modelInfo.deploymentSku }
          : {}),
        [ATTR.credentialSource]: options.credentialIdentity.implementation,
        [ATTR.credentialIdentity]: options.credentialIdentity.identity,
        [ATTR.instrumentationFlavor]: instrumentationFlavor,
        ...(options.fixtureId ? { [ATTR.fixtureId]: options.fixtureId } : {}),
      },
    );

    process.stdout.write(`\nDone. ${result.reasoning.recommendations.length} recommendation(s).\n`);
    process.stdout.write(`  report: ${result.report_path}\n`);
    process.stdout.write(`  run.json: ${result.run_json_path}\n`);
    process.stdout.write(`  trace_id: ${result.trace_id}\n`);
    if (otelTraceId) process.stdout.write(`  otel_trace_id: ${otelTraceId}\n`);
    if (!result.score.passed_all) {
      process.stdout.write(`  ⚠ scoring: ${result.score.fail_count} rubric(s) failed\n`);
      for (const r of result.score.results) {
        if (!r.passed) process.stdout.write(`    - ${r.rubric}: ${r.details ?? ''}\n`);
      }
    }

    return { ...result, ...(otelTraceId ? { otel_trace_id: otelTraceId } : {}) };
  } finally {
    // Trace export failures should never mask a successful analysis.
    // The report, run.json, and exit code reflect the analysis itself —
    // a Langfuse 5xx or network blip during the final flush is logged as
    // a warning, not raised. (The provider throws an Array of one or
    // more OTLPExporterErrors; we unwrap for a useful message.)
    try {
      await shutdownTracing();
    } catch (err) {
      const errs = Array.isArray(err) ? err : [err];
      for (const [i, e] of errs.entries()) {
        const o = e as { name?: string; message?: string; code?: unknown; data?: unknown };
        const tag = errs.length > 1 ? ` [${i + 1}/${errs.length}]` : '';
        const code = o.code !== undefined ? ` (code=${String(o.code)})` : '';
        process.stderr.write(
          `  ⚠ trace export${tag}: ${o.message ?? String(e)}${code}\n`,
        );
        if (typeof o.data === 'string' && o.data.length > 0) {
          process.stderr.write(`    server: ${o.data.slice(0, 500)}\n`);
        }
      }
    }
  }
}

/**
 * OTEL span attributes only allow primitive values or arrays of
 * primitives (string | number | boolean). Discovery events carry richer
 * shapes (e.g. arrays of subscription objects), so coerce non-primitive
 * values to JSON strings here at the OTEL boundary. Keeps discovery
 * itself transport-agnostic and OTEL-naive.
 */
function toOtelAttributes(
  attrs: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = value as string[];
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

/**
 * Run subscription auto-discovery inside its own child span of RunRoot,
 * so the discovery's stdout progress lines also surface as span events
 * (and as input/output) on the same Langfuse trace as the rest of the
 * run. Returns the {@link Scope} built from the discovery result.
 */
async function runSubscriptionDiscovery(
  client: MCPClient,
  option: DiscoverSubscriptionsOption,
): Promise<Scope> {
  process.stdout.write(
    `→ discovering top ${option.maxSubscriptions} subscription(s) by resource count via AMG-MCP${option.nameFilter ? ` (name filter: "${option.nameFilter}")` : ''}...\n`,
  );
  const discovered = await withSpan(SpanNames.SubscriptionDiscovery, async (span) => {
    updateActiveObservation({
      input: {
        limit: option.maxSubscriptions,
        ...(option.nameFilter ? { name_filter: option.nameFilter } : {}),
      },
    });
    const result = await discoverTopSubscriptions(client, option.maxSubscriptions, {
      onProgress: (line, event) => {
        process.stdout.write(line + '\n');
        if (event) emitEvent(span, event.name, toOtelAttributes(event.attrs));
      },
      ...(option.nameFilter ? { nameFilter: option.nameFilter } : {}),
    });
    const visibleCount = result.all_counts.length;
    const withNamesCount = result.all_counts.filter((c) => c.display_name).length;
    span.setAttribute(ATTR.discoveryLimit, option.maxSubscriptions);
    span.setAttribute(ATTR.discoveryVisibleCount, visibleCount);
    span.setAttribute(ATTR.discoveryWithNamesCount, withNamesCount);
    span.setAttribute(ATTR.discoverySelectedCount, result.selected.length);
    const shapeDiag = result.diagnostics.find((d) => d.startsWith('no display names'));
    if (shapeDiag) span.setAttribute(ATTR.discoveryShapeHint, shapeDiag);
    updateActiveObservation({
      output: {
        selected: result.selected.map((c) => ({
          subscription_id: c.subscription_id,
          display_name: c.display_name,
          resource_count: c.resource_count,
          formatted: formatSubscription(c),
        })),
        diagnostics: result.diagnostics,
      },
    });
    return result;
  });

  if (discovered.diagnostics.length > 0) {
    for (const d of discovered.diagnostics) {
      process.stdout.write(`  note: ${d}\n`);
    }
  }

  // Carry the discovered display names through to the Scope. The
  // markdown report and effective_scope_summary will render
  // `"<name>" (<id>)` wherever a subscription appears.
  const displayNames: Record<string, string> = {};
  for (const c of discovered.selected) {
    if (c.display_name) displayNames[c.subscription_id] = c.display_name;
  }

  return intakeScope({
    ...option.scopeIntake,
    subscription_ids: discovered.selected_subscription_ids,
    ...(Object.keys(displayNames).length > 0
      ? { subscription_display_names: displayNames }
      : {}),
  });
}

interface RunCtx extends Omit<RunOptions, 'scope'> {
  scope: Scope;
  runId: string;
  startedAt: string;
  runDir: string;
  reportPath: string;
  runJsonPath: string;
  traceId: string;
}

async function doRun(ctx: RunCtx): Promise<RunResult> {
  const plannerPrompt = await loadPrompt({
    filename: 'planner.v1.md',
    ...(ctx.promptsCwd ? { cwd: ctx.promptsCwd } : {}),
  });
  // Reasoner prompt selection (Phase 3 — design/cost-summary-depth.md
  // §Reasoner prompt changes). cost_summary analyses get reasoner.v2,
  // which knows how to consume waste-candidate evidence and render
  // calibrated impact ranges. Every other analysis stays on v1 so the
  // existing Phase 1/2 eval surface is unaffected by the Phase 3 prompt
  // changes — v2 promotion against other analysis types lands when
  // their lanes do.
  const reasonerFilename =
    ctx.scope.analysis_type === 'cost_summary' ? 'reasoner.v2.md' : 'reasoner.v1.md';
  const reasonerPrompt = await loadPrompt({
    filename: reasonerFilename,
    ...(ctx.promptsCwd ? { cwd: ctx.promptsCwd } : {}),
  });

  const client = ctx.client;

  process.stdout.write(`→ discovering AMG-MCP capabilities...\n`);
  const catalog = await withSpan(SpanNames.CapabilityDiscovery, async (span) => {
    const c = await client.discover();
    if (c.mutating_denied.length > 0) {
      emitEvent(span, 'mutating_capabilities_excluded', {
        count: c.mutating_denied.length,
        names: c.mutating_denied.map((cap) => cap.name).join(','),
      });
    }
    return c;
  });
  assertRequiredCapabilities(catalog, ctx.scope.analysis_type);
  process.stdout.write(
    `  ${catalog.allowed.length} capability/ies allowed, ${catalog.mutating_denied.length} mutating excluded\n`,
  );
  const subDisplay = ctx.scope.subscription_ids
    .map((id) => {
      const name = ctx.scope.subscription_display_names?.[id];
      return name ? `"${name}" (${id})` : id;
    })
    .join(', ');
  process.stdout.write(
    `  analyzing ${ctx.scope.subscription_ids.length} subscription(s): ${subDisplay}\n`,
  );

  // Plan
  const planSource = ctx.usePlaybook ?? false ? 'playbook' : 'planner_llm';
  process.stdout.write(`→ building evidence plan (source: ${planSource})...\n`);
  let plan: EvidencePlan;
  if (ctx.usePlaybook ?? false) {
    plan = await withSpan(SpanNames.EvidencePlanning, async (span) => {
      const p = selectPlaybook(ctx.scope);
      span.setAttribute(ATTR.evidencePlanRequests, p.requests.length);
      span.setAttribute('az_pixiu.plan.source', 'playbook');
      return p;
    });
  } else {
    const planner = new Planner({ model: ctx.model, systemPrompt: plannerPrompt.content });
    plan = await withSpan(SpanNames.EvidencePlanning, async (span) => {
      const p = await planner.plan(ctx.scope, catalog);
      span.setAttribute(ATTR.evidencePlanRequests, p.requests.length);
      span.setAttribute('az_pixiu.plan.source', 'planner_llm');
      return p;
    });
  }
  process.stdout.write(`  ${plan.requests.length} evidence request(s) planned\n`);

  // Execute
  process.stdout.write(`→ retrieving evidence from AMG-MCP...\n`);
  const { raw_evidence, failures, transport_summary } = await withSpan(
    SpanNames.EvidenceRetrieval,
    async (span) => {
      // Per-attempt detail (Codex should-fix #3 / self-review #1): emit
      // transport.retry_scheduled and transport.pacing_applied events on
      // the retrieval span so operator debugging "which attempt of which
      // call burned 180s?" stays answerable in Langfuse without reading
      // run.json. The aggregate attributes below remain for cheap
      // run-level rollups.
      const executor = new EvidenceExecutor({
        client,
        catalog,
        onEvent: (event) => {
          if (event.kind === 'retry_scheduled') {
            emitEvent(span, 'transport.retry_scheduled', {
              logical_request_id: event.logical_request_id,
              capability: event.capability,
              attempt: event.attempt,
              failure_category: event.failure_category,
              backoff_ms: event.backoff_ms,
            });
          } else if (event.kind === 'pacing_applied') {
            emitEvent(span, 'transport.pacing_applied', {
              logical_request_id: event.logical_request_id,
              capability: event.capability,
              pacing_ms: event.pacing_ms,
            });
          }
        },
      });
      const r = await executor.execute(plan);
      span.setAttribute(ATTR.evidenceRecordsProduced, r.raw_evidence.length);
      span.setAttribute(ATTR.evidenceFailuresClassified, r.failures.length);
      const rollup = rollupTransportSummary(r.transport_summary);
      span.setAttribute(ATTR.transportRetryCount, rollup.retry_count);
      span.setAttribute(ATTR.transportCumulativeBackoffMs, rollup.cumulative_backoff_ms);
      span.setAttribute(ATTR.transportFinalOutcome, runOutcomeFromRollup(rollup));
      span.setAttribute(ATTR.transportRateLimitSeen, rollup.rate_limit_seen);
      span.setAttribute(ATTR.transportRecoveredCount, rollup.recovered_count);
      span.setAttribute(ATTR.transportExhaustedCount, rollup.exhausted_count);
      return r;
    },
  );
  const transportRollup = rollupTransportSummary(transport_summary);
  process.stdout.write(
    `  retrieved ${raw_evidence.length} record(s), ${failures.length} failure(s) classified` +
      (transportRollup.retry_count > 0
        ? ` (${transportRollup.retry_count} retry attempt(s), ${Math.round(
            transportRollup.cumulative_backoff_ms / 1000,
          )}s cumulative backoff)`
        : '') +
      '\n',
  );

  // Normalize
  const normalizer = new EvidenceNormalizer();
  const { records, data_quality: normalizerDq } = normalizer.normalize(raw_evidence, {
    defaultTimeWindow: ctx.scope.time_window,
  });

  // Merge failure-classified DQs alongside normalizer DQs
  const failureDqs = failures.map((f, i) => failureToDq(f, i));

  // Waste-detection lanes (Phase 3 — design/cost-summary-depth.md §Gap 1).
  // Runs only for cost_summary analyses; fans the lane registry out
  // through the existing transport so each ARG call inherits §Gap 7
  // retry + embedded rate-limit detection. The executor emits one
  // EvidenceRecord per candidate; the deterministic per-lane summary
  // surfaces in the report (Waste Candidates section) and in run.json
  // (waste_lanes block) so RunHistoryStore can index lane history in
  // PR 4 without re-walking evidence.
  const wasteResult = await runWasteDetection(ctx, catalog);
  const wasteEvidence = wasteResult?.evidence ?? [];
  const wasteFailures = wasteResult?.failures ?? [];
  const wasteFailureDqs = wasteFailures.map((f, i) => failureToDq(f, failureDqs.length + i));
  const mergedTransport = [
    ...transport_summary,
    ...(wasteResult?.transport_summary ?? []),
  ];

  // Freshness check (Phase 3 — design/cost-summary-depth.md §Gap 4):
  // emit a freshness_partial_window finding when any cost-analysis
  // window ends within the cost-API's late-posting threshold (default
  // 48h). Findings flow into allDq, then surface in the Run Quality
  // report section because freshness categories are in
  // RUN_QUALITY_CATEGORIES (src/report/markdown.ts).
  const freshnessDqs = checkFreshness(records, {
    startingCounter: failureDqs.length + wasteFailureDqs.length,
  });
  const allDq = [...normalizerDq, ...failureDqs, ...wasteFailureDqs, ...freshnessDqs];
  process.stdout.write(
    `  normalized ${records.length} evidence record(s); ${allDq.length} data-quality finding(s) so far\n`,
  );
  if (wasteResult) {
    const totalCandidates = wasteResult.lanes.reduce(
      (sum, lane) => sum + lane.candidates.length,
      0,
    );
    process.stdout.write(
      `  waste-detection: ${wasteResult.lanes.length} lane(s) ran, ${totalCandidates} candidate(s) surfaced\n`,
    );
  }

  // Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md §Gap 5).
  // Query the run-history store for prior runs against the same scope and
  // analysis type, and inject them as a synthetic prior_run_context
  // EvidenceRecord. Defaults to a no-op store so the no-history path is
  // byte-identical to the pre-Phase-2.5 behaviour.
  const runHistoryStore = ctx.runHistoryStore ?? new NoopRunHistoryStore();
  const scopeSignature = computeScopeSignature(ctx.scope);
  const priorRuns = await runHistoryStore.findPriorRuns({
    scope_signature: scopeSignature,
    analysis_type: ctx.scope.analysis_type,
    excludeRunId: ctx.runId,
  });
  const priorRunEvidence = buildPriorRunContextEvidence({ priorRuns, scope: ctx.scope });
  // Order: main normalized records → waste-candidate evidence →
  // synthetic prior-run context. The reasoner sees lane evidence
  // before continuity context so it can ground continuity markers
  // (Phase 3 PR 4) against the in-window lane output.
  const recordsWithPrior = [...records, ...wasteEvidence, ...priorRunEvidence];
  if (priorRunEvidence.length > 0) {
    process.stdout.write(
      `  found ${priorRuns.length} prior run(s) against this scope — injecting prior_run_context\n`,
    );
  }

  // Reason
  process.stdout.write(`→ reasoning over evidence...\n`);
  const reasoner = new Reasoner({ model: ctx.model, systemPrompt: reasonerPrompt.content });
  const { output: reasoning, issues } = await withSpan(SpanNames.Reasoning, async (span) => {
    const r = await reasoner.reason({ scope: ctx.scope, evidence: recordsWithPrior, data_quality: allDq });
    span.setAttribute(ATTR.reasoningFactsProduced, r.output.facts.length);
    span.setAttribute(ATTR.reasoningHypothesesProduced, r.output.hypotheses.length);
    span.setAttribute(ATTR.reasoningRecommendationsProduced, r.output.recommendations.length);
    span.setAttribute(ATTR.reasoningDqProduced, r.output.data_quality.length);
    span.setAttribute(ATTR.reasoningIssuesEmitted, r.issues.length);
    return r;
  });
  process.stdout.write(
    `  reasoning produced ${reasoning.facts.length} fact(s), ${reasoning.hypotheses.length} hypothesis/es, ${reasoning.recommendations.length} recommendation(s)\n`,
  );

  const score = scoreAll(reasoning, { evidence: recordsWithPrior });

  const endedAt = new Date().toISOString();
  const modelInfo = resolveModelInfo(ctx.config);
  const metadata: RunMetadata = {
    run_id: runIdAsBranded(ctx.runId),
    trace_id: ctx.traceId,
    prompt_versions: { planner: plannerPrompt.version, reasoner: reasonerPrompt.version },
    model_provider: ctx.modelProvider,
    model_name: modelInfo.modelName,
    model_config_hash: modelConfigHash({
      provider: ctx.modelProvider,
      name: modelInfo.modelName,
      temperature: 0,
    }),
    ...(modelInfo.deploymentSku ? { model_deployment_sku: modelInfo.deploymentSku } : {}),
    credential_source: ctx.credentialIdentity,
    instrumentation_flavor: currentInstrumentationFlavor(),
    amg_mcp_endpoint: ctx.config.amg.endpoint,
    capability_versions: { ...catalog.capability_versions },
    ...(ctx.fixtureId ? { fixture_id: ctx.fixtureId } : {}),
    started_at: ctx.startedAt,
    ended_at: endedAt,
    status: 'success',
  };

  process.stdout.write(`→ writing report to ${ctx.runDir}/\n`);
  await withSpan(SpanNames.ReportAssembly, async () => {
    const md = renderMarkdownReport({
      scope: ctx.scope,
      reasoning,
      evidence: recordsWithPrior,
      metadata,
      inputDataQuality: allDq,
      transportSummary: mergedTransport,
      ...(wasteResult ? { wasteLanes: wasteResult.lanes } : {}),
    });
    await mkdir(ctx.runDir, { recursive: true });
    await writeFile(ctx.reportPath, md, 'utf8');
    await writeRunArtifact({
      path: ctx.runJsonPath,
      artifact: buildRunArtifact(
        metadata,
        ctx.scope,
        recordsWithPrior,
        reasoning,
        allDq,
        mergedTransport,
        wasteResult?.lanes,
      ),
    });
  });

  await withSpan(SpanNames.Finalize, async (span) => {
    span.setAttribute(ATTR.status, metadata.status);
    emitEvent(span, 'recommendations_evidence_links', {
      links: reasoning.recommendations
        .map(
          (r) =>
            `${r.recommendation_id}->[${[
              ...r.supported_by_hypothesis_ids,
              ...r.supported_by_fact_ids,
            ].join(',')}]`,
        )
        .join(';'),
    });
  });

  await client.close();

  return {
    run_id: ctx.runId,
    run_dir: ctx.runDir,
    report_path: ctx.reportPath,
    run_json_path: ctx.runJsonPath,
    trace_id: ctx.traceId,
    metadata,
    reasoning,
    // RunResult.evidence is the eval runner's view of what was retrieved
    // and surfaced for grounding. Include waste-candidate evidence so
    // `expected_capabilities_invoked: ['az_pixiu_waste_lane']` and
    // intent-based eval assertions resolve. The prior_run_context
    // record stays out (it is synthetic continuity context, not
    // retrieved evidence) to match the pre-Phase-3 shape.
    evidence: [...records, ...wasteEvidence],
    input_dq_categories: allDq.map((d) => d.category),
    score,
    failures_classified: failures.length + wasteFailures.length,
    post_process_issues: issues.length,
  };
}

// --- helpers ---

/**
 * Phase 3 — design/cost-summary-depth.md §Gap 1. Runs the waste-lane
 * registry for cost_summary analyses and returns the structured result.
 * Returns `undefined` when waste detection is skipped (non-cost_summary
 * analyses, or operator-disabled), so the caller can elide every
 * downstream merge cleanly.
 */
async function runWasteDetection(
  ctx: RunCtx,
  catalog: import('../mcp/client.js').DiscoveredCatalog,
): Promise<import('./waste-detection.js').WasteDetectionResult | undefined> {
  if (ctx.scope.analysis_type !== 'cost_summary') return undefined;
  if (ctx.disableWasteDetection) return undefined;
  const lanes = getEnabledWasteLanes();
  if (lanes.length === 0) return undefined;

  const rateSource = ctx.rateSource ?? (await loadDefaultRateSource());
  return await withSpan(SpanNames.WasteDetection, async (span) => {
    const executor = new WasteDetectionExecutor({
      client: ctx.client,
      catalog,
      rateSource,
      lanes,
      onEvent: (event) => {
        if (event.kind === 'retry_scheduled') {
          emitEvent(span, 'transport.retry_scheduled', {
            logical_request_id: event.logical_request_id,
            capability: event.capability,
            attempt: event.attempt,
            failure_category: event.failure_category,
            backoff_ms: event.backoff_ms,
          });
        } else if (event.kind === 'pacing_applied') {
          emitEvent(span, 'transport.pacing_applied', {
            logical_request_id: event.logical_request_id,
            capability: event.capability,
            pacing_ms: event.pacing_ms,
          });
        }
      },
    });
    const result = await executor.execute({ scope: ctx.scope });
    // §14 vocabulary: emit one event per lane carrying the lane's
    // attribute group, so Langfuse trace filters generalise across
    // lanes without requiring a child span per lane.
    for (const lane of result.lanes) {
      emitEvent(span, 'waste_lane.summary', {
        [ATTR.wasteLaneName]: lane.lane,
        [ATTR.wasteLaneCandidateCount]: lane.candidates.length,
        [ATTR.wasteLaneEstimatedWeeklyUsdLow]: lane.lane_total.low_usd,
        [ATTR.wasteLaneEstimatedWeeklyUsdHigh]: lane.lane_total.high_usd,
        [ATTR.wasteLaneRateSource]: lane.rate_source_captured_at,
        [ATTR.wasteLaneRateUnavailableCount]: lane.lane_total.unavailable_count,
        [ATTR.wasteLaneFailed]: lane.failed,
      });
    }
    span.setAttribute(ATTR.evidenceRecordsProduced, result.evidence.length);
    return result;
  });
}

/**
 * Lazy single-shot load of the in-repo seed rate card. The orchestrator
 * caches a single instance for the lifetime of the process so repeated
 * cost_summary runs do not re-read the JSON file from disk.
 */
let cachedDefaultRateSource: Promise<PricingRateSource> | undefined;
async function loadDefaultRateSource(): Promise<PricingRateSource> {
  if (!cachedDefaultRateSource) {
    cachedDefaultRateSource = JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
  }
  return cachedDefaultRateSource;
}

async function publishAnalyzeScores(
  publisher: AnalyzeScorePublisher | undefined,
  otelTraceId: string | undefined,
  result: RunResult,
): Promise<void> {
  if (!publisher || !otelTraceId) return;
  try {
    const scores: ScorePayload[] = result.score.results.map((r) => ({
      traceId: otelTraceId,
      name: `rubric.${r.rubric}`,
      value: r.passed ? 1 : 0,
      dataType: 'BOOLEAN',
      ...(r.details ? { comment: r.details } : {}),
    }));
    scores.push({
      traceId: otelTraceId,
      name: 'rubric.passed_all',
      value: result.score.passed_all ? 1 : 0,
      dataType: 'BOOLEAN',
    });
    await publisher.pushScores(scores);
    process.stdout.write(`  ↗ published rubric scores to Langfuse\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  ⚠ Langfuse score publish failed: ${message}\n`);
  }
}

function runIdAsBranded(id: string): RunMetadata['run_id'] {
  // randomUUID is RFC 4122 v4 so it satisfies the RunIdSchema brand.
  return id as unknown as RunMetadata['run_id'];
}

/**
 * Resolve the provider-specific model fields the orchestrator needs to
 * print, trace, and write into RunMetadata. Centralizing this here keeps
 * `doRun` and the RunRoot setup agnostic to which provider is configured;
 * the schema's superRefine guarantees the matching block is present.
 */
export function resolveModelInfo(config: Config): {
  provider: 'foundry' | 'litellm';
  endpoint: string;
  modelName: string;
  deploymentSku?: 'GlobalStandard' | 'DataZoneStandard' | 'regional';
} {
  if (config.provider === 'litellm') {
    const l = config.litellm!;
    return { provider: 'litellm', endpoint: l.endpoint, modelName: l.model };
  }
  const f = config.foundry!;
  return {
    provider: 'foundry',
    endpoint: f.endpoint,
    modelName: f.deployment,
    deploymentSku: f.deployment_sku,
  };
}

function selectPlaybook(scope: import('../schemas/index.js').Scope): EvidencePlan {
  switch (scope.analysis_type) {
    case 'cost_surprise':
      return costSurprisePlaybook(scope);
    case 'cost_summary':
      return costSummaryPlaybook(scope);
    default:
      throw new Error(
        `No playbook defined for analysis_type "${scope.analysis_type}". Phase 1 supports cost_surprise and cost_summary.`,
      );
  }
}

function failureToDq(failure: ClassifiedFailure, index: number): DataQualityFinding {
  return DataQualityFindingSchema.parse({
    dq_id: `dq-failure-${index + 1}`,
    category: failure.category,
    affected_capability: failure.capability,
    affected_scope_subset: null,
    consequence_for_analysis: failure.message,
    impact_on_recommendations: [],
    actionable_hint: failure.actionable_hint ?? null,
  });
}
