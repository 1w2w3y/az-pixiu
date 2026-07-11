/**
 * Add an effective subscription boundary to an Azure Resource Graph query.
 *
 * The live AMG-MCP `amgmcp_query_resource_graph` capability accepts `query`
 * (and, on some servers, `azureMonitorDatasourceUid`) but does not expose a
 * separate `subscription_ids` parameter. Subscription intent therefore has
 * to be expressed in KQL, not attached as an unsupported wire argument.
 */
export function scopeResourceGraphQuery(
  query: string,
  subscriptionIds: readonly string[],
  options: {
    resourceGroupNames?: readonly string[] | null;
    resourceTypes?: readonly string[] | null;
  } = {},
): string {
  const trimmed = query.trim();
  const resourcesPrefix = /^Resources(?=\s|\||$)\s*(?:\|\s*)?/i.exec(trimmed);
  if (!resourcesPrefix) {
    throw new Error('scopeResourceGraphQuery requires a query rooted at Resources.');
  }

  assertNoBlankScopeValues(subscriptionIds, 'subscription id');
  assertNoBlankScopeValues(options.resourceGroupNames ?? [], 'resource group');
  assertNoBlankScopeValues(options.resourceTypes ?? [], 'resource type');
  const uniqueIds = normalizeScopeValues(subscriptionIds);
  if (uniqueIds.length === 0) {
    throw new Error('scopeResourceGraphQuery requires at least one subscription id.');
  }

  const clauses = [
    `where subscriptionId in~ (${uniqueIds.map(quoteKustoString).join(', ')})`,
  ];
  const resourceGroups = normalizeScopeValues(options.resourceGroupNames ?? []);
  if (resourceGroups.length > 0) {
    clauses.push(`where resourceGroup in~ (${resourceGroups.map(quoteKustoString).join(', ')})`);
  }
  const resourceTypes = normalizeScopeValues(options.resourceTypes ?? []);
  if (resourceTypes.length > 0) {
    clauses.push(`where type in~ (${resourceTypes.map(quoteKustoString).join(', ')})`);
  }
  const remainder = trimmed.slice(resourcesPrefix[0].length).trim();
  const scopeClause = clauses.join(' | ');
  return remainder.length > 0
    ? `Resources | ${scopeClause} | ${remainder}`
    : `Resources | ${scopeClause}`;
}

/** Trim, drop empty values, and de-duplicate Azure scope strings case-insensitively. */
export function normalizeScopeValues(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function assertNoBlankScopeValues(values: readonly string[], label: string): void {
  if (values.some((value) => value.trim().length === 0)) {
    throw new Error(`scopeResourceGraphQuery received a blank ${label}.`);
  }
}

function quoteKustoString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
  return `'${escaped}'`;
}
