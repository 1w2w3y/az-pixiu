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
  display_name?: string;
  resource_count: number;
}

export interface SubscriptionDiscoveryResult {
  selected_subscription_ids: string[];
  selected: SubscriptionCount[];
  all_counts: SubscriptionCount[];
  diagnostics: string[];
}

export class SubscriptionDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionDiscoveryError';
  }
}

/**
 * Each step in the discovery flow emits a `DiscoveryProgress` call with a
 * human-readable line for the operator's terminal and an optional
 * structured `event` for observability backends (Langfuse via OTEL
 * `span.addEvent`). The caller decides what to do with each — write to
 * stdout, attach to a span, both, or neither. Keeping discovery
 * transport-agnostic means it doesn't have to import OTEL, and tests can
 * silence it by passing a no-op callback.
 */
export type DiscoveryProgress = (
  line: string,
  event?: { name: string; attrs?: Record<string, unknown> },
) => void;

export interface DiscoverTopSubscriptionsOptions {
  /**
   * Per-step progress emitter. Default: write `line` to stdout, drop the
   * structured `event` (preserves the function's pre-callback behavior
   * when called without options).
   */
  onProgress?: DiscoveryProgress;
}

const stdoutOnlyProgress: DiscoveryProgress = (line) => {
  process.stdout.write(line + '\n');
};

export async function discoverTopSubscriptions(
  client: MCPClient,
  limit: number = 3,
  options: DiscoverTopSubscriptionsOptions = {},
): Promise<SubscriptionDiscoveryResult> {
  const diagnostics: string[] = [];
  const onProgress = options.onProgress ?? stdoutOnlyProgress;

  // 1. List subscriptions visible through AMG-MCP.
  onProgress(`  querying AMG-MCP for visible subscriptions...`, {
    name: 'discovery.listing_subscriptions',
  });
  const listResult = await client.invoke('amgmcp_query_azure_subscriptions', {});
  const listText = extractText(listResult);
  if (isWrappedError(listText)) {
    throw new SubscriptionDiscoveryError(
      `Could not list Azure subscriptions via AMG-MCP. The server reported: "${listText.slice(0, 240)}". ` +
        `Either the Grafana Azure Monitor data source isn't configured for your identity, or AMG-MCP can't reach it. ` +
        `Pass --subscription explicitly to bypass auto-discovery.`,
    );
  }
  const subscriptions = parseSubscriptionList(listText);
  if (subscriptions.length === 0) {
    throw new SubscriptionDiscoveryError(
      'AMG-MCP returned no Azure subscriptions. Pass --subscription explicitly, or grant Grafana data-source access on your AMG instance.',
    );
  }
  const withNames = subscriptions.filter((s) => s.display_name !== undefined).length;
  onProgress(
    `  AMG-MCP returned ${subscriptions.length} subscription(s) (${withNames} with display names); counting resources via a single Resource Graph query...`,
    {
      name: 'discovery.subscriptions_listed',
      attrs: { count: subscriptions.length, with_names: withNames },
    },
  );
  if (withNames === 0) {
    // No display names came back from the list call — surface the top-level
    // keys of the parsed response and the keys of the first subscription
    // object so the operator can see whether the server is using a
    // different field name (e.g. ARM's nested `value` array). Goes into
    // diagnostics so it lands on the span as well as stdout.
    const shape = describeShape(listText);
    diagnostics.push(`no display names found in AMG-MCP response; shape: ${shape}`);
    onProgress(`  shape hint (no display names found): ${shape}`, {
      name: 'discovery.no_display_names',
      attrs: { shape },
    });
  }

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
  onProgress(
    `  Resource Graph returned counts for ${countMap.size} of ${subscriptions.length} subscription(s) in ${elapsedMs}ms`,
    {
      name: 'discovery.resource_counts_returned',
      attrs: { returned: countMap.size, of_total: subscriptions.length, elapsed_ms: elapsedMs },
    },
  );

  const counts: SubscriptionCount[] = subscriptions.map(({ subscription_id, display_name }) => ({
    subscription_id,
    ...(display_name ? { display_name } : {}),
    resource_count: countMap.get(subscription_id) ?? 0,
  }));
  const missing = counts.filter((c) => c.resource_count === 0);
  if (missing.length > 0) {
    const missingFormatted = missing.map(formatSubscription).join(', ');
    diagnostics.push(
      `${missing.length} subscription(s) reported no resources (empty, or no data-source access): ${missingFormatted}`,
    );
    onProgress(
      `  ${missing.length} subscription(s) reported no resources: ${missingFormatted}`,
      {
        name: 'discovery.missing_resources',
        attrs: {
          count: missing.length,
          subscriptions: missing.map((c) => c.subscription_id),
        },
      },
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
  onProgress(
    `  selected top ${selected.length} by resource count: ${selected
      .map((c) => `${formatSubscription(c)} — ${c.resource_count} resources`)
      .join(', ')}`,
    {
      name: 'discovery.subscriptions_selected',
      attrs: {
        count: selected.length,
        selected: selected.map((c) => ({
          subscription_id: c.subscription_id,
          display_name: c.display_name,
          resource_count: c.resource_count,
        })),
      },
    },
  );

  if (selected.length === 0) {
    throw new SubscriptionDiscoveryError(
      `Discovered ${subscriptions.length} subscription(s) but could not select any. Diagnostics: ${diagnostics.join('; ')}`,
    );
  }

  return {
    selected_subscription_ids: selected.map((c) => c.subscription_id),
    selected,
    all_counts: counts,
    diagnostics,
  };
}

/**
 * Format a subscription for human-readable logs and diagnostics. When the
 * display name is known, render as `"<name>" (<id>)`; otherwise fall back
 * to the bare id. The id is always present so operators can grep for it.
 */
export function formatSubscription(s: { subscription_id: string; display_name?: string }): string {
  return s.display_name ? `"${s.display_name}" (${s.subscription_id})` : s.subscription_id;
}

interface ParsedSubscription {
  subscription_id: string;
  display_name?: string;
}

function parseSubscriptionList(text: string): ParsedSubscription[] {
  const parsed = tryParseJson(text);
  return extractSubscriptions(parsed);
}

function extractSubscriptions(value: unknown): ParsedSubscription[] {
  if (Array.isArray(value)) {
    return value
      .map((item): ParsedSubscription | undefined => {
        if (typeof item === 'string') return { subscription_id: item };
        if (typeof item === 'object' && item !== null) {
          const obj = item as {
            subscriptionId?: unknown;
            id?: unknown;
            subscription_id?: unknown;
            subscriptionName?: unknown;
            displayName?: unknown;
            display_name?: unknown;
            name?: unknown;
          };
          const id = obj.subscriptionId ?? obj.id ?? obj.subscription_id;
          if (typeof id !== 'string' || id.length === 0) return undefined;
          // Live AMG-MCP uses `subscriptionName`; older/seeded shapes use displayName/name.
          const rawName = obj.subscriptionName ?? obj.displayName ?? obj.display_name ?? obj.name;
          const display_name =
            typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined;
          return display_name ? { subscription_id: id, display_name } : { subscription_id: id };
        }
        return undefined;
      })
      .filter((s): s is ParsedSubscription => s !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as {
      subscriptions?: unknown;
      value?: unknown;
      data?: unknown;
      rows?: unknown;
    };
    // Prefer named arrays in priority order: AMG-MCP wrapper (`subscriptions`),
    // Azure ARM REST shape (`value`), then generic `data`. Recurse so nested
    // shapes like `{subscriptions: {value: [...]}}` also work.
    if (obj.subscriptions !== undefined) return extractSubscriptions(obj.subscriptions);
    if (obj.value !== undefined) return extractSubscriptions(obj.value);
    if (obj.data !== undefined) return extractSubscriptions(obj.data);
    if (Array.isArray(obj.rows)) {
      // Resource-Graph-shape rows: [[id, ...], ...] — no display name available.
      return obj.rows
        .map((row): ParsedSubscription | undefined =>
          Array.isArray(row) && typeof row[0] === 'string' && row[0].length > 0
            ? { subscription_id: row[0] }
            : undefined,
        )
        .filter((s): s is ParsedSubscription => s !== undefined);
    }
  }
  return [];
}

/**
 * Render a short, non-PII shape descriptor for diagnostics — top-level keys
 * plus the keys of the first element of the first array we find. Used when
 * we extracted IDs but no display names so the operator can tell where the
 * name field lives in the live response without dumping the full payload.
 */
function describeShape(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed === null || parsed === undefined) {
    return `non-JSON, ${text.length} char(s): ${text.slice(0, 80)}`;
  }
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    const innerKeys =
      typeof first === 'object' && first !== null ? Object.keys(first).join(',') : typeof first;
    return `array[${parsed.length}] of {${innerKeys}}`;
  }
  if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const topKeys = Object.keys(obj).join(',');
    let innerDesc = '';
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length > 0) {
        const first = v[0];
        const innerKeys =
          typeof first === 'object' && first !== null
            ? Object.keys(first).join(',')
            : typeof first;
        innerDesc = ` → ${k}[0]: {${innerKeys}}`;
        break;
      }
    }
    return `{${topKeys}}${innerDesc}`;
  }
  return typeof parsed;
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
