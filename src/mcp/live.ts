import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { TokenCredential } from '@azure/identity';
import type { MCPTransport } from './transport.js';
import {
  CapabilityCatalogSchema,
  ToolCallResultSchema,
  type CapabilityCatalog,
  type ToolCallResult,
} from '../schemas/index.js';

/**
 * Live MCP transport for AMG-MCP (design §4.3, §15.4, §15.9).
 *
 * Status: written, **not yet smoke-tested against a real AMG-MCP
 * instance**. Lands as the sequencing-step-11 deliverable.
 *
 * Auth handshake:
 *   - Az-Pixiu mints a bearer token via the supplied TokenCredential
 *     with the Azure Managed Grafana resource scope **on every request**
 *     (via a custom fetch). The @azure/identity credential cache handles
 *     short-circuiting repeated mints within token lifetime.
 *   - Building the header once at connect time (as an earlier draft did)
 *     would freeze the token for the lifetime of the transport — long
 *     runs would 401 after ~1h when the token expired. Per-request
 *     acquisition makes the run idle-tolerant.
 *   - Downstream Azure data-plane auth (Cost Management, ARG, Azure
 *     Monitor) is handled inside the AMG-MCP server.
 *
 * Failure surface intentionally minimal: errors propagate as thrown
 * objects; the failure_taxonomy (§4.4) interprets them downstream.
 */

const AMG_RESOURCE_SCOPE = 'ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default';

export interface LiveMCPTransportOptions {
  /** Base URL of the AMG-MCP server (Grafana host). */
  endpoint: string;
  /** TokenCredential resolved by config (§15.9). */
  credential: TokenCredential;
  /** Path under endpoint where the streamable-HTTP MCP server lives. */
  mcpPath?: string;
  /** Client identification reported to the server. */
  clientName?: string;
  clientVersion?: string;
  /** Optional fetch override, primarily for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class LiveMCPTransport implements MCPTransport {
  private readonly endpoint: string;
  private readonly mcpPath: string;
  private readonly credential: TokenCredential;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly fetchImpl: typeof fetch;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(options: LiveMCPTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.mcpPath = options.mcpPath ?? '/api/azure-mcp';
    this.credential = options.credential;
    this.clientName = options.clientName ?? 'az-pixiu';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;

    const url = new URL(this.mcpPath, this.endpoint + '/');
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: this.buildAuthenticatedFetch(),
    });

    const client = new Client({
      name: this.clientName,
      version: this.clientVersion,
    });
    await client.connect(transport);

    this.client = client;
    this.transport = transport;
    return client;
  }

  /**
   * Build a fetch that mints a fresh Entra ID token per request. The
   * @azure/identity credential caches tokens until ~5 minutes before
   * expiry, so this is cheap in steady state but never holds a stale token.
   */
  private buildAuthenticatedFetch(): (url: string | URL, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
      const token = await this.credential.getToken(AMG_RESOURCE_SCOPE);
      if (!token) {
        throw new Error(
          `Could not acquire AMG-MCP token from credential. Run \`az login\` if using AzureCliCredential.`,
        );
      }
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token.token}`);
      return this.fetchImpl(url, { ...init, headers });
    };
  }

  async listCapabilities(): Promise<CapabilityCatalog> {
    const client = await this.ensureConnected();
    const response = await client.listTools();
    const catalog = {
      capabilities: response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // MCP TS SDK doesn't carry a version field on tools today; if
        // AMG-MCP later exposes one we'll surface it here.
      })),
    };
    return CapabilityCatalogSchema.parse(catalog);
  }

  async invoke(
    capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: capability,
      arguments: parameters,
    });
    return ToolCallResultSchema.parse({
      content: result.content,
      isError: result.isError,
    });
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
      this.client = undefined;
    }
  }
}
