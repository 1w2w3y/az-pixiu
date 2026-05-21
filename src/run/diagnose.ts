import type { TokenCredential } from '@azure/identity';
import { LiveMCPTransport } from '../mcp/live.js';
import { MCPClient, assertRequiredCapabilities } from '../mcp/client.js';
import type { Config } from '../schemas/index.js';
import type { CredentialIdentity } from './credential-factory.js';

/**
 * `pixiu diagnose` — preflight checks before a real run.
 *
 * Verifies, in order:
 *   1. The configured TokenCredential can mint an AMG-scoped token
 *      (covers `az login` not done, expired, missing role, etc.)
 *   2. AMG-MCP `listTools` returns the expected Phase 1 capability set
 *   3. The configured Foundry endpoint at least responds to the
 *      cognitiveservices scope acquisition (full call deferred — we
 *      don't want diagnose to spend tokens)
 *
 * Each check produces a CheckResult; nothing throws unless the
 * operator passed an unusable config.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DiagnoseResult {
  ok: boolean;
  results: CheckResult[];
}

const AMG_SCOPE = '6f2d169c-08f3-4a4c-a982-bcaf2d038c45/.default';
const FOUNDRY_SCOPE = 'https://cognitiveservices.azure.com/.default';

export async function diagnose(
  config: Config,
  credential: TokenCredential,
  credentialIdentity: CredentialIdentity,
): Promise<DiagnoseResult> {
  const results: CheckResult[] = [];

  // 1. AMG-scoped token
  let amgTokenOk = false;
  try {
    const token = await credential.getToken(AMG_SCOPE);
    if (!token) throw new Error('credential returned null token');
    amgTokenOk = true;
    results.push({
      name: 'amg_token',
      ok: true,
      detail: `Acquired AMG-scoped token via ${credentialIdentity.implementation}.`,
    });
  } catch (err) {
    results.push({
      name: 'amg_token',
      ok: false,
      detail: `Could not acquire AMG-scoped token: ${describe(err)}`,
      hint: 'Run `az login` if using AzureCliCredential. Confirm your identity has a Grafana role on the AMG resource.',
    });
  }

  // 2. AMG-MCP capability discovery (only attempt if token works)
  if (amgTokenOk) {
    let transport: LiveMCPTransport | undefined;
    try {
      transport = new LiveMCPTransport({ endpoint: config.amg.endpoint, credential });
      const client = new MCPClient({ transport });
      const catalog = await client.discover();
      try {
        assertRequiredCapabilities(catalog, 'cost_surprise');
        results.push({
          name: 'amg_mcp_capabilities',
          ok: true,
          detail: `AMG-MCP advertises ${catalog.allowed.length} allowed capability/capabilities including the four required for cost_surprise.`,
        });
      } catch (err) {
        results.push({
          name: 'amg_mcp_capabilities',
          ok: false,
          detail: describe(err),
          hint: 'Check whether your AMG version exposes cost_analysis, query_azure_subscriptions, query_resource_graph, and query_resource_metric_definition.',
        });
      }
      await client.close();
    } catch (err) {
      results.push({
        name: 'amg_mcp_capabilities',
        ok: false,
        detail: `Could not reach AMG-MCP: ${describe(err)}`,
        hint: 'Confirm AMG-MCP is enabled on your Azure Managed Grafana instance and the path under the endpoint is /mcp (or pass --amg-mcp-path).',
      });
    }
  }

  // 3. Model provider preflight. Foundry uses Entra ID, so we check we
  //    can mint a Cognitive Services token without actually spending
  //    model quota. LiteLLM is OpenAI-compatible over plain HTTP(S);
  //    we GET /v1/models as the cheapest signal that the gateway is
  //    reachable and recognizes the configured model id.
  if (config.provider === 'litellm') {
    await diagnoseLiteLLM(config.litellm!, results);
  } else {
    await diagnoseFoundry(config.foundry!, credential, results);
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

async function diagnoseFoundry(
  foundry: NonNullable<Config['foundry']>,
  credential: TokenCredential,
  results: CheckResult[],
): Promise<void> {
  try {
    const token = await credential.getToken(FOUNDRY_SCOPE);
    if (!token) throw new Error('credential returned null token');
    results.push({
      name: 'foundry_token',
      ok: true,
      detail: `Acquired Foundry-scoped token. Endpoint: ${foundry.endpoint}, deployment: ${foundry.deployment}.`,
    });
  } catch (err) {
    results.push({
      name: 'foundry_token',
      ok: false,
      detail: `Could not acquire Foundry-scoped token: ${describe(err)}`,
      hint: 'Confirm your identity has Cognitive Services User role on the Foundry resource.',
    });
  }
}

async function diagnoseLiteLLM(
  litellm: NonNullable<Config['litellm']>,
  results: CheckResult[],
): Promise<void> {
  const base = litellm.endpoint.replace(/\/+$/, '');
  const url = `${base}/v1/models`;
  const headers: Record<string, string> = {};
  if (litellm.api_key) headers['Authorization'] = `Bearer ${litellm.api_key}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      results.push({
        name: 'litellm_reachable',
        ok: false,
        detail: `GET ${url} returned HTTP ${res.status}.`,
        hint: 'Confirm the LiteLLM endpoint is correct and (if required) the api_key has access.',
      });
      return;
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((s): s is string => !!s);
    if (ids.length === 0) {
      results.push({
        name: 'litellm_reachable',
        ok: true,
        detail: `LiteLLM at ${litellm.endpoint} responded but advertised no models. Configured model: ${litellm.model}.`,
      });
      return;
    }
    const known = ids.includes(litellm.model);
    results.push({
      name: 'litellm_reachable',
      ok: known,
      detail: known
        ? `LiteLLM at ${litellm.endpoint} advertises ${ids.length} model(s); configured model "${litellm.model}" is present.`
        : `LiteLLM at ${litellm.endpoint} advertises ${ids.length} model(s) but "${litellm.model}" is not among them.`,
      ...(known
        ? {}
        : { hint: `Pick one of the advertised models: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? '…' : ''}` }),
    });
  } catch (err) {
    results.push({
      name: 'litellm_reachable',
      ok: false,
      detail: `Could not reach LiteLLM at ${url}: ${describe(err)}`,
      hint: 'Check the endpoint URL (https vs http), DNS, and network reachability.',
    });
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
