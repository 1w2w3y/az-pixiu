import type { CapabilityCatalog, ToolCallResult } from '../schemas/index.js';

/**
 * The single seam between the agent and AMG-MCP (design §4.3, §13).
 *
 * Two implementations:
 *   - LiveMCPTransport — talks to a real AMG-MCP server over streamable HTTP
 *     (Phase 1 step 11; not yet implemented).
 *   - FixtureMCPTransport — replays recorded responses from local files
 *     (this file; the seam that lets steps 3–10 be developed and tested
 *     without a live Azure dependency).
 *
 * The transport intentionally does NOT do:
 *   - failure-class translation (that's the failure_taxonomy component, §4.4)
 *   - read-only allowlist enforcement (that's mcp_client / planner-validation, §12)
 *   - back-pressure / batching (that's the evidence executor, §4.6)
 *
 * Keep this interface minimal so swapping implementations stays trivial.
 */
export interface MCPTransport {
  listCapabilities(): Promise<CapabilityCatalog>;

  invoke(
    capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult>;

  close(): Promise<void>;
}
