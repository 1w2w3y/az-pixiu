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
import {
  discoverTopSubscriptions,
  formatSubscription,
} from './subscription-discovery.js';
import { intakeScope, type ScopeIntakeInput } from './scope-intake.js';
import type {
  Config,
  Scope,
  EvidencePlan,
  RunMetadata,
  ReasoningOutput,
  DataQualityFinding,
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
}

export interface DiscoverSubscriptionsOption {
  /** Max top-N subscriptions to select by resource count. */
  maxSubscriptions: number;
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
  trace_id: string;
  metadata: RunMetadata;
  reasoning: ReasoningOutput;
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
  process.stdout.write(
    `  foundry: ${options.config.foundry.endpoint} (${options.config.foundry.deployment}, sku=${options.config.foundry.deployment_sku})\n`,
  );
  process.stdout.write(
    `  credential: ${options.credentialIdentity.implementation} (${options.credentialIdentity.identity})\n`,
  );
  process.stdout.write(`  observability: ${observabilityMode}\n`);

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

  try {
    const result = await withSpan(
      SpanNames.RunRoot,
      async (rootSpan) =>
        propagateAttributes(
          {
            traceName: `analyze.${analysisType}`,
            userId: options.credentialIdentity.identity,
            sessionId: options.config.amg.endpoint,
            tags,
            metadata: {
              run_id: runId,
              amg_mcp_endpoint: options.config.amg.endpoint,
              model_deployment: options.config.foundry.deployment,
              model_deployment_sku: options.config.foundry.deployment_sku,
              credential_source: options.credentialIdentity.implementation,
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
            rootSpan.setAttribute(ATTR.status, r.metadata.status);
            return r;
          },
        ),
      {
        [ATTR.agentName]: 'az-pixiu',
        [ATTR.agentDomain]: 'finops',
        [ATTR.analysisType]: analysisType,
        [ATTR.modelProvider]: options.modelProvider,
        [ATTR.modelName]: options.config.foundry.deployment,
        [ATTR.modelDeploymentSku]: options.config.foundry.deployment_sku,
        [ATTR.credentialSource]: options.credentialIdentity.implementation,
        [ATTR.credentialIdentity]: options.credentialIdentity.identity,
        ...(options.fixtureId ? { [ATTR.fixtureId]: options.fixtureId } : {}),
      },
    );

    process.stdout.write(`\nDone. ${result.reasoning.recommendations.length} recommendation(s).\n`);
    process.stdout.write(`  report: ${result.report_path}\n`);
    process.stdout.write(`  run.json: ${result.run_json_path}\n`);
    process.stdout.write(`  trace_id: ${result.trace_id}\n`);
    if (!result.score.passed_all) {
      process.stdout.write(`  ⚠ scoring: ${result.score.fail_count} rubric(s) failed\n`);
      for (const r of result.score.results) {
        if (!r.passed) process.stdout.write(`    - ${r.rubric}: ${r.details ?? ''}\n`);
      }
    }

    return result;
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
    `→ discovering top ${option.maxSubscriptions} subscription(s) by resource count via AMG-MCP...\n`,
  );
  const discovered = await withSpan(SpanNames.SubscriptionDiscovery, async (span) => {
    updateActiveObservation({ input: { limit: option.maxSubscriptions } });
    const result = await discoverTopSubscriptions(client, option.maxSubscriptions, {
      onProgress: (line, event) => {
        process.stdout.write(line + '\n');
        if (event) emitEvent(span, event.name, toOtelAttributes(event.attrs));
      },
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

  return intakeScope({
    ...option.scopeIntake,
    subscription_ids: discovered.selected_subscription_ids,
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
  const reasonerPrompt = await loadPrompt({
    filename: 'reasoner.v1.md',
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
  process.stdout.write(
    `  analyzing ${ctx.scope.subscription_ids.length} subscription(s): ${ctx.scope.subscription_ids.join(', ')}\n`,
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
  const executor = new EvidenceExecutor({ client, catalog });
  const { raw_evidence, failures } = await withSpan(
    SpanNames.EvidenceRetrieval,
    async (span) => {
      const r = await executor.execute(plan);
      span.setAttribute(ATTR.evidenceRecordsProduced, r.raw_evidence.length);
      span.setAttribute(ATTR.evidenceFailuresClassified, r.failures.length);
      return r;
    },
  );
  process.stdout.write(
    `  retrieved ${raw_evidence.length} record(s), ${failures.length} failure(s) classified\n`,
  );

  // Normalize
  const normalizer = new EvidenceNormalizer();
  const { records, data_quality: normalizerDq } = normalizer.normalize(raw_evidence, {
    defaultTimeWindow: ctx.scope.time_window,
  });

  // Merge failure-classified DQs alongside normalizer DQs
  const failureDqs = failures.map((f, i) => failureToDq(f, i));
  const allDq = [...normalizerDq, ...failureDqs];
  process.stdout.write(
    `  normalized ${records.length} evidence record(s); ${allDq.length} data-quality finding(s) so far\n`,
  );

  // Reason
  process.stdout.write(`→ reasoning over evidence...\n`);
  const reasoner = new Reasoner({ model: ctx.model, systemPrompt: reasonerPrompt.content });
  const { output: reasoning, issues } = await withSpan(SpanNames.Reasoning, async (span) => {
    const r = await reasoner.reason({ scope: ctx.scope, evidence: records, data_quality: allDq });
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

  const score = scoreAll(reasoning);

  const endedAt = new Date().toISOString();
  const metadata: RunMetadata = {
    run_id: runIdAsBranded(ctx.runId),
    trace_id: ctx.traceId,
    prompt_versions: { planner: plannerPrompt.version, reasoner: reasonerPrompt.version },
    model_provider: ctx.modelProvider,
    model_name: ctx.config.foundry.deployment,
    model_config_hash: modelConfigHash({
      provider: ctx.modelProvider,
      name: ctx.config.foundry.deployment,
      temperature: 0,
    }),
    model_deployment_sku: ctx.config.foundry.deployment_sku,
    credential_source: ctx.credentialIdentity,
    amg_mcp_endpoint: ctx.config.amg.endpoint,
    capability_versions: { ...catalog.capability_versions },
    ...(ctx.fixtureId ? { fixture_id: ctx.fixtureId } : {}),
    started_at: ctx.startedAt,
    ended_at: endedAt,
    status: 'success',
  };

  process.stdout.write(`→ writing report to ${ctx.runDir}/\n`);
  await withSpan(SpanNames.ReportAssembly, async () => {
    const md = renderMarkdownReport({ scope: ctx.scope, reasoning, evidence: records, metadata });
    await mkdir(ctx.runDir, { recursive: true });
    await writeFile(ctx.reportPath, md, 'utf8');
    await writeRunArtifact({
      path: ctx.runJsonPath,
      artifact: buildRunArtifact(metadata, ctx.scope, records, reasoning),
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
    score,
    failures_classified: failures.length,
    post_process_issues: issues.length,
  };
}

// --- helpers ---

function runIdAsBranded(id: string): RunMetadata['run_id'] {
  // randomUUID is RFC 4122 v4 so it satisfies the RunIdSchema brand.
  return id as unknown as RunMetadata['run_id'];
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
