import type { MCPClient } from '../mcp/client.js';
import { extractText, tryParseJson, isWrappedError } from '../mcp/content.js';

/**
 * Auto-discovery of which Azure subscriptions to analyze when the
 * operator doesn't pass --subscription. Strategy:
 *
 *   1. Call amgmcp_query_azure_subscriptions to get the set of
 *      subscriptions the AMG-MCP data source can see.
 *   2. For each, run a small Resource Graph count query.
 *   3. Sort by resource count and return the top N (default 3).
 *
 * Per-subscription failures (data-source auth issues, transient errors)
 * downgrade that subscription's count to 0 and are recorded as
 * diagnostics — they don't fail the whole discovery unless we end up
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

  // 2. Count resources per subscription (N+1; safer than relying on
  // multi-sub support in the query).
  const counts: SubscriptionCount[] = [];
  for (const subscription_id of subscriptionIds) {
    const count = await countResources(client, subscription_id, diagnostics);
    counts.push({ subscription_id, resource_count: count });
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

async function countResources(
  client: MCPClient,
  subscriptionId: string,
  diagnostics: string[],
): Promise<number> {
  try {
    const result = await client.invoke('amgmcp_query_resource_graph', {
      subscription_ids: [subscriptionId],
      query: 'Resources | summarize count_=count()',
    });
    const text = extractText(result);
    if (isWrappedError(text)) {
      diagnostics.push(`subscription ${subscriptionId}: ${text.slice(0, 120)}`);
      return 0;
    }
    return parseResourceCount(text);
  } catch (err) {
    diagnostics.push(
      `subscription ${subscriptionId}: invoke threw ${(err as Error).message ?? String(err)}`,
    );
    return 0;
  }
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

function parseResourceCount(text: string): number {
  const parsed = tryParseJson(text);
  if (parsed === null || parsed === undefined) return 0;
  if (typeof parsed === 'number') return parsed;
  if (typeof parsed === 'object') {
    const obj = parsed as {
      count?: unknown;
      count_?: unknown;
      data?: unknown;
      rows?: unknown;
    };
    if (typeof obj.count === 'number') return obj.count;
    if (typeof obj.count_ === 'number') return obj.count_;
    if (Array.isArray(obj.data) && obj.data.length > 0) {
      const first = obj.data[0];
      if (typeof first === 'object' && first !== null) {
        const inner = first as { count_?: unknown; count?: unknown };
        if (typeof inner.count_ === 'number') return inner.count_;
        if (typeof inner.count === 'number') return inner.count;
      }
    }
    if (Array.isArray(obj.rows) && obj.rows.length > 0) {
      const first = obj.rows[0];
      if (Array.isArray(first) && typeof first[0] === 'number') return first[0];
    }
  }
  return 0;
}
