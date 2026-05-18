/**
 * Read-only capability allowlist for Phase 1 (design §12 layer 1).
 *
 * The primary filter is the explicit set — any capability name not in it
 * is denied, even if AMG-MCP advertises it. The pattern check is defense
 * in depth: if a mutating capability ever ends up in the allowlist by
 * mistake (e.g., a future maintainer adds `dashboard_update` to the
 * Phase 2 set), the pattern catches it before it can be invoked.
 *
 * Adding a capability is a deliberate two-step:
 *   1. Add to PHASE_1_READ_ONLY_ALLOWLIST below.
 *   2. Update the playbook in src/playbooks/ that consumes it.
 */

/**
 * AMG-MCP advertises its tools with an `amgmcp_` prefix on the wire
 * (see learn.microsoft.com/azure/managed-grafana/grafana-mcp-server).
 * The design doc uses the unprefixed names as the conceptual handle for
 * each capability; the values below are the real wire names.
 */
export const PHASE_1_READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set([
  'amgmcp_query_azure_subscriptions',
  'amgmcp_cost_analysis',
  'amgmcp_query_resource_graph',
  'amgmcp_query_resource_metric_definition',
  'amgmcp_query_resource_metric',
  'amgmcp_query_activity_log',
  'amgmcp_query_resource_health',
]);

/**
 * Mutation-indicating name patterns. Capabilities matching any of these
 * are denied regardless of whether they appear in the allowlist. Uses
 * snake_case word boundaries (^ or _) so reads like
 * `query_resource_metric_definition` don't false-positive on substrings.
 */
export const MUTATING_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)update($|_)/,
  /(^|_)create($|_)/,
  /(^|_)delete($|_)/,
  /(^|_)modify($|_)/,
  /(^|_)remove($|_)/,
  /(^|_)replace($|_)/,
  /(^|_)set($|_)/,
  /(^|_)apply($|_)/,
  /(^|_)write($|_)/,
];

export function isMutatingCapabilityName(name: string): boolean {
  return MUTATING_NAME_PATTERNS.some((p) => p.test(name));
}

export function isAllowedCapability(name: string): boolean {
  if (!PHASE_1_READ_ONLY_ALLOWLIST.has(name)) return false;
  if (isMutatingCapabilityName(name)) return false;
  return true;
}
