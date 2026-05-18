import type { MCPClient } from '../mcp/client.js';
import { extractText, tryParseJson, isWrappedError } from '../mcp/content.js';

/**
 * Auto-discovery of which Azure subscriptions to analyze when the
 * operator doesn't pass --subscription. Strategy:
 *
 *   1. Call amgmcp_query_azure_subscriptions to get the set of
 *      subscriptions the AMG-MCP data source can see.
 *   2. Issue a single Resource Graph query that groups by subscriptionId
 *      across all of them, so we get every count in one round trip.
 *   3. Sort by resource count and return the top N (default 3).
 *
 * Subscriptions that don't appear in the grouped result (no resources, or
 * no data-source access for that sub) are treated as count=0 and recorded
 * as diagnostics; they don't fail the whole discovery unless we end up
 * with zero usable subscriptions.
 */

export interface SubscriptionCount {
  subscription_id: string;
  resource_count: number;
}

export interface SubscriptionDiscoveryResult {
  selected_subscription_ids: string[];
  all_counts: SubscriptionCount[];
  diagnostics: string[];
}

export class SubscriptionDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionDiscoveryError';
  }
}

export async function discoverTopSubscriptions(
  client: MCPClient,
  limit: number = 3,
): Promise<SubscriptionDiscoveryResult> {
  const diagnostics: string[] = [];

  // 1. List subscriptions visible through AMG-MCP.
  process.stdout.write(`  querying AMG-MCP for visible subscriptions...\n`);
  const listResult = await client.invoke('amgmcp_query_azure_subscriptions', {});
  const listText = extractText(listResult);
  if (isWrappedError(listText)) {
    throw new SubscriptionDiscoveryError(
      `Could not list Azure subscriptions via AMG-MCP. The server reported: "${listText.slice(0, 240)}". ` +
        `Either the Grafana Azure Monitor data source isn't configured for your identity, or AMG-MCP can't reach it. ` +
        `Pass --subscription explicitly to bypass auto-discovery.`,
    );
  }
  const subscriptionIds = parseSubscriptionList(listText);
  if (subscriptionIds.length === 0) {
    throw new SubscriptionDiscoveryError(
      'AMG-MCP returned no Azure subscriptions. Pass --subscription explicitly, or grant Grafana data-source access on your AMG instance.',
    );
  }
  process.stdout.write(
    `  AMG-MCP returned ${subscriptionIds.length} subscription(s); counting resources via a single Resource Graph query...\n`,
  );

  // 2. One grouped Resource Graph query for all subscriptions at once.
  // amgmcp_query_resource_graph only accepts `query` and
  // `azureMonitorDatasourceUid` — there is no per-call subscription_ids
  // parameter. The Azure Monitor data source the AMG instance is bound
  // to scopes which subs are visible; ARG omits groups with no rows, so
  // subs missing from the result are treated as 0.
  const startedAt = Date.now();
  const queryResult = await client.invoke('amgmcp_query_resource_graph', {
    query: 'Resources | summarize resource_count=count() by subscriptionId',
  });
  const queryText = extractText(queryResult);
  if (isWrappedError(queryText)) {
    throw new SubscriptionDiscoveryError(
      `Resource Graph count query failed: "${queryText.slice(0, 240)}". ` +
        `Pass --subscription explicitly to bypass auto-discovery.`,
    );
  }
  const countMap = parseGroupedResourceCounts(queryText);
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(
    `  Resource Graph returned counts for ${countMap.size} of ${subscriptionIds.length} subscription(s) in ${elapsedMs}ms\n`,
  );

  const counts: SubscriptionCount[] = subscriptionIds.map((subscription_id) => ({
    subscription_id,
    resource_count: countMap.get(subscription_id) ?? 0,
  }));
  const missing = counts.filter((c) => c.resource_count === 0).map((c) => c.subscription_id);
  if (missing.length > 0) {
    diagnostics.push(
      `${missing.length} subscription(s) reported no resources (empty, or no data-source access): ${missing.join(', ')}`,
    );
  }

  // 3. Sort and pick the top N with non-zero counts. If none have
  // resources (e.g., everything errored), fall back to the first up-to-N
  // subscriptions so the run proceeds — the missing data turns into DQ
  // findings downstream.
  counts.sort((a, b) => b.resource_count - a.resource_count);
  let selected = counts.filter((c) => c.resource_count > 0).slice(0, limit);
  if (selected.length === 0) {
    diagnostics.push(
      'no subscription returned a non-zero resource count; falling back to first up-to-N discovered',
    );
    selected = counts.slice(0, limit);
  }
  process.stdout.write(
    `  selected top ${selected.length} by resource count: ${selected
      .map((c) => `${c.subscription_id} (${c.resource_count})`)
      .join(', ')}\n`,
  );

  if (selected.length === 0) {
    throw new SubscriptionDiscoveryError(
      `Discovered ${subscriptionIds.length} subscription(s) but could not select any. Diagnostics: ${diagnostics.join('; ')}`,
    );
  }

  return {
    selected_subscription_ids: selected.map((c) => c.subscription_id),
    all_counts: counts,
    diagnostics,
  };
}

function parseSubscriptionList(text: string): string[] {
  const parsed = tryParseJson(text);
  return extractSubscriptionIds(parsed);
}

function extractSubscriptionIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          const obj = item as {
            subscriptionId?: unknown;
            id?: unknown;
            subscription_id?: unknown;
          };
          const id = obj.subscriptionId ?? obj.id ?? obj.subscription_id;
          return typeof id === 'string' ? id : undefined;
        }
        return undefined;
      })
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { subscriptions?: unknown; data?: unknown; rows?: unknown };
    if (obj.subscriptions !== undefined) return extractSubscriptionIds(obj.subscriptions);
    if (obj.data !== undefined) return extractSubscriptionIds(obj.data);
    if (Array.isArray(obj.rows)) {
      // Resource-Graph-shape rows: [[id, ...], ...]
      return obj.rows
        .map((row) => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : undefined))
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
    }
  }
  return [];
}

/**
 * Parse the result of `Resources | summarize resource_count=count() by subscriptionId`
 * into a sub-id → count map. Handles the three response shapes AMG-MCP /
 * Azure Resource Graph commonly return: top-level row arrays, `{data: [...]}`
 * (Resource Graph REST), and `{rows: [...], columns?: [...]}` (Grafana
 * datasource passthrough). For the `rows` shape, prefer column metadata when
 * present so we don't depend on positional ordering.
 */
function parseGroupedResourceCounts(text: string): Map<string, number> {
  const parsed = tryParseJson(text);
  const out = new Map<string, number>();
  if (parsed === null || parsed === undefined) return out;

  if (Array.isArray(parsed)) {
    return readRowObjects(parsed, out);
  }

  if (typeof parsed !== 'object') return out;
  const obj = parsed as { data?: unknown; rows?: unknown; columns?: unknown };

  if (Array.isArray(obj.data)) {
    return readRowObjects(obj.data, out);
  }

  if (Array.isArray(obj.rows)) {
    const { subIdx, countIdx } = rowColumnIndices(obj.columns);
    for (const row of obj.rows) {
      if (!Array.isArray(row)) continue;
      const subId = row[subIdx];
      const count = row[countIdx];
      if (typeof subId === 'string' && typeof count === 'number') {
        out.set(subId, count);
      }
    }
  }
  return out;
}

function readRowObjects(rows: unknown[], out: Map<string, number>): Map<string, number> {
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as {
      subscriptionId?: unknown;
      subscription_id?: unknown;
      resource_count?: unknown;
      count_?: unknown;
      count?: unknown;
    };
    const subId =
      typeof r.subscriptionId === 'string'
        ? r.subscriptionId
        : typeof r.subscription_id === 'string'
          ? r.subscription_id
          : undefined;
    const count =
      typeof r.resource_count === 'number'
        ? r.resource_count
        : typeof r.count_ === 'number'
          ? r.count_
          : typeof r.count === 'number'
            ? r.count
            : undefined;
    if (subId !== undefined && count !== undefined) {
      out.set(subId, count);
    }
  }
  return out;
}

function rowColumnIndices(columns: unknown): { subIdx: number; countIdx: number } {
  // ARG's default ordering for `summarize <agg> by X` is [X, <agg>], i.e.
  // [subscriptionId, resource_count]. Override if column metadata is present.
  let subIdx = 0;
  let countIdx = 1;
  if (Array.isArray(columns)) {
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i] as { name?: unknown } | undefined;
      const name = typeof col?.name === 'string' ? col.name.toLowerCase() : undefined;
      if (name === 'subscriptionid' || name === 'subscription_id') subIdx = i;
      else if (name === 'resource_count' || name === 'count_' || name === 'count') countIdx = i;
    }
  }
  return { subIdx, countIdx };
}
