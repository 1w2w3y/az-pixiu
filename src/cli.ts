#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config.js';
import { intakeScope } from './run/scope-intake.js';
import { runAnalysis } from './run/orchestrator.js';
import { FilesystemRunHistoryStore } from './history/filesystem-store.js';
import { diagnose, type DiagnoseResult } from './run/diagnose.js';
import { SubscriptionDiscoveryError } from './run/subscription-discovery.js';
import { BillingProbeCache, defaultCachePath } from './run/billing-probe-cache.js';
import { FileBillingCacheStore } from './billing-cache/index.js';
import { probeBillingAccess } from './run/billing-probe.js';
import { DataQualityFindingSchema, type DataQualityFinding } from './schemas/index.js';
import {
  buildCredential,
  describeCredential,
  type CredentialMode,
} from './run/credential-factory.js';
import { FixtureMCPTransport } from './mcp/fixture.js';
import { LiveMCPTransport } from './mcp/live.js';
import type { MCPTransport } from './mcp/transport.js';
import { MCPClient } from './mcp/client.js';
import { OpenAIModelClient } from './model/openai-client.js';
import { LiteLLMModelClient } from './model/litellm-client.js';
import { MockModelClient } from './model/mock-client.js';
import type { ModelClient } from './model/client.js';
import type { Config } from './schemas/index.js';
import type { TokenCredential } from '@azure/identity';
import { LangfusePublisher } from './evaluation/langfuse-publisher.js';
import { basename, join } from 'node:path';
import { runEvaluationByPath, type EvalItemResult } from './evaluation/runner.js';
import type { DatasetItem } from './evaluation/dataset.js';
import { buildCannedMockModelClient } from './evaluation/canned-mock.js';

const USAGE = `Usage:
  pixiu analyze cost-surprise [flags]   compare analysis window vs baseline; surface anomalies
  pixiu analyze cost-summary [flags]    single-window cost breakdown; no baseline comparison
  pixiu eval <dataset.json> [flags]     replay each dataset item against its fixture and score
  pixiu diagnose [flags]

exit codes:
  0    run completed and all rubrics passed
  1    config error
  2    usage error (unknown command, mutually-exclusive flags, etc.)
  3    run completed but at least one rubric failed
  4    run crashed before producing a report
  5    subscription auto-discovery failed
  6    run wrote its report but cost-evidence retrieval failed for the
       entire scope (e.g. Cost Management 429s across every subscription).
       The report and run.json are still preserved; re-run after the
       upstream throttle window or narrow scope (--max-subscriptions 1).
  99   unhandled error


analyze flags:
  --subscription <id>              Azure subscription GUID. May be repeated. If omitted, the agent auto-discovers the
                                   top 3 subscriptions by resource count via AMG-MCP — and, by default, probes each
                                   candidate's Cost Management read access before final selection so RBAC-denied subs
                                   are dropped from the analysis up front (pass --no-probe-billing to skip).
  --max-subscriptions <n>          When auto-discovering, how many top subscriptions to analyze (default: 3)
  --subscription-name-filter <s>   case-insensitive substring filter on subscription display names. The agent discovers
                                   all visible subscriptions, keeps only those whose name contains <s>, and analyzes
                                   the top N by resource count. Mutually exclusive with --subscription.
  --probe-billing / --no-probe-billing
                                   Toggle the billing-access pre-flight probe (default: enabled). When enabled, each
                                   candidate is probed with a cheap amgmcp_cost_analysis call and only subs that
                                   return a clean payload are eligible for auto-selection. Excluded subs become
                                   billing_probe_excluded data-quality findings.
  --probe-pool-size <n>            Override the probe pool size (default: max(3*max-subscriptions, max+5, 10), cap 25).
  --probe-concurrency <n>          Parallel probe calls (default: 5, max: 10).
  --probe-timeout-ms <n>           Per-probe timeout in milliseconds (default: 15000).
  --probe-cache <path>             Probe-outcome cache file (default: ~/.az-pixiu/billing-probe-cache.json).
  --no-probe-cache                 Disable the probe-outcome cache for this run.
  --billing-cache                  Force-enable the local billing cache for this run. It is ON by
                                   default for cost_summary: finalized-month cost evidence is read
                                   from cache and freshly-retrieved finalized months are written back.
  --no-billing-cache               Disable the local billing cache for this run.
  --resource-group <name>          May be repeated
  --from <iso>                     time_window start (default: now − 7d)
  --to <iso>                       time_window end (default: now)
  --baseline-from <iso>            baseline start (default: time_window.start − 7d)
  --baseline-to <iso>              baseline end (default: time_window.start)
  --resource-type <name>           may be repeated
  --user-context <text>            free-text context for the reasoner (never cited as evidence)
  --fixture <id>                   replay a fixture instead of live AMG-MCP
  --use-playbook                   skip the planner LLM; use the deterministic cost-surprise playbook
  --mock-model                     skip Foundry; use a hard-coded mock model response
  --output-dir <path>              where to write the run subdir (default: runs/)
  --observability <mode>           noop | memory | langfuse | ms-otel  (default: langfuse — requires
                                   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL)
                                   ms-otel uses the Microsoft OpenTelemetry Distro; exports to
                                  Azure Monitor when APPLICATIONINSIGHTS_CONNECTION_STRING is set
                                  or observability.application_insights_connection_string is present
                                  in config.json. The env var wins when both are set.
                                   Langfuse and Phoenix sinks are NOT active in ms-otel mode.
  --credential <mode>              azure-cli | default | mock  (default: azure-cli)

eval flags:
  --use-playbook                   skip the planner LLM; use the deterministic per-analysis playbook (recommended)
  --mock-model                     skip Foundry; use a hard-coded mock reasoning response
  --output-dir <path>              where to write per-item runs (default: runs/eval/)
  --fixtures-root <path>           directory containing fixtures (default: fixtures/)
  --observability <mode>           noop | memory | langfuse | ms-otel  (default: noop for eval runs)
  --credential <mode>              azure-cli | default | mock  (default: mock — eval does not call Azure)
  --models <id1,id2,...>           sweep the dataset against multiple models, one Langfuse Experiment per model.
                                   Each id overrides config.litellm.model (or config.foundry.deployment).
  --experiment-name <name>         base name for the Langfuse Dataset Run (default: derived from dataset + timestamp).
                                   When --models is set, each model gets the suffix ".<model-id>" appended.
  --dataset-name <name>            Langfuse Dataset name to publish items under (default: dataset file basename).

shared flags:
  --config <path>                  path to config.json (default: ./config.json)
  -h, --help                       show this help

env vars (observability):
  LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL   Langfuse credentials
  PHOENIX_BASE_URL                                                Optional Phoenix sink.
                                                                  When set under --observability langfuse,
                                                                  spans are also shipped to <base>/v1/traces
                                                                  via OTLP HTTP, in parallel with Langfuse.
  PHOENIX_API_KEY                                                 Optional Phoenix bearer token.
  APPLICATIONINSIGHTS_CONNECTION_STRING                           Azure App Insights connection string.
                                                                  Enables the Azure Monitor exporter under
                                                                  --observability ms-otel; alternatively set
                                                                  observability.application_insights_connection_string
                                                                  in config.json. To pick up the
                                                                  distro's HTTP / OpenAI-Agents auto-
                                                                  instrumentations, start the process with
                                                                  \`node --import @microsoft/opentelemetry/loader\`.
  AZ_PIXIU_INSTRUMENTATION                                        langfuse | openinference. Pins the OpenAI/MCP
                                                                  instrumentation flavor for the process.
                                                                  Default is a 50/50 random choice per process.
                                                                  Ignored under --observability ms-otel.
`;

interface AnalyzeArgs {
  configPath?: string;
  /** Explicit subscriptions; if empty, the CLI auto-discovers. */
  subscriptions: string[];
  maxSubscriptions: number;
  /**
   * Case-insensitive substring against the subscription display name.
   * Applied at auto-discovery time. cost-summary only.
   */
  subscriptionNameFilter?: string;
  resourceGroups?: string[];
  resourceTypeFilter?: string[];
  from?: string;
  to?: string;
  baselineFrom?: string;
  baselineTo?: string;
  userContext?: string;
  fixture?: string;
  usePlaybook: boolean;
  mockModel: boolean;
  outputDir?: string;
  observability: 'noop' | 'memory' | 'langfuse' | 'ms-otel';
  credentialMode: CredentialMode;
  probeBilling: boolean;
  probePoolSize?: number;
  probeConcurrency?: number;
  probeTimeoutMs?: number;
  probeCachePath?: string;
  probeCacheEnabled: boolean;
}

async function main(): Promise<number> {
  // SIGPIPE-truncation investigation (DESIGN-NOTE.md §Bug B): a prior
  // reviewer reported `pixiu analyze … | tee out | head -25` "exited
  // cleanly but produced no run folder." Manual reproduction created the
  // run folder fine. Node already uses SIG_IGN for SIGPIPE, so a closed
  // downstream pipe surfaces as an `EPIPE` error event on `process.stdout`
  // — which, by the time it fires, lands after `runAnalysis` has already
  // written report.md/run.json inside its ReportAssembly span (see
  // src/run/orchestrator.ts). No behavioural change made here. If a
  // future reproduction shows the run folder genuinely missing, the
  // minimal fix is `process.stdout.on('error', () => {})` in this
  // function — but only do that with evidence in hand; silently
  // swallowing stdout errors hides real bugs in the trace-export tail.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      config: { type: 'string' },
      subscription: { type: 'string', multiple: true },
      'max-subscriptions': { type: 'string' },
      'subscription-name-filter': { type: 'string' },
      'resource-group': { type: 'string', multiple: true },
      'resource-type': { type: 'string', multiple: true },
      from: { type: 'string' },
      to: { type: 'string' },
      'baseline-from': { type: 'string' },
      'baseline-to': { type: 'string' },
      'user-context': { type: 'string' },
      fixture: { type: 'string' },
      'use-playbook': { type: 'boolean' },
      'mock-model': { type: 'boolean' },
      'output-dir': { type: 'string' },
      'fixtures-root': { type: 'string' },
      observability: { type: 'string' },
      models: { type: 'string' },
      'experiment-name': { type: 'string' },
      'dataset-name': { type: 'string' },
      credential: { type: 'string' },
      'probe-billing': { type: 'boolean' },
      'no-probe-billing': { type: 'boolean' },
      'probe-pool-size': { type: 'string' },
      'probe-concurrency': { type: 'string' },
      'probe-timeout-ms': { type: 'string' },
      'probe-cache': { type: 'string' },
      'no-probe-cache': { type: 'boolean' },
      'billing-cache': { type: 'boolean' },
      'no-billing-cache': { type: 'boolean' },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const subcommand = positionals[0];
  if (subcommand === 'analyze') {
    return runAnalyzeCommand(values, positionals);
  }
  if (subcommand === 'eval') {
    return runEvalCommand(values, positionals);
  }
  if (subcommand === 'diagnose') {
    return runDiagnoseCommand(values);
  }

  process.stderr.write(`Unknown command: ${subcommand}\n${USAGE}`);
  return 2;
}

async function runAnalyzeCommand(
  values: Record<string, unknown>,
  positionals: string[],
): Promise<number> {
  const analysisTypeArg = positionals[1];
  const analysisType = cliAnalysisType(analysisTypeArg);
  if (!analysisType) {
    process.stderr.write(
      `analyze: unknown analysis type "${analysisTypeArg ?? '(missing)'}". Phase 1 supports: cost-surprise, cost-summary\n`,
    );
    return 2;
  }
  const explicitSubs = stringArrayOrUndefined(values.subscription) ?? [];
  const maxSubs = parsePositiveInt(values['max-subscriptions'], 3);
  const nameFilter = stringOrUndefined(values['subscription-name-filter']);

  if (nameFilter !== undefined && explicitSubs.length > 0) {
    process.stderr.write(
      `analyze: --subscription-name-filter and --subscription are mutually exclusive. ` +
        `The filter selects subscriptions by name from auto-discovery; --subscription supplies them directly.\n`,
    );
    return 2;
  }

  const probeBilling = !Boolean(values['no-probe-billing']);
  const probePoolSize = parseOptionalPositiveInt(values['probe-pool-size']);
  const probeConcurrency = parseOptionalPositiveInt(values['probe-concurrency']);
  const probeTimeoutMs = parseOptionalPositiveInt(values['probe-timeout-ms']);
  const probeCachePathArg = stringOrUndefined(values['probe-cache']);
  const probeCacheEnabled = !Boolean(values['no-probe-cache']);

  const args: AnalyzeArgs = {
    configPath: stringOrUndefined(values.config),
    subscriptions: explicitSubs,
    maxSubscriptions: maxSubs,
    ...(nameFilter !== undefined ? { subscriptionNameFilter: nameFilter } : {}),
    resourceGroups: stringArrayOrUndefined(values['resource-group']),
    resourceTypeFilter: stringArrayOrUndefined(values['resource-type']),
    from: stringOrUndefined(values.from),
    to: stringOrUndefined(values.to),
    baselineFrom: stringOrUndefined(values['baseline-from']),
    baselineTo: stringOrUndefined(values['baseline-to']),
    userContext: stringOrUndefined(values['user-context']),
    fixture: stringOrUndefined(values.fixture),
    usePlaybook: Boolean(values['use-playbook']),
    mockModel: Boolean(values['mock-model']),
    outputDir: stringOrUndefined(values['output-dir']),
    observability: parseObservability(values.observability),
    credentialMode: parseCredential(values.credential),
    probeBilling,
    ...(probePoolSize !== undefined ? { probePoolSize } : {}),
    ...(probeConcurrency !== undefined ? { probeConcurrency } : {}),
    ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
    ...(probeCachePathArg ? { probeCachePath: probeCachePathArg } : {}),
    probeCacheEnabled,
  };

  let client: MCPClient | undefined;
  try {
    const config = await loadConfig(args.configPath ? { path: args.configPath } : {});

    const credentialIdentity = describeCredential(args.credentialMode);
    const credential = buildCredential(args.credentialMode);

    let transport: MCPTransport;
    if (args.fixture) {
      transport = new FixtureMCPTransport({ fixturePath: `fixtures/${args.fixture}` });
    } else {
      transport = new LiveMCPTransport({ endpoint: config.amg.endpoint, credential });
    }

    client = new MCPClient({ transport });
    await client.discover();

    // Build the shared scope-intake input. When `--subscription` is
    // given we build the Scope here; when it isn't, we hand the same
    // input (minus `subscription_ids`) to `runAnalysis` so the
    // SubscriptionDiscovery span lives inside the same Langfuse trace
    // as the analysis it feeds.
    const scopeIntake = {
      analysis_type: analysisType,
      ...(args.resourceGroups ? { resource_group_names: args.resourceGroups } : {}),
      ...(args.resourceTypeFilter ? { resource_type_filter: args.resourceTypeFilter } : {}),
      ...(args.from ? { time_window_start: args.from } : {}),
      ...(args.to ? { time_window_end: args.to } : {}),
      ...(args.baselineFrom ? { baseline_window_start: args.baselineFrom } : {}),
      ...(args.baselineTo ? { baseline_window_end: args.baselineTo } : {}),
      ...(args.userContext ? { user_context: args.userContext } : {}),
    };
    const scope =
      args.subscriptions.length > 0
        ? intakeScope({ ...scopeIntake, subscription_ids: args.subscriptions })
        : undefined;

    let model: ModelClient;
    let modelProvider: string;
    if (args.mockModel) {
      model = new MockModelClient({
        responses: {
          facts: [],
          hypotheses: [],
          recommendations: [],
          data_quality: [],
        },
      });
      modelProvider = 'mock';
    } else {
      model = buildModelClient(config, credential);
      modelProvider = config.provider;
    }

    const langfusePublisher =
      args.observability === 'langfuse' ? LangfusePublisher.fromEnv() : undefined;
    if (args.observability === 'langfuse' && !langfusePublisher) {
      process.stderr.write(
        '⚠ --observability langfuse without LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL env: ' +
          'trace export may still be attempted by OTLP, but analyze rubric scores will be skipped.\n',
      );
    }

    // Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md
    // §Gap 5). The CLI defaults to the filesystem-backed store reading
    // from the same directory it writes runs to, so prior runs against
    // the same scope are visible without any extra flag. No prior-run
    // context exists for the very first run against a given scope; the
    // store returns [] and the orchestrator behaves as before.
    const runsDir = args.outputDir ?? 'runs';
    const runHistoryStore = new FilesystemRunHistoryStore({ runsDir });

    // Billing-access probe cache — shared across both the auto-discovery
    // path (where the probe gates selection) and the explicit-pick path
    // (where the probe runs but doesn't gate). Cache identity hint is
    // coarse — the credential mode and/or AZURE_USER env are stable
    // enough partitions to keep entries from bleeding across operators
    // sharing a workstation.
    const probeCache = args.probeBilling && args.probeCacheEnabled
      ? new BillingProbeCache({
          path: args.probeCachePath ?? defaultCachePath(),
          endpoint: config.amg.endpoint,
          identityHint: `${args.credentialMode}:${process.env.AZURE_USER ?? 'default'}`,
        })
      : undefined;

    const probeConfig = args.probeBilling
      ? {
          enabled: true,
          ...(args.probePoolSize !== undefined ? { poolSize: args.probePoolSize } : {}),
          ...(args.probeConcurrency !== undefined ? { concurrency: args.probeConcurrency } : {}),
          ...(args.probeTimeoutMs !== undefined ? { timeoutMs: args.probeTimeoutMs } : {}),
          ...(probeCache ? { cache: probeCache } : {}),
        }
      : undefined;

    // Local billing cache (docs/design/local-billing-cache.md). ON by
    // default for cost_summary; `--no-billing-cache` opts out for one run
    // and `billing_cache.enabled: false` disables it persistently. The
    // store is partitioned by the AMG-MCP endpoint only — billing data is a
    // property of the endpoint + subscription + month, and the credential
    // *mode* is not an identity, so no identity hint is supplied. By default
    // the cache lives
    // alongside the run output (`<output-dir>/billing-cache/v1`, i.e.
    // `runs/billing-cache/v1`), which is already gitignored; set
    // `billing_cache.root` to relocate it (e.g. ~/.az-pixiu or an
    // encrypted volume) for out-of-tree storage.
    const billingCacheEnabled = Boolean(values['no-billing-cache'])
      ? false
      : Boolean(values['billing-cache']) || (config.billing_cache?.enabled ?? true);
    const billingCacheOption =
      billingCacheEnabled && analysisType === 'cost_summary'
        ? {
            store: new FileBillingCacheStore({
              endpoint: config.amg.endpoint,
              root: config.billing_cache?.root ?? join(runsDir, 'billing-cache', 'v1'),
            }),
            costView: config.billing_cache?.cost_view ?? 'amortized',
            policy: {
              stabilizationOffsetDays: config.billing_cache?.stabilization_offset_days ?? 5,
              invoiceCloseHorizonMonths: config.billing_cache?.invoice_close_horizon_months ?? 2,
            },
          }
        : undefined;

    // Explicit-pick mode: probe still runs but does not gate selection.
    // Findings flow in as `preflightDataQuality` so the report surfaces
    // them, but the operator's choice stands.
    let preflightDataQuality: DataQualityFinding[] | undefined;
    if (scope && args.probeBilling && !args.fixture) {
      preflightDataQuality = await probeExplicitSubscriptions(
        client,
        args.subscriptions,
        probeConfig!,
      );
    }

    const result = await runAnalysis({
      config,
      ...(scope
        ? { scope }
        : {
            discoverSubscriptions: {
              maxSubscriptions: args.maxSubscriptions,
              scopeIntake,
              ...(args.subscriptionNameFilter !== undefined
                ? { nameFilter: args.subscriptionNameFilter }
                : {}),
              ...(probeConfig ? { probe: probeConfig } : {}),
            },
          }),
      client,
      model,
      modelProvider,
      credentialIdentity,
      usePlaybook: args.usePlaybook,
      runsDir,
      observabilityMode: args.observability,
      ...(config.observability?.application_insights_connection_string
        ? {
            applicationInsightsConnectionString:
              config.observability.application_insights_connection_string,
          }
        : {}),
      ...(args.fixture ? { fixtureId: args.fixture } : {}),
      ...(langfusePublisher ? { langfusePublisher } : {}),
      runHistoryStore,
      ...(billingCacheOption ? { billingCache: billingCacheOption } : {}),
      ...(preflightDataQuality && preflightDataQuality.length > 0
        ? { preflightDataQuality }
        : {}),
    });

    // Exit-code precedence (DESIGN-NOTE.md):
    //   6  cost retrieval failed across the entire scope — the loudest
    //      failure mode; the report contains zero grounded recommendations
    //      and the analysis is not actionable. Surfaced first so it
    //      eclipses the rubric-failure code.
    //   3  rubrics failed but the analysis still produced grounded output.
    //   0  success.
    if (result.cost_retrieval_outcome === 'failed') return 6;
    return result.score.passed_all ? 0 : 3;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof SubscriptionDiscoveryError) {
      process.stderr.write(`Subscription discovery: ${err.message}\n`);
      return 5;
    }
    process.stderr.write(`Run failed: ${describe(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    return 4;
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

/**
 * Probe each explicitly-named subscription's billing access, log the
 * outcomes, and return one DQ finding per non-pass. Operator's choice
 * is never overridden — selection is whatever was passed on the CLI —
 * but the report surfaces the probe outcome so the operator sees
 * billing-access state up front.
 */
async function probeExplicitSubscriptions(
  client: MCPClient,
  subscriptionIds: string[],
  probeConfig: {
    enabled: boolean;
    poolSize?: number;
    concurrency?: number;
    timeoutMs?: number;
    cache?: BillingProbeCache;
  },
): Promise<DataQualityFinding[]> {
  if (!probeConfig.enabled || subscriptionIds.length === 0) return [];
  process.stdout.write(
    `→ probing ${subscriptionIds.length} explicit subscription(s) for Cost Management read access...\n`,
  );
  const run = await probeBillingAccess(client, subscriptionIds, {
    ...(probeConfig.concurrency !== undefined ? { concurrency: probeConfig.concurrency } : {}),
    ...(probeConfig.timeoutMs !== undefined ? { timeoutMs: probeConfig.timeoutMs } : {}),
    ...(probeConfig.cache ? { cache: probeConfig.cache } : {}),
    onProbe: (event) => {
      process.stdout.write(
        `    probe ${event.outcome}${event.classification ? ` (${event.classification})` : ''}${event.cache_hit ? ' [cache]' : ''}: ${event.subscription_id} (${event.latency_ms}ms)\n`,
      );
    },
  });
  const dq: DataQualityFinding[] = [];
  for (const result of run.results) {
    if (result.outcome === 'pass') continue;
    dq.push(
      DataQualityFindingSchema.parse({
        dq_id: `dq-probe-${dq.length + 1}`,
        category: 'billing_probe_excluded',
        affected_capability: 'amgmcp_cost_analysis',
        affected_scope_subset: {
          subscription_ids: [result.subscription_id],
          resource_group_names: null,
          resource_ids: null,
        },
        consequence_for_analysis:
          `Subscription ${result.subscription_id} was explicitly named on the CLI but the billing-access probe ` +
          `returned ${result.outcome}${result.classification ? `: ${result.classification}` : ''}. The Cost Management API returned: "${result.message ?? 'no upstream message'}". ` +
          `The run will proceed because --subscription is an operator override; any actual cost-analysis failure for this sub will surface as a separate retrieval-stage finding.`,
        impact_on_recommendations: [],
        actionable_hint:
          'Grant the Grafana data-source principal Cost Management Reader on this subscription, or pass --no-probe-billing to skip the pre-flight check.',
      }),
    );
  }
  return dq;
}

async function runEvalCommand(
  values: Record<string, unknown>,
  positionals: string[],
): Promise<number> {
  const datasetPath = positionals[1];
  if (!datasetPath) {
    process.stderr.write('eval: missing dataset path. Usage: pixiu eval <dataset.json>\n');
    return 2;
  }

  const usePlaybook = Boolean(values['use-playbook']);
  const mockModel = Boolean(values['mock-model']);
  // Eval defaults differ from `analyze`: by default eval is fully offline
  // (fixture transport, mock credential, noop observability) so that it
  // can be run in CI without external dependencies. Operators who want a
  // real-LLM eval pass `--credential azure-cli` and (optionally)
  // `--observability langfuse`. The planner LLM is still optional;
  // `--use-playbook` is recommended for determinism.
  const credentialMode = parseCredential(values.credential ?? 'mock');
  const observabilityMode = parseObservability(values.observability ?? 'noop');
  const fixturesRoot = stringOrUndefined(values['fixtures-root']) ?? 'fixtures';
  const outputDir = stringOrUndefined(values['output-dir']) ?? 'runs/eval';
  const configPath = stringOrUndefined(values.config);
  const modelsArg = stringOrUndefined(values.models);
  const experimentBase = stringOrUndefined(values['experiment-name']);
  const datasetNameOverride = stringOrUndefined(values['dataset-name']);

  if (mockModel && !usePlaybook) {
    process.stderr.write(
      'eval --mock-model requires --use-playbook (the planner LLM is not mocked).\n',
    );
    return 2;
  }
  if (modelsArg && mockModel) {
    process.stderr.write('eval --models cannot be combined with --mock-model.\n');
    return 2;
  }

  try {
    const config = await loadConfig(configPath ? { path: configPath } : {});
    const credential = buildCredential(credentialMode);
    const credentialIdentity = describeCredential(credentialMode);

    // Default the Langfuse dataset name to the file basename so the same
    // local dataset always maps to the same Langfuse-side dataset, and
    // generate a timestamped experiment-name base unless the operator
    // pinned one.
    const datasetName = datasetNameOverride ?? basename(datasetPath).replace(/\.[^.]+$/, '');
    const experimentBaseName =
      experimentBase ?? `${datasetName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    // Try to construct a Langfuse publisher when observability is
    // langfuse. We only publish when we have both an OTel trace ID (a
    // function of observabilityMode === 'langfuse') AND the env vars
    // needed. When either is missing the runner falls back to local-only.
    const langfusePublisher =
      observabilityMode === 'langfuse' ? LangfusePublisher.fromEnv() : undefined;
    if (observabilityMode === 'langfuse' && !langfusePublisher) {
      process.stderr.write(
        '⚠ --observability langfuse without LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL env: ' +
          'agent runs will still trace via OTLP, but eval scores + experiment grouping will be skipped.\n',
      );
    }

    // Sweep: when --models is set, run the dataset once per model with
    // an experiment-name-suffix per model. Otherwise run once against
    // whatever's already in config.
    const models = modelsArg
      ? modelsArg.split(',').map((s) => s.trim()).filter(Boolean)
      : [undefined]; // sentinel: use config as-is

    const perRunResults: Array<{
      model: string;
      experimentName: string;
      result: Awaited<ReturnType<typeof runEvaluationByPath>>;
    }> = [];

    for (const modelOverride of models) {
      // Mutate the in-memory config object so the model client picks up
      // the override. This is local to this CLI invocation only — we
      // never write back to disk.
      if (modelOverride !== undefined) {
        if (config.provider === 'litellm') {
          config.litellm!.model = modelOverride;
        } else {
          config.foundry!.deployment = modelOverride;
        }
      }
      const activeModelLabel = mockModel
        ? 'mock (canned reasoning)'
        : config.provider === 'litellm'
          ? `litellm/${config.litellm!.model}`
          : `foundry/${config.foundry!.deployment}`;
      const activeModelId =
        config.provider === 'litellm' ? config.litellm!.model : config.foundry!.deployment;

      const makeModel = mockModel
        ? (_item: DatasetItem): ModelClient => buildCannedMockModelClient()
        : (_item: DatasetItem): ModelClient => buildModelClient(config, credential);

      const experimentName = modelOverride
        ? `${experimentBaseName}.${activeModelId}`
        : experimentBaseName;

      process.stdout.write(`\n=== pixiu eval on ${datasetPath} ===\n`);
      process.stdout.write(`  fixtures: ${fixturesRoot}\n`);
      process.stdout.write(`  model: ${activeModelLabel}\n`);
      process.stdout.write(`  planner: ${usePlaybook ? 'playbook' : 'planner LLM'}\n`);
      process.stdout.write(`  observability: ${observabilityMode}\n`);
      if (langfusePublisher) {
        process.stdout.write(`  langfuse dataset: ${datasetName}\n`);
        process.stdout.write(`  langfuse experiment: ${experimentName}\n`);
      }
      process.stdout.write('\n');

      const result = await runEvaluationByPath(datasetPath, {
        config,
        makeModel,
        modelProvider: mockModel ? 'mock' : config.provider,
        credentialIdentity,
        usePlaybook,
        runsDir: outputDir,
        observabilityMode,
        ...(config.observability?.application_insights_connection_string
          ? {
              applicationInsightsConnectionString:
                config.observability.application_insights_connection_string,
            }
          : {}),
        fixturesRoot,
        onProgress: (line) => process.stdout.write(line + '\n'),
        ...(langfusePublisher
          ? {
              langfusePublisher,
              langfuseDatasetName: datasetName,
              langfuseRunName: experimentName,
              langfuseRunMetadata: {
                model_provider: config.provider,
                model_name: activeModelId,
                planner: usePlaybook ? 'playbook' : 'planner_llm',
              },
            }
          : {}),
      });

      perRunResults.push({ model: activeModelId, experimentName, result });
    }

    process.stdout.write('\n=== summary ===\n');
    let overallOk = true;
    for (const { model, experimentName, result } of perRunResults) {
      process.stdout.write(`\nmodel: ${model}\n`);
      if (langfusePublisher) {
        process.stdout.write(`experiment: ${experimentName}\n`);
      }
      for (const item of result.items) {
        printEvalItem(item);
      }
      process.stdout.write(
        `${result.passed_all ? 'PASS' : 'FAIL'}: ${result.pass_count}/${result.items.length} item(s) green\n`,
      );
      if (!result.passed_all) overallOk = false;
    }
    return overallOk ? 0 : 3;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`eval failed: ${describe(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    return 4;
  }
}

function printEvalItem(item: EvalItemResult): void {
  const status = item.passed_all ? '✓' : '✖';
  process.stdout.write(`${status} ${item.item_id} (fixture: ${item.fixture_id})\n`);
  if (item.error) {
    process.stdout.write(`    runtime error: ${item.error}\n`);
    return;
  }
  for (const r of item.score.results) {
    process.stdout.write(`    rubric ${r.passed ? '✓' : '✖'} ${r.rubric}`);
    if (!r.passed && r.details) process.stdout.write(`: ${r.details}`);
    process.stdout.write('\n');
  }
  for (const e of item.expectations.results) {
    process.stdout.write(`    expect ${e.passed ? '✓' : '✖'} ${e.expectation}`);
    if (!e.passed && e.details) process.stdout.write(`: ${e.details}`);
    process.stdout.write('\n');
  }
  process.stdout.write(`    report: ${item.report_path}\n`);
}

async function runDiagnoseCommand(values: Record<string, unknown>): Promise<number> {
  try {
    const config = await loadConfig(
      values.config && typeof values.config === 'string' ? { path: values.config } : {},
    );
    const credentialMode = parseCredential(values.credential);
    const credential = buildCredential(credentialMode);
    const identity = describeCredential(credentialMode);

    process.stdout.write(`Running pixiu diagnose (credential: ${identity.implementation})...\n\n`);
    const result: DiagnoseResult = await diagnose(config, credential, identity);
    for (const r of result.results) {
      const tag = r.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`  [${tag}] ${r.name}\n        ${r.detail}\n`);
      if (!r.ok && r.hint) process.stdout.write(`        hint: ${r.hint}\n`);
    }
    process.stdout.write(`\n${result.ok ? 'All checks passed.' : 'Some checks failed.'}\n`);
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Config error: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`diagnose failed: ${describe(err)}\n`);
    return 4;
  }
}

// --- helpers ---

/**
 * Build the configured ModelClient. The Foundry path needs Entra ID auth
 * (the credential), while the LiteLLM path ignores it — LiteLLM auth is
 * an optional bearer token carried in the config itself.
 */
function buildModelClient(config: Config, credential: TokenCredential): ModelClient {
  if (config.provider === 'litellm') {
    const l = config.litellm!;
    return new LiteLLMModelClient({
      endpoint: l.endpoint,
      model: l.model,
      ...(l.api_key ? { apiKey: l.api_key } : {}),
    });
  }
  const f = config.foundry!;
  return new OpenAIModelClient({
    endpoint: f.endpoint,
    deployment: f.deployment,
    apiVersion: f.api_version,
    credential,
  });
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function stringArrayOrUndefined(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === 'string');
  return arr.length > 0 ? arr : undefined;
}

function parseObservability(v: unknown): 'noop' | 'memory' | 'langfuse' | 'ms-otel' {
  if (v === 'noop' || v === 'memory' || v === 'langfuse' || v === 'ms-otel') return v;
  return 'langfuse';
}

function parseCredential(v: unknown): CredentialMode {
  if (v === 'azure-cli' || v === 'default' || v === 'mock') return v;
  return 'azure-cli';
}

function parsePositiveInt(v: unknown, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseOptionalPositiveInt(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function cliAnalysisType(v: unknown): 'cost_surprise' | 'cost_summary' | undefined {
  if (v === 'cost-surprise') return 'cost_surprise';
  if (v === 'cost-summary') return 'cost_summary';
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Set process.exitCode rather than calling process.exit() so any background
// I/O queued by the observability stack — notably the Microsoft OTEL Distro
// exporter, whose shutdown() resolves before the underlying HTTP POST to
// the Azure Monitor ingestion endpoint completes — gets a chance to drain
// before Node exits. process.exit() terminates pending requests; this
// pattern lets them complete and exits with the chosen code once the event
// loop is empty.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exitCode = 99;
  },
);
