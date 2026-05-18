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

export const PHASE_1_READ_ONLY_ALLOWLIST: ReadonlySet<string> = new Set([
  'query_azure_subscriptions',
  'cost_analysis',
  'query_resource_graph',
  'query_resource_metric_definition',
  'query_resource_metric',
  'query_activity_log',
  'query_resource_health',
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
