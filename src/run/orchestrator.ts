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
import { renderHtmlReport } from '../report/html.js';
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
  type SubscriptionDiscoveryResult,
} from './subscription-discovery.js';
import { BillingProbeCache } from './billing-probe-cache.js';
import { intakeScope, type ScopeIntakeInput } from './scope-intake.js';
import { computeScopeSignature } from './scope-signature.js';
import { COST_EVIDENCE_CAPABILITIES, COST_WIRE_CAPABILITIES } from './cost-capabilities.js';
import { CostEvidenceProvider } from './cost-evidence-provider.js';
import {
  QUARANTINED_COST_SOURCE_CAPABILITY,
  assessCostZeroEvidence,
  markQuarantinedCostEvidence,
} from './cost-zero-assessment.js';
import type {
  CostView,
  CurrencyMode,
  FileBillingCacheStore,
  MaturityPolicy,
} from '../billing-cache/index.js';
import { buildPriorRunContextEvidence } from './prior-run-evidence.js';
import { checkFreshness } from './freshness.js';
import { WasteDetectionExecutor } from './waste-detection.js';
import { getEnabledWasteLanes } from '../playbooks/waste-lanes/registry.js';
import type { WasteLaneResult } from '../playbooks/waste-lanes/types.js';
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
  /**
   * Optional Azure Monitor / Application Insights connection string for
   * ms-otel mode. Environment variable still wins in observability setup.
   */
  applicationInsightsConnectionString?: string;
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
  /**
   * Local billing-cache read-through / write-through (docs/design/
   * local-billing-cache.md). When set on a `cost_summary` run, the
   * orchestrator serves cache-eligible usage-stable-month cost requests from
   * the local cache (skipping the live AMG-MCP call) and writes freshly
   * retrieved usage-stable months back. Omitted ⇒ the cache is not consulted
   * and the cost path is byte-identical to its pre-cache shape. The CLI
   * sets this only behind `--billing-cache` / `billing_cache.enabled`.
   */
  billingCache?: {
    store: FileBillingCacheStore;
    costView: CostView;
    currencyMode?: CurrencyMode;
    policy?: MaturityPolicy;
    /** Injected clock for the maturity gate; defaults to Date.now. */
    now?: () => number;
  };
  /**
   * Data-quality findings produced before the run started — currently
   * the billing-access probe under explicit-pick mode, where the CLI
   * runs the probe but does not gate selection. Merged into the run's
   * `allDq` alongside discovery-emitted findings so the operator sees
   * billing-access state in the report even when the explicit `--subscription`
   * override prevents the probe from filtering.
   */
  preflightDataQuality?: DataQualityFinding[];
  /**
   * Optional EvidenceExecutor injection points for tests. The CLI never
   * sets these — the executor's defaults are anchored to the reference
   * cron's empirical recovery times (DEFAULT_RETRY_POLICY in
   * `src/evidence/retry-policy.ts`). Tests that simulate failures pass
   * `sleep: () => Promise.resolve()` and `jitter: () => 0` so the
   * suite does not stall on the 30s–180s backoffs.
   */
  executorOverrides?: {
    retryPolicy?: import('../evidence/retry-policy.js').RetryPolicy;
    sleep?: (ms: number) => Promise<void>;
    jitter?: (policy: import('../evidence/retry-policy.js').RetryPolicy) => number;
  };
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
   * Billing-access pre-flight probe (Phase 3). When enabled, the
   * top-N ranking by resource count is gated by a tiny
   * `amgmcp_cost_analysis` call against each candidate so subs that
   * lack Cost Management read access are excluded before final
   * selection. Defaults at the CLI layer to enabled with the standard
   * pool/concurrency/timeouts and the on-disk cache at
   * `~/.az-pixiu/billing-probe-cache.json`.
   */
  probe?: {
    enabled: boolean;
    poolSize?: number;
    concurrency?: number;
    timeoutMs?: number;
    cache?: BillingProbeCache | null;
  };
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
  html_report_path: string;
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
   * Normalized EvidenceRecords surfaced by the run. Quarantined cost records
   * remain here for provenance but are withheld from the reasoner.
   */
  evidence: EvidenceRecord[];
  /** Deterministic lane results used by dataset recall/scope expectations. */
  waste_lanes: WasteLaneResult[];
  /** Wire and synthetic capabilities attempted/served during this run. */
  invoked_capabilities: string[];
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
  /**
   * Breakdown of facts/hypotheses/recommendations that
   * {@link postProcessReasoning} dropped because of dangling citations,
   * fabricated numbers, or imperative remediation language. Exposed so
   * the CLI can emit a single loud warning when the reasoner's output
   * was non-trivially truncated — those drops surface as `dq-synth-*`
   * rows buried in the Data Quality section of `report.md`, and an
   * operator skimming the run summary would otherwise have to read the
   * report to notice. Always present; zeros when nothing was dropped.
   */
  reasoning_drops: ReasoningDropBreakdown;
  /**
   * Outcome of cost-evidence retrieval for analysis types that depend on
   * `amgmcp_cost_analysis` (`cost_summary`, `cost_surprise`). Computed
   * from the in-scope subscription set and the cost-capability rows of
   * `transport_summary`:
   *
   *   - `success`: every in-scope sub returned at least one successful
   *     cost-analysis call.
   *   - `partial`: at least one sub returned cost evidence, but at least
   *     one was missing or failed.
   *   - `failed`: zero in-scope subs returned cost evidence AND at least
   *     one cost-analysis call was attempted (i.e. throttled or denied
   *     out of the run, not "nothing was tried").
   *   - `not_applicable`: the analysis type does not consume cost
   *     evidence, or the scope carried no subscription ids to attribute
   *     coverage against.
   *
   * `failed` is the CLI's signal to exit non-zero — see
   * `src/cli.ts:runAnalyzeCommand` and DESIGN-NOTE.md.
   */
  cost_retrieval_outcome: CostRetrievalOutcome;
}

export type CostRetrievalOutcome =
  | 'success'
  | 'partial'
  | 'failed'
  | 'not_applicable';

export interface ReasoningDropBreakdown {
  facts: number;
  hypotheses: number;
  recommendations: number;
  total: number;
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
  const runDir = join(runsDir, runDirName(startedAt, runId));
  const reportPath = join(runDir, 'report.md');
  const htmlReportPath = join(runDir, 'report.html');
  const runJsonPath = join(runDir, 'run.json');

  const observabilityMode = options.observabilityMode ?? 'memory';
  await initializeTracing({
    mode: observabilityMode,
    ...(options.applicationInsightsConnectionString
      ? { applicationInsightsConnectionString: options.applicationInsightsConnectionString }
      : {}),
  });

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
            let discoveryResult: SubscriptionDiscoveryResult | undefined;
            const scope = options.scope
              ? options.scope
              : await (async () => {
                  const r = await runSubscriptionDiscovery(
                    options.client,
                    options.discoverSubscriptions!,
                  );
                  discoveryResult = r.discovery;
                  return r.scope;
                })();

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
              ...(discoveryResult ? { discoveryResult } : {}),
              runId,
              startedAt,
              runDir,
              reportPath,
              htmlReportPath,
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
            rootSpan.setAttribute(
              ATTR.promptPlannerVersion,
              r.metadata.prompt_versions.planner,
            );
            rootSpan.setAttribute(
              ATTR.promptReasonerVersion,
              r.metadata.prompt_versions.reasoner,
            );
            if (r.metadata.prompt_content_hashes) {
              rootSpan.setAttribute(
                ATTR.promptPlannerContentSha256,
                r.metadata.prompt_content_hashes.planner,
              );
              rootSpan.setAttribute(
                ATTR.promptReasonerContentSha256,
                r.metadata.prompt_content_hashes.reasoner,
              );
            }
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
    process.stdout.write(`  html report: ${result.html_report_path}\n`);
    process.stdout.write(`  run.json: ${result.run_json_path}\n`);
    process.stdout.write(`  trace_id: ${result.trace_id}\n`);
    if (otelTraceId) process.stdout.write(`  otel_trace_id: ${otelTraceId}\n`);
    // Two loud warnings that previously surfaced only as buried DQ rows
    // inside report.md (DESIGN-NOTE.md §Bug A). Printed to stderr so they
    // do not interleave with the stdout artefact paths above and so they
    // remain visible when stdout is piped through `head` etc.
    if (result.reasoning_drops.total > 0) {
      const d = result.reasoning_drops;
      process.stderr.write(
        `  ⚠ reasoner cited evidence not present in the pool. Output was truncated: ` +
          `${d.facts} fact(s), ${d.hypotheses} hypothesis/es, ${d.recommendations} recommendation(s) dropped. ` +
          `See "Data Quality" findings dq-synth-* in report.md.\n`,
      );
    }
    if (result.cost_retrieval_outcome === 'failed') {
      const causeLine = describeCostRetrievalCause(result);
      process.stderr.write(
        `\n[FAILED] cost-evidence retrieval failed across all subscriptions in scope.\n` +
          `  cause: ${causeLine}\n` +
          `  consequence: no recommendations could be grounded in cost data.\n` +
          `  remediation: re-run after the upstream throttle window; narrow scope ` +
          `(e.g. --max-subscriptions 1) to lower the call rate; or retry later.\n` +
          `  report: ${result.report_path}   (preserved for trace continuity)\n`,
      );
    }
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
): Promise<{ scope: Scope; discovery: SubscriptionDiscoveryResult }> {
  process.stdout.write(
    `→ discovering top ${option.maxSubscriptions} subscription(s) by resource count via AMG-MCP${option.nameFilter ? ` (name filter: "${option.nameFilter}")` : ''}...\n`,
  );
  const discovered = await withSpan(SpanNames.SubscriptionDiscovery, async (span) => {
    updateActiveObservation({
      input: {
        limit: option.maxSubscriptions,
        ...(option.nameFilter ? { name_filter: option.nameFilter } : {}),
        ...(option.probe ? { probe: { enabled: option.probe.enabled } } : {}),
      },
    });
    const result = await discoverTopSubscriptions(client, option.maxSubscriptions, {
      onProgress: (line, event) => {
        process.stdout.write(line + '\n');
        if (event) emitEvent(span, event.name, toOtelAttributes(event.attrs));
      },
      ...(option.nameFilter ? { nameFilter: option.nameFilter } : {}),
      ...(option.probe ? { probe: option.probe } : {}),
    });
    const visibleCount = result.all_counts.length;
    const withNamesCount = result.all_counts.filter((c) => c.display_name).length;
    span.setAttribute(ATTR.discoveryLimit, option.maxSubscriptions);
    span.setAttribute(ATTR.discoveryVisibleCount, visibleCount);
    span.setAttribute(ATTR.discoveryWithNamesCount, withNamesCount);
    span.setAttribute(ATTR.discoverySelectedCount, result.selected.length);
    const shapeDiag = result.diagnostics.find((d) => d.startsWith('no display names'));
    if (shapeDiag) span.setAttribute(ATTR.discoveryShapeHint, shapeDiag);
    if (result.funnel) {
      span.setAttribute(ATTR.discoveryPoolSize, result.funnel.pool_size);
      span.setAttribute(ATTR.discoveryProbedCount, result.funnel.probed);
      span.setAttribute(ATTR.discoveryPassedCount, result.funnel.passed);
      span.setAttribute(ATTR.discoveryCacheHits, result.funnel.cache_hits);
      span.setAttribute(ATTR.discoveryCacheMisses, result.funnel.cache_misses);
    }
    updateActiveObservation({
      output: {
        selected: result.selected.map((c) => ({
          subscription_id: c.subscription_id,
          display_name: c.display_name,
          resource_count: c.resource_count,
          formatted: formatSubscription(c),
        })),
        diagnostics: result.diagnostics,
        ...(result.funnel ? { funnel: result.funnel } : {}),
        excluded: result.excluded.map((e) => ({
          subscription_id: e.subscription_id,
          display_name: e.display_name,
          outcome: e.outcome,
          classification: e.classification,
        })),
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

  const scope = intakeScope({
    ...option.scopeIntake,
    subscription_ids: discovered.selected_subscription_ids,
    ...(Object.keys(displayNames).length > 0
      ? { subscription_display_names: displayNames }
      : {}),
  });

  return { scope, discovery: discovered };
}

interface RunCtx extends Omit<RunOptions, 'scope'> {
  scope: Scope;
  discoveryResult?: SubscriptionDiscoveryResult;
  runId: string;
  startedAt: string;
  runDir: string;
  reportPath: string;
  htmlReportPath: string;
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

  // Billing-cache read-through (design "the CostEvidenceProvider seam"):
  // lift cache-eligible usage-stable-month cost requests out of the live plan
  // and serve them from the local cache; the executor runs only the rest.
  const billingProvider =
    ctx.billingCache && ctx.scope.analysis_type === 'cost_summary'
      ? new CostEvidenceProvider({
          store: ctx.billingCache.store,
          scope: ctx.scope,
          costView: ctx.billingCache.costView,
          ...(ctx.billingCache.currencyMode
            ? { currencyMode: ctx.billingCache.currencyMode }
            : {}),
          ...(ctx.billingCache.policy ? { policy: ctx.billingCache.policy } : {}),
          ...(ctx.billingCache.now ? { now: ctx.billingCache.now } : {}),
        })
      : undefined;
  const cacheServed = billingProvider ? await billingProvider.serveFromCache(plan) : undefined;
  const planToExecute = cacheServed?.remainingPlan ?? plan;
  if (cacheServed && cacheServed.hitCount > 0) {
    process.stdout.write(
      `  billing-cache: ${cacheServed.hitCount} cost request(s) served from cache (live cost call(s) avoided)\n`,
    );
  }

  // Execute
  process.stdout.write(`→ retrieving evidence from AMG-MCP...\n`);
  const { raw_evidence, failures, transport_summary } = await withSpan(
    SpanNames.EvidenceRetrieval,
    async (span) => {
      // A fully cache-served plan has nothing left to fetch live.
      if (planToExecute.requests.length === 0) {
        return { raw_evidence: [], failures: [], transport_summary: [] };
      }
      // Per-attempt detail (Codex should-fix #3 / self-review #1): emit
      // transport.retry_scheduled and transport.pacing_applied events on
      // the retrieval span so operator debugging "which attempt of which
      // call burned 180s?" stays answerable in Langfuse without reading
      // run.json. The aggregate attributes below remain for cheap
      // run-level rollups.
      const executor = new EvidenceExecutor({
        client,
        catalog,
        ...(ctx.executorOverrides?.retryPolicy
          ? { retryPolicy: ctx.executorOverrides.retryPolicy }
          : {}),
        ...(ctx.executorOverrides?.sleep
          ? { sleep: ctx.executorOverrides.sleep }
          : {}),
        ...(ctx.executorOverrides?.jitter
          ? { jitter: ctx.executorOverrides.jitter }
          : {}),
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
      const r = await executor.execute(planToExecute);
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

  // A successful Cost Management call can still carry an unsafe all-zero
  // payload. Assess it before cache write-through so unresolved or
  // contradictory zeros cannot become durable, then retain the assessment
  // for normalization/reporting below.
  const costZeroAssessment = assessCostZeroEvidence(raw_evidence);

  // Write-through: persist freshly retrieved usage-stable-month cost evidence
  // so the next run against this scope hits the cache.
  if (billingProvider) {
    const wrote = await billingProvider.writeThrough(raw_evidence, costZeroAssessment);
    if (wrote > 0) {
      process.stdout.write(`  billing-cache: ${wrote} usage-stable month(s) written to cache\n`);
    }
  }

  // Normalize
  const normalizer = new EvidenceNormalizer();
  const normalized = normalizer.normalize(raw_evidence, {
    defaultTimeWindow: ctx.scope.time_window,
  });
  const normalizerDq = normalized.data_quality;
  // Cache-served cost records (source_capability = az_pixiu_billing_cache)
  // join the live records before the reasoner, coverage, and classify see
  // them. They are excluded from freshness by capability, not here.
  const records = markQuarantinedCostEvidence(
    [...normalized.records, ...(cacheServed?.servedRecords ?? [])],
    costZeroAssessment,
  );

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
  const evidenceContractIncomplete =
    costZeroAssessment.data_quality.length > 0 ||
    (wasteResult?.lanes.some(
      (lane) => lane.failed || lane.unparsed_row_count > 0 || lane.rejected_row_count > 0,
    ) ?? false);
  const wasteFailureDqs = wasteFailures.map((f, i) => failureToDq(f, failureDqs.length + i));
  const mergedTransport = [
    ...transport_summary,
    ...(wasteResult?.transport_summary ?? []),
    ...(cacheServed?.servedTransport ?? []),
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
  const probeDqs = [
    ...(ctx.discoveryResult?.data_quality ?? []),
    ...(ctx.preflightDataQuality ?? []),
  ];
  const allDq = [
    ...normalizerDq,
    ...failureDqs,
    ...wasteFailureDqs,
    ...costZeroAssessment.data_quality,
    ...freshnessDqs,
    ...probeDqs,
  ];
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
  const reasoningEvidence = recordsWithPrior.filter(
    (record) => record.source_capability !== QUARANTINED_COST_SOURCE_CAPABILITY,
  );
  if (priorRunEvidence.length > 0) {
    process.stdout.write(
      `  found ${priorRuns.length} prior run(s) against this scope — injecting prior_run_context\n`,
    );
  }

  // Reason
  process.stdout.write(`→ reasoning over evidence...\n`);
  const reasoner = new Reasoner({ model: ctx.model, systemPrompt: reasonerPrompt.content });
  const { output: reasoning, issues } = await withSpan(SpanNames.Reasoning, async (span) => {
    const r = await reasoner.reason({ scope: ctx.scope, evidence: reasoningEvidence, data_quality: allDq });
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

  const score = scoreAll(reasoning, { evidence: reasoningEvidence });

  // Cost-retrieval outcome + reasoner-drop accounting (DESIGN-NOTE.md
  // §Bug A). Both are derivable from already-computed values — the
  // executor's transport_summary for cost capabilities and the
  // post-process issues for the reasoning truncation. Compute once here
  // so the CLI, the report renderer, and the run.json metadata all
  // observe the same outcome and there is exactly one source of truth.
  const reasoningDrops = summarizeReasoningDrops(issues);
  const costRetrievalOutcome = classifyCostRetrievalOutcome({
    analysisType: ctx.scope.analysis_type,
    scopeSubscriptionIds: ctx.scope.subscription_ids,
    transportSummary: mergedTransport,
    evidence: records,
    quarantinedCostEvidenceCount: costZeroAssessment.data_quality.length,
  });
  const runStatus = deriveRunStatus(
    costRetrievalOutcome,
    reasoningDrops,
    evidenceContractIncomplete,
  );
  const runOutcomeSummary = describeRunOutcome(
    runStatus,
    costRetrievalOutcome,
    reasoningDrops,
    mergedTransport,
    evidenceContractIncomplete,
  );

  const endedAt = new Date().toISOString();
  const modelInfo = resolveModelInfo(ctx.config);
  const metadata: RunMetadata = {
    run_id: runIdAsBranded(ctx.runId),
    trace_id: ctx.traceId,
    prompt_versions: { planner: plannerPrompt.version, reasoner: reasonerPrompt.version },
    prompt_content_hashes: {
      planner: plannerPrompt.content_sha256,
      reasoner: reasonerPrompt.content_sha256,
    },
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
    ...(ctx.discoveryResult?.funnel
      ? {
          discovery_funnel: {
            arg_ranked: ctx.discoveryResult.funnel.arg_ranked,
            probed: ctx.discoveryResult.funnel.probed,
            passed: ctx.discoveryResult.funnel.passed,
            selected: ctx.discoveryResult.funnel.selected,
            cache_hits: ctx.discoveryResult.funnel.cache_hits,
            cache_misses: ctx.discoveryResult.funnel.cache_misses,
          },
        }
      : {}),
    started_at: ctx.startedAt,
    ended_at: endedAt,
    status: runStatus,
  };

  process.stdout.write(`→ writing report to ${ctx.runDir}/\n`);
  await withSpan(SpanNames.ReportAssembly, async () => {
    const reportInput = {
      scope: ctx.scope,
      reasoning,
      evidence: recordsWithPrior,
      metadata,
      inputDataQuality: allDq,
      transportSummary: mergedTransport,
      runOutcomeSummary,
      ...(wasteResult ? { wasteLanes: wasteResult.lanes } : {}),
    };
    const md = renderMarkdownReport(reportInput);
    const html = renderHtmlReport(reportInput);
    await mkdir(ctx.runDir, { recursive: true });
    await writeFile(ctx.reportPath, md, 'utf8');
    await writeFile(ctx.htmlReportPath, html, 'utf8');
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
    html_report_path: ctx.htmlReportPath,
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
    waste_lanes: wasteResult?.lanes ?? [],
    invoked_capabilities: mergedTransport.map((entry) => entry.capability),
    input_dq_categories: allDq.map((d) => d.category),
    score,
    failures_classified: failures.length + wasteFailures.length,
    post_process_issues: issues.length,
    reasoning_drops: reasoningDrops,
    cost_retrieval_outcome: costRetrievalOutcome,
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
      ...(ctx.executorOverrides?.retryPolicy
        ? { retryPolicy: ctx.executorOverrides.retryPolicy }
        : {}),
      ...(ctx.executorOverrides?.sleep
        ? { sleep: ctx.executorOverrides.sleep }
        : {}),
      ...(ctx.executorOverrides?.jitter
        ? { jitter: ctx.executorOverrides.jitter }
        : {}),
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
 * Filesystem-safe, lexically-sortable name for a run's artefact directory.
 * Derived from the run's start time so `runs/` browses and sorts
 * chronologically, with a short run_id suffix for uniqueness within the same
 * second and to keep a visible link back to the Langfuse trace (`run-<run_id>`).
 *
 * The canonical run identity is still `run_id` (a UUID) recorded inside
 * run.json — the RunHistoryStore reads that field, never the directory name —
 * so this only affects navigability, not cross-run matching or trace ids.
 *
 *   2026-05-29T04:12:41.704Z  ->  2026-05-29T04-12-41Z-d3f4aa74
 *
 * Milliseconds are dropped and ':' is replaced with '-' because ':' is illegal
 * in Windows path components.
 */
function runDirName(startedAtIso: string, runId: string): string {
  const stamp = startedAtIso.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${runId.slice(0, 8)}`;
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

/**
 * Classify the run's cost-evidence retrieval outcome (DESIGN-NOTE.md §Bug A).
 *
 * The flow:
 *   - analysis types that do not consume cost evidence → `not_applicable`.
 *   - scope with no subscription ids → `not_applicable` (no denominator).
 *   - at least one in-scope sub returned a successful cost record → maybe
 *     `success` (every in-scope sub covered) or `partial` (some sub
 *     covered, others uncovered).
 *   - zero in-scope subs returned cost evidence AND at least one
 *     cost-capability call was attempted → `failed`. This is the
 *     user-facing signal that the analysis has no cost substrate.
 *   - zero cost-capability calls attempted → `not_applicable` (no signal
 *     to report; the playbook decided not to ask).
 */
function classifyCostRetrievalOutcome(input: {
  analysisType: AnalysisType;
  scopeSubscriptionIds: readonly string[];
  transportSummary: readonly import('../schemas/transport.js').TransportSummaryEntry[];
  evidence: readonly EvidenceRecord[];
  quarantinedCostEvidenceCount?: number;
}): CostRetrievalOutcome {
  const isCostAnalysis =
    input.analysisType === 'cost_summary' ||
    input.analysisType === 'cost_surprise';
  if (!isCostAnalysis) return 'not_applicable';
  if (input.scopeSubscriptionIds.length === 0) return 'not_applicable';

  // A cache-served run makes no wire cost call but emits a synthetic
  // `az_pixiu_billing_cache` transport entry; count it (and wire calls) so
  // a fully-cached run is not misread as not_applicable.
  const costCalls = input.transportSummary.filter((e) =>
    COST_EVIDENCE_CAPABILITIES.has(e.capability),
  );
  if (costCalls.length === 0) return 'not_applicable';

  const expectedSet = new Set(input.scopeSubscriptionIds);
  const coveredSet = new Set<string>();
  for (const ev of input.evidence) {
    if (!COST_EVIDENCE_CAPABILITIES.has(ev.source_capability)) continue;
    const subs = ev.scope_subset.subscription_ids;
    if (!subs) continue;
    for (const id of subs) {
      if (expectedSet.has(id)) coveredSet.add(id);
    }
  }
  if (coveredSet.size === 0) {
    return (input.quarantinedCostEvidenceCount ?? 0) > 0 ? 'partial' : 'failed';
  }
  if (coveredSet.size < expectedSet.size) return 'partial';
  return 'success';
}

/**
 * Reduce {@link PostProcessIssue} rows into a per-target drop count. The
 * three "fatal" issue kinds — `dangling_citation`, `fabricated_number`,
 * `imperative_language` — are the ones that actually drop an item from
 * the reasoner output; `confidence_downgraded` only rewrites the
 * confidence level and does not drop, so it is not counted here.
 */
function summarizeReasoningDrops(
  issues: readonly import('../reasoning/post-process.js').PostProcessIssue[],
): ReasoningDropBreakdown {
  let facts = 0;
  let hypotheses = 0;
  let recommendations = 0;
  for (const issue of issues) {
    const dropping =
      issue.kind === 'dangling_citation' ||
      issue.kind === 'fabricated_number' ||
      issue.kind === 'imperative_language';
    if (!dropping) continue;
    if (issue.target === 'fact') facts += 1;
    else if (issue.target === 'hypothesis') hypotheses += 1;
    else if (issue.target === 'recommendation') recommendations += 1;
  }
  return { facts, hypotheses, recommendations, total: facts + hypotheses + recommendations };
}

/**
 * Derive {@link RunMetadata.status} from cost retrieval, evidence-contract
 * completeness, and reasoner-drop accounting. Honours the existing enum:
 *
 *   failed_analysis  ← cost retrieval failed across the entire scope
 *   partial          ← any in-scope sub missed cost evidence or the
 *                      reasoner dropped any output rows
 *   success          ← everything landed and nothing was truncated
 *
 * The schema permits all three; downstream consumers (eval runner,
 * history store, Langfuse score publisher) read this as an opaque enum.
 */
function deriveRunStatus(
  costOutcome: CostRetrievalOutcome,
  drops: ReasoningDropBreakdown,
  evidenceContractIncomplete: boolean,
): RunMetadata['status'] {
  if (costOutcome === 'failed') return 'failed_analysis';
  if (costOutcome === 'partial') return 'partial';
  if (evidenceContractIncomplete) return 'partial';
  if (drops.total > 0) return 'partial';
  return 'success';
}

/**
 * One-sentence human summary of the run outcome, used as the
 * `**Run outcome:**` line at the top of the Run Quality section in
 * report.md. Pure function of the inputs so the same string surfaces in
 * tests, Langfuse, and the report.
 */
function describeRunOutcome(
  status: RunMetadata['status'],
  costOutcome: CostRetrievalOutcome,
  drops: ReasoningDropBreakdown,
  transportSummary: readonly import('../schemas/transport.js').TransportSummaryEntry[],
  evidenceContractIncomplete: boolean,
): RunOutcomeSummary {
  const label =
    status === 'failed_analysis' ? 'FAILED'
    : status === 'partial' ? 'PARTIAL'
    : status === 'failed_config' ? 'FAILED'
    : 'SUCCESS';

  const reasons: string[] = [];
  if (costOutcome === 'failed') {
    const costCalls = transportSummary.filter((e) => COST_WIRE_CAPABILITIES.has(e.capability));
    const total = costCalls.length;
    const categories = Array.from(
      new Set(
        costCalls
          .map((e) => e.failure_category)
          .filter((c): c is import('../failure/taxonomy.js').FailureCategory => Boolean(c)),
      ),
    ).sort();
    const categoryClause = categories.length > 0 ? categories.join(', ') : 'no successful response';
    reasons.push(
      `cost-evidence retrieval failed across all subscriptions in scope (${total} cost-analysis call(s); ${categoryClause})`,
    );
  } else if (costOutcome === 'partial') {
    reasons.push('cost-evidence retrieval was incomplete for at least one subscription in scope');
  }
  if (evidenceContractIncomplete && costOutcome === 'success') {
    reasons.push('one or more evidence-contract checks were incomplete; see Run Quality');
  }
  if (drops.total > 0) {
    reasons.push(
      `reasoner output was truncated (${drops.facts} fact(s), ${drops.hypotheses} hypothesis/es, ${drops.recommendations} recommendation(s) dropped — see dq-synth-* in Data Quality)`,
    );
  }
  const sentence =
    reasons.length === 0
      ? 'cost retrieval and reasoning completed without truncation.'
      : reasons.join('; ') + '.';
  return { label, sentence };
}

export interface RunOutcomeSummary {
  label: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  sentence: string;
}

/**
 * One-line cause string for the CLI's `[FAILED]` stderr block. Aggregates
 * by failure category across the cost-capability rows of
 * `transport_summary` so the operator sees "rate_limit (3 of 3 calls)"
 * rather than a single category they need to count themselves.
 */
function describeCostRetrievalCause(result: RunResult): string {
  // The run.json transport summary is on the artifact, not on the
  // RunResult directly; for the CLI message we use the metadata/status
  // and the reasoner.data_quality categories instead, both of which
  // already carry the failure tags propagated through failureToDq().
  const failureCategories = result.input_dq_categories
    .filter((c) =>
      ['rate_limit', 'timeout', 'auth', 'authz_gap', 'schema_mismatch'].includes(c),
    )
    .sort();
  const distinct = Array.from(new Set(failureCategories));
  if (distinct.length === 0) {
    return 'no successful cost-analysis response (cause not classified — see report.md "Run Quality")';
  }
  const counts = distinct.map((c) => {
    const n = failureCategories.filter((x) => x === c).length;
    return `${c} (${n})`;
  });
  return counts.join(', ');
}
