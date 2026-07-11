import type { MCPClient } from '../mcp/client.js';
import { extractText, tryParseJson, isWrappedError } from '../mcp/content.js';
import { probeBillingAccess, type ProbeResult } from './billing-probe.js';
import { BillingProbeCache } from './billing-probe-cache.js';
import { DataQualityFindingSchema, type DataQualityFinding } from '../schemas/index.js';

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
  /**
   * Billing-access probe outcomes for the candidates that were probed.
   * Empty when the probe was disabled. Present (and possibly empty) when
   * the probe ran but selected zero candidates from the probe pool.
   */
  probed: ProbeResult[];
  /**
   * Subscriptions that were probed and excluded from auto-selection
   * because the probe did not return `pass`. Each carries the matching
   * resource count (for context) and the probe outcome (for the DQ
   * finding). Empty in explicit-pick mode where the operator overrides.
   */
  excluded: ExcludedSubscription[];
  /**
   * Synthetic `billing_probe_excluded` DQ findings — one per excluded
   * subscription — that the orchestrator merges into the run's data-
   * quality input. Empty when the probe was disabled or every probed
   * sub passed.
   */
  data_quality: DataQualityFinding[];
  /**
   * Run-level discovery funnel for the Run Metadata footer. Absent when
   * the probe was disabled.
   */
  funnel?: {
    arg_ranked: number;
    pool_size: number;
    probed: number;
    passed: number;
    selected: number;
    cache_hits: number;
    cache_misses: number;
  };
}

export interface ExcludedSubscription {
  subscription_id: string;
  display_name?: string;
  resource_count: number;
  outcome: ProbeResult['outcome'];
  classification?: string;
  message?: string;
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
  /**
   * Comma-separated, case-insensitive substring filters on the subscription
   * display name. When provided, only subscriptions whose name contains at
   * least one term are eligible for selection. Subscriptions
   * without a display name are excluded from the filtered set — they
   * have no name to match against.
   *
   * Useful for fan-outs scoped to a naming convention (e.g. "prod",
   * "team-platform") across either analysis type. For an exact-id
   * selection, use the CLI's --subscription instead and skip discovery.
   */
  nameFilter?: string;
  /**
   * Billing-access pre-flight probe options. When set and `enabled` is
   * true (the default at the CLI layer), the discovery probes the top
   * `poolSize` candidates against `amgmcp_cost_analysis` and only
   * subscriptions that pass are eligible for auto-selection.
   *
   * The probe is observability-only: results never enter the evidence
   * stream or the reasoner. Excluded subs are surfaced as
   * `billing_probe_excluded` DQ findings.
   *
   * Operators who want the legacy behaviour pass `--no-probe-billing`,
   * which sets `enabled=false`. Explicit-pick callers (CLI with
   * `--subscription`) do not invoke this path — they bypass discovery
   * entirely; if probing of explicit picks is wanted it must be
   * threaded by the caller separately.
   */
  probe?: {
    enabled: boolean;
    poolSize?: number;
    concurrency?: number;
    timeoutMs?: number;
    cache?: BillingProbeCache | null;
  };
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
  const allSubscriptions = parseSubscriptionList(listText);
  if (allSubscriptions.length === 0) {
    throw new SubscriptionDiscoveryError(
      'AMG-MCP returned no Azure subscriptions. Pass --subscription explicitly, or grant Grafana data-source access on your AMG instance.',
    );
  }

  // Apply the case-insensitive name-substring filter, if set. Subs with
  // no display name can't match, so they're dropped from the eligible
  // set and reported as a diagnostic so the operator knows why.
  const subscriptions = options.nameFilter
    ? applyNameFilter(allSubscriptions, options.nameFilter, diagnostics, onProgress)
    : allSubscriptions;
  if (subscriptions.length === 0) {
    throw new SubscriptionDiscoveryError(
      `Subscription name filter "${options.nameFilter}" matched 0 of ${allSubscriptions.length} subscription(s). ` +
        `Either widen the filter, or pass --subscription explicitly.`,
    );
  }

  const withNames = subscriptions.filter((s) => s.display_name !== undefined).length;
  onProgress(
    `  AMG-MCP returned ${allSubscriptions.length} subscription(s) (${withNames} with display names${options.nameFilter ? `, ${subscriptions.length} matching filter "${options.nameFilter}"` : ''}); counting resources via a single Resource Graph query...`,
    {
      name: 'discovery.subscriptions_listed',
      attrs: {
        count: allSubscriptions.length,
        with_names: withNames,
        ...(options.nameFilter
          ? { name_filter: options.nameFilter, matched: subscriptions.length }
          : {}),
      },
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

  // 3. Sort. If the probe is disabled, pick the top N with non-zero
  // counts directly. If the probe is enabled, probe the top
  // `poolSize` and pick the top N *among passers*; excluded subs
  // become DQ findings the operator sees before any real cost call.
  counts.sort((a, b) => b.resource_count - a.resource_count);
  const probeEnabled = options.probe?.enabled ?? false;
  const probed: ProbeResult[] = [];
  const excluded: ExcludedSubscription[] = [];
  const dq: DataQualityFinding[] = [];
  let funnel: SubscriptionDiscoveryResult['funnel'];

  if (!probeEnabled) {
    let selected = counts.filter((c) => c.resource_count > 0).slice(0, limit);
    if (selected.length === 0) {
      diagnostics.push(
        'no subscription returned a non-zero resource count; falling back to first up-to-N discovered',
      );
      selected = counts.slice(0, limit);
    }
    emitSelection(onProgress, selected);
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
      probed,
      excluded,
      data_quality: dq,
    };
  }

  // Probe pool: top-N by resource count, bounded to keep the probe
  // budget reasonable on tenants with hundreds of visible subs. The
  // pool is intentionally larger than `limit` so retry losses or
  // mass denials still leave enough passers to fill `limit`.
  const poolSize = clampPoolSize(options.probe?.poolSize, limit);
  const nonZero = counts.filter((c) => c.resource_count > 0);
  const pool = (nonZero.length > 0 ? nonZero : counts).slice(0, poolSize);
  if (pool.length === 0) {
    throw new SubscriptionDiscoveryError(
      `Discovered ${subscriptions.length} subscription(s) but could not build a probe pool. Diagnostics: ${diagnostics.join('; ')}`,
    );
  }
  onProgress(
    `  probing top ${pool.length} candidate(s) for Cost Management read access (poolSize=${poolSize})...`,
    {
      name: 'discovery.probe_started',
      attrs: { pool_size: pool.length, limit },
    },
  );

  const probeStartedAt = Date.now();
  const probeRun = await probeBillingAccess(
    client,
    pool.map((c) => c.subscription_id),
    {
      ...(options.probe?.concurrency !== undefined ? { concurrency: options.probe.concurrency } : {}),
      ...(options.probe?.timeoutMs !== undefined ? { timeoutMs: options.probe.timeoutMs } : {}),
      ...(options.probe?.cache ? { cache: options.probe.cache } : {}),
      onProbe: (event) => {
        onProgress(
          `    probe ${event.outcome}${event.classification ? ` (${event.classification})` : ''}${event.cache_hit ? ' [cache]' : ''}: ${event.subscription_id} (${event.latency_ms}ms)`,
          {
            name: 'probe.end',
            attrs: {
              subscription_id: event.subscription_id,
              outcome: event.outcome,
              ...(event.classification ? { classification: event.classification } : {}),
              latency_ms: event.latency_ms,
              cache_hit: event.cache_hit,
            },
          },
        );
      },
    },
  );
  probed.push(...probeRun.results);
  const probeElapsedMs = Date.now() - probeStartedAt;
  const byId = new Map(probeRun.results.map((r) => [r.subscription_id, r] as const));
  const passers = pool.filter((c) => byId.get(c.subscription_id)?.outcome === 'pass');
  onProgress(
    `  probe complete in ${probeElapsedMs}ms — ${passers.length}/${pool.length} candidate(s) passed (${probeRun.stats.cache_hits} cache hit(s))`,
    {
      name: 'discovery.probe_complete',
      attrs: {
        probed: pool.length,
        passed: passers.length,
        cache_hits: probeRun.stats.cache_hits,
        cache_misses: probeRun.stats.cache_misses,
        elapsed_ms: probeElapsedMs,
      },
    },
  );

  const selected = passers.slice(0, limit);
  for (const candidate of pool) {
    const result = byId.get(candidate.subscription_id);
    if (!result || result.outcome === 'pass') continue;
    excluded.push({
      subscription_id: candidate.subscription_id,
      ...(candidate.display_name ? { display_name: candidate.display_name } : {}),
      resource_count: candidate.resource_count,
      outcome: result.outcome,
      ...(result.classification ? { classification: result.classification } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
    dq.push(buildExcludedDq(dq.length, candidate, result));
  }

  if (selected.length < limit) {
    diagnostics.push(
      `billing-access probe yielded only ${passers.length} passer(s) out of ${pool.length} probed (target ${limit}); see Run Quality for excluded sub(s)`,
    );
    // partial_coverage DQ when the probe leaves the analysis with
    // fewer than `limit` subs but at least one passer. (Zero-passer
    // case throws below.)
    if (passers.length > 0 && excluded.length > 0) {
      dq.push(buildPartialCoverageDq(dq.length, pool.length, passers.length, limit));
    }
  }
  emitSelection(onProgress, selected);

  funnel = {
    arg_ranked: counts.length,
    pool_size: poolSize,
    probed: pool.length,
    passed: passers.length,
    selected: selected.length,
    cache_hits: probeRun.stats.cache_hits,
    cache_misses: probeRun.stats.cache_misses,
  };

  if (selected.length === 0) {
    const summary = excluded
      .map((e) => `${formatSubscription(e)} — ${e.outcome}${e.classification ? `/${e.classification}` : ''}`)
      .join('; ');
    throw new SubscriptionDiscoveryError(
      `Billing-access probe excluded every candidate (${pool.length} probed). Grant the Grafana data-source principal Cost Management Reader on at least one subscription, ` +
        `or pass --no-probe-billing to skip the probe and let the existing failure path surface the mid-run errors. Excluded: ${summary}.`,
    );
  }

  return {
    selected_subscription_ids: selected.map((c) => c.subscription_id),
    selected,
    all_counts: counts,
    diagnostics,
    probed,
    excluded,
    data_quality: dq,
    funnel,
  };
}

function emitSelection(onProgress: DiscoveryProgress, selected: SubscriptionCount[]): void {
  onProgress(
    `  selected top ${selected.length}: ${selected
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
}

/**
 * Pool-size formula. The probe pool is at least `max(limit*3,
 * limit+5, 10)` so retry losses or mass denials still leave enough
 * passers to fill `limit`. Capped at 25 to keep the probe budget
 * reasonable. Operator overrides are clamped to the same ceiling.
 */
function clampPoolSize(override: number | undefined, limit: number): number {
  const defaultPool = Math.max(limit * 3, limit + 5, 10);
  const requested = override ?? defaultPool;
  return Math.max(1, Math.min(25, requested));
}

function buildExcludedDq(
  index: number,
  candidate: SubscriptionCount,
  result: ProbeResult,
): DataQualityFinding {
  const subLabel = candidate.display_name
    ? `"${candidate.display_name}" (${candidate.subscription_id})`
    : candidate.subscription_id;
  const shortMessage = result.message ? truncate(result.message, 240) : 'no upstream message';
  const consequence =
    `Subscription ${subLabel} was ranked #${index + 1}-or-higher by resource count but was excluded from auto-discovery ` +
    `because the billing-access probe failed (${result.outcome}${result.classification ? `: ${result.classification}` : ''}). ` +
    `The Cost Management API returned: "${shortMessage}".`;
  return DataQualityFindingSchema.parse({
    dq_id: `dq-probe-${index + 1}`,
    category: 'billing_probe_excluded',
    affected_capability: 'amgmcp_cost_analysis',
    affected_scope_subset: {
      subscription_ids: [candidate.subscription_id],
      resource_group_names: null,
      resource_ids: null,
    },
    consequence_for_analysis: consequence,
    impact_on_recommendations: [],
    actionable_hint:
      'Grant the Grafana data-source principal Cost Management Reader on this subscription, or pass --no-probe-billing to skip the pre-flight check (the run will likely fail at the cost-retrieval step instead).',
  });
}

function buildPartialCoverageDq(
  index: number,
  probed: number,
  passed: number,
  target: number,
): DataQualityFinding {
  return DataQualityFindingSchema.parse({
    dq_id: `dq-probe-${index + 1}`,
    category: 'partial_coverage',
    affected_capability: 'amgmcp_cost_analysis',
    affected_scope_subset: null,
    consequence_for_analysis:
      `Billing-access probe passed ${passed} of ${probed} candidate(s); ` +
      `auto-discovery had asked for the top ${target}, so the analysis is bounded to ${passed} subscription(s).`,
    impact_on_recommendations: [],
    actionable_hint:
      'Grant Cost Management Reader on additional subscriptions or raise --max-subscriptions / --probe-pool-size to widen the candidate set.',
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Format a subscription for human-readable logs and diagnostics. When the
 * display name is known, render as `"<name>" (<id>)`; otherwise fall back
 * to the bare id. The id is always present so operators can grep for it.
 */
export function formatSubscription(s: { subscription_id: string; display_name?: string }): string {
  return s.display_name ? `"${s.display_name}" (${s.subscription_id})` : s.subscription_id;
}

/**
 * Filter the subscription list by comma-separated, case-insensitive
 * substrings against the display name. Records a diagnostic counting unnamed subs that
 * were excluded purely because they had no name to match against.
 */
function applyNameFilter(
  subscriptions: ParsedSubscription[],
  rawFilter: string,
  diagnostics: string[],
  onProgress: DiscoveryProgress,
): ParsedSubscription[] {
  const needles = rawFilter
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const matched: ParsedSubscription[] = [];
  let unnamedSkipped = 0;
  for (const s of subscriptions) {
    if (!s.display_name) {
      unnamedSkipped += 1;
      continue;
    }
    if (needles.some((needle) => s.display_name!.toLowerCase().includes(needle))) {
      matched.push(s);
    }
  }
  if (unnamedSkipped > 0) {
    diagnostics.push(
      `name filter "${rawFilter}" skipped ${unnamedSkipped} subscription(s) without a display name`,
    );
  }
  onProgress(
    `  name filter "${rawFilter}" matched ${matched.length}/${subscriptions.length} subscription(s)` +
      (unnamedSkipped > 0 ? ` (${unnamedSkipped} skipped: no display name)` : ''),
    {
      name: 'discovery.name_filter_applied',
      attrs: {
        filter: rawFilter,
        matched: matched.length,
        of_total: subscriptions.length,
        unnamed_skipped: unnamedSkipped,
      },
    },
  );
  return matched;
}

export interface ParsedSubscription {
  subscription_id: string;
  display_name?: string;
}

function parseSubscriptionList(text: string): ParsedSubscription[] {
  const parsed = tryParseJson(text);
  return extractSubscriptions(parsed);
}

/**
 * Pull the (subscription_id, display_name?) pairs out of any of the
 * shapes the AMG-MCP `amgmcp_query_azure_subscriptions` capability
 * has been observed to return — live `{data:[{subscriptionName,...}]}`,
 * legacy `{subscriptions:[{displayName,...}]}`, ARM-style `{value:[...]}`,
 * Resource-Graph `{rows:[...]}`, or a bare array. Used by discovery
 * and by report rendering (to look up names when Scope didn't carry
 * them).
 */
export function extractSubscriptions(value: unknown): ParsedSubscription[] {
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
