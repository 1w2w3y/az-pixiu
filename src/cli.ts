import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config.js';
import { intakeScope } from './run/scope-intake.js';
import { runAnalysis } from './run/orchestrator.js';
import { diagnose, type DiagnoseResult } from './run/diagnose.js';
import {
  buildCredential,
  describeCredential,
  type CredentialMode,
} from './run/credential-factory.js';
import { FixtureMCPTransport } from './mcp/fixture.js';
import { LiveMCPTransport } from './mcp/live.js';
import type { MCPTransport } from './mcp/transport.js';
import { OpenAIModelClient } from './model/openai-client.js';
import { MockModelClient } from './model/mock-client.js';
import type { ModelClient } from './model/client.js';

const USAGE = `Usage:
  pixiu analyze cost-surprise --subscription <id> [flags]
  pixiu diagnose [flags]

analyze flags:
  --subscription <id>              Azure subscription GUID (required)
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
  --observability <mode>           noop | memory | langfuse  (default: memory)
  --credential <mode>              azure-cli | default | mock  (default: azure-cli)

shared flags:
  --config <path>                  path to config.json (default: ./config.json)
  -h, --help                       show this help
`;

interface AnalyzeArgs {
  configPath?: string;
  subscription: string;
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
      subscription: { type: 'string' },
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
  const analysisType = positionals[1];
  if (analysisType !== 'cost-surprise') {
    process.stderr.write(
      `analyze: unknown analysis type "${analysisType ?? '(missing)'}". Phase 1 supports: cost-surprise\n`,
    );
    return 2;
  }
  if (!values.subscription || typeof values.subscription !== 'string') {
    process.stderr.write('analyze cost-surprise: --subscription is required.\n');
    return 2;
  }

  const args: AnalyzeArgs = {
    configPath: stringOrUndefined(values.config),
    subscription: values.subscription,
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

  try {
    const config = await loadConfig(args.configPath ? { path: args.configPath } : {});
    const scope = intakeScope({
      subscription_id: args.subscription,
      ...(args.resourceGroups ? { resource_group_names: args.resourceGroups } : {}),
      ...(args.resourceTypeFilter ? { resource_type_filter: args.resourceTypeFilter } : {}),
      ...(args.from ? { time_window_start: args.from } : {}),
      ...(args.to ? { time_window_end: args.to } : {}),
      ...(args.baselineFrom ? { baseline_window_start: args.baselineFrom } : {}),
      ...(args.baselineTo ? { baseline_window_end: args.baselineTo } : {}),
      ...(args.userContext ? { user_context: args.userContext } : {}),
    });

    const credentialIdentity = describeCredential(args.credentialMode);
    const credential = buildCredential(args.credentialMode);

    let transport: MCPTransport;
    if (args.fixture) {
      transport = new FixtureMCPTransport({ fixturePath: `fixtures/${args.fixture}` });
    } else {
      transport = new LiveMCPTransport({ endpoint: config.amg.endpoint, credential });
    }

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
      scope,
      transport,
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
    process.stderr.write(`Run failed: ${describe(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    return 4;
  }
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
  return 'memory';
}

function parseCredential(v: unknown): CredentialMode {
  if (v === 'azure-cli' || v === 'default' || v === 'mock') return v;
  return 'azure-cli';
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
