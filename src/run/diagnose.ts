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

const AMG_SCOPE = 'ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default';
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

  // 3. Foundry-scoped token (construction only — we don't spend model tokens here)
  try {
    const token = await credential.getToken(FOUNDRY_SCOPE);
    if (!token) throw new Error('credential returned null token');
    results.push({
      name: 'foundry_token',
      ok: true,
      detail: `Acquired Foundry-scoped token. Endpoint: ${config.foundry.endpoint}, deployment: ${config.foundry.deployment}.`,
    });
  } catch (err) {
    results.push({
      name: 'foundry_token',
      ok: false,
      detail: `Could not acquire Foundry-scoped token: ${describe(err)}`,
      hint: 'Confirm your identity has Cognitive Services User role on the Foundry resource.',
    });
  }

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
