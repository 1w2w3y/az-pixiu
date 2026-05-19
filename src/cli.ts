import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config.js';
import { intakeScope } from './run/scope-intake.js';
import { runAnalysis } from './run/orchestrator.js';
import { diagnose, type DiagnoseResult } from './run/diagnose.js';
import { SubscriptionDiscoveryError } from './run/subscription-discovery.js';
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
import { MockModelClient } from './model/mock-client.js';
import type { ModelClient } from './model/client.js';
import { runEvaluationByPath, type EvalItemResult } from './evaluation/runner.js';
import type { DatasetItem } from './evaluation/dataset.js';
import { buildCannedMockModelClient } from './evaluation/canned-mock.js';

const USAGE = `Usage:
  pixiu analyze cost-surprise [flags]   compare analysis window vs baseline; surface anomalies
  pixiu analyze cost-summary [flags]    single-window cost breakdown; no baseline comparison
  pixiu eval <dataset.json> [flags]     replay each dataset item against its fixture and score
  pixiu diagnose [flags]

analyze flags:
  --subscription <id>              Azure subscription GUID. May be repeated. If omitted, the agent auto-discovers the top 3 subscriptions by resource count via AMG-MCP.
  --max-subscriptions <n>          When auto-discovering, how many top subscriptions to analyze (default: 3)
  --subscription-name-filter <s>   cost-summary only: case-insensitive substring filter on subscription display names.
                                   The agent discovers all visible subscriptions, keeps only those whose name contains
                                   <s>, and analyzes the top N by resource count. Mutually exclusive with --subscription.
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
  --observability <mode>           noop | memory | langfuse  (default: langfuse — requires
                                   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL)
  --credential <mode>              azure-cli | default | mock  (default: azure-cli)

eval flags:
  --use-playbook                   skip the planner LLM; use the deterministic per-analysis playbook (recommended)
  --mock-model                     skip Foundry; use a hard-coded mock reasoning response
  --output-dir <path>              where to write per-item runs (default: runs/eval/)
  --fixtures-root <path>           directory containing fixtures (default: fixtures/)
  --observability <mode>           noop | memory | langfuse  (default: noop for eval runs)
  --credential <mode>              azure-cli | default | mock  (default: mock — eval does not call Azure)

shared flags:
  --config <path>                  path to config.json (default: ./config.json)
  -h, --help                       show this help
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
  observability: 'noop' | 'memory' | 'langfuse';
  credentialMode: CredentialMode;
}

async function main(): Promise<number> {
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
      credential: { type: 'string' },
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

  // --subscription-name-filter is a cost-summary-only flag in Phase 2.
  // The discovery code itself is general, but the cost-summary fan-out
  // is the use case the PRD scopes it to (see docs/prd/cli-experience.md
  // FR-16). Reject it elsewhere so the surface stays honest until a
  // second analysis type opts in.
  if (nameFilter !== undefined && analysisType !== 'cost_summary') {
    process.stderr.write(
      `analyze: --subscription-name-filter is only supported for cost-summary in this phase ` +
        `(passed with: ${analysisType.replace('_', '-')}).\n`,
    );
    return 2;
  }
  if (nameFilter !== undefined && explicitSubs.length > 0) {
    process.stderr.write(
      `analyze: --subscription-name-filter and --subscription are mutually exclusive. ` +
        `The filter selects subscriptions by name from auto-discovery; --subscription supplies them directly.\n`,
    );
    return 2;
  }

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
      model = new OpenAIModelClient({
        endpoint: config.foundry.endpoint,
        deployment: config.foundry.deployment,
        apiVersion: config.foundry.api_version,
        credential,
      });
      modelProvider = 'foundry';
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
            },
          }),
      client,
      model,
      modelProvider,
      credentialIdentity,
      usePlaybook: args.usePlaybook,
      ...(args.outputDir ? { runsDir: args.outputDir } : {}),
      observabilityMode: args.observability,
      ...(args.fixture ? { fixtureId: args.fixture } : {}),
    });

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

  if (mockModel && !usePlaybook) {
    process.stderr.write(
      'eval --mock-model requires --use-playbook (the planner LLM is not mocked).\n',
    );
    return 2;
  }

  try {
    const config = await loadConfig(configPath ? { path: configPath } : {});
    const credential = buildCredential(credentialMode);
    const credentialIdentity = describeCredential(credentialMode);

    const makeModel = mockModel
      ? (_item: DatasetItem): ModelClient => buildCannedMockModelClient()
      : (_item: DatasetItem): ModelClient =>
          new OpenAIModelClient({
            endpoint: config.foundry.endpoint,
            deployment: config.foundry.deployment,
            apiVersion: config.foundry.api_version,
            credential,
          });

    process.stdout.write(`Running pixiu eval on ${datasetPath}\n`);
    process.stdout.write(`  fixtures: ${fixturesRoot}\n`);
    process.stdout.write(
      `  model: ${mockModel ? 'mock (canned reasoning)' : `foundry/${config.foundry.deployment}`}\n`,
    );
    process.stdout.write(`  planner: ${usePlaybook ? 'playbook' : 'planner LLM'}\n`);
    process.stdout.write(`  observability: ${observabilityMode}\n\n`);

    const result = await runEvaluationByPath(datasetPath, {
      config,
      makeModel,
      modelProvider: mockModel ? 'mock' : 'foundry',
      credentialIdentity,
      usePlaybook,
      runsDir: outputDir,
      observabilityMode,
      fixturesRoot,
      onProgress: (line) => process.stdout.write(line + '\n'),
    });

    process.stdout.write('\n--- summary ---\n');
    for (const item of result.items) {
      printEvalItem(item);
    }
    process.stdout.write(
      `\n${result.passed_all ? 'PASS' : 'FAIL'}: ${result.pass_count}/${result.items.length} item(s) green\n`,
    );
    return result.passed_all ? 0 : 3;
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

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function stringArrayOrUndefined(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === 'string');
  return arr.length > 0 ? arr : undefined;
}

function parseObservability(v: unknown): 'noop' | 'memory' | 'langfuse' {
  if (v === 'noop' || v === 'memory' || v === 'langfuse') return v;
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

function cliAnalysisType(v: unknown): 'cost_surprise' | 'cost_summary' | undefined {
  if (v === 'cost-surprise') return 'cost_surprise';
  if (v === 'cost-summary') return 'cost_summary';
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exit(99);
  },
);
