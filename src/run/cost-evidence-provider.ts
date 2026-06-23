/**
 * Cost-evidence provider — the read-through / write-through seam that
 * connects the local billing cache to the cost-summary analyze path
 * (docs/design/local-billing-cache.md, "the CostEvidenceProvider seam"
 * and "making cached cost evidence visible to coverage and run-outcome").
 *
 * Playbooks and the EvidenceExecutor are not directly coupled, so the
 * provider does not sit literally between them: the orchestrator calls
 * `serveFromCache(plan)` before `executor.execute(...)` to lift
 * cache-eligible cost requests out of the live plan, and `writeThrough(...)`
 * after, to persist freshly-retrieved finalized months. This mirrors how
 * WasteDetectionExecutor wraps the same executor and merges its records /
 * transport entries back into the main flow.
 *
 * Caching is intentionally narrow in this first slice: only `cost_summary`
 * runs, only a single-subscription cost request whose window is exactly one
 * finalized full calendar month (per the maturity policy and injected
 * clock). Everything else — multi-sub calls, partial windows, cost_surprise
 * baselines, non-cost requests — passes straight through to live retrieval.
 *
 * A cache hit is replayed at the RawEvidence level through the real
 * EvidenceNormalizer (so scopeFromCostPayload and provenance minting stay
 * in one place) and then its `source_capability` is rewritten to
 * `az_pixiu_billing_cache`, which is what excludes it from freshness while
 * still counting toward coverage and run-outcome.
 */

import { parameterDigest } from '../mcp/digest.js';
import { extractText, isWrappedError, tryParseJson } from '../mcp/content.js';
import { EvidenceNormalizer } from '../evidence/normalizer.js';
import type { RawEvidence } from '../evidence/executor.js';
import {
  EvidenceRecordSchema,
  type EvidencePlan,
  type EvidenceRecord,
  type EvidenceRequest,
  type QueryIntent,
  type Scope,
  type ToolCallResult,
  type TransportSummaryEntry,
} from '../schemas/index.js';
import { scopeSubsetFromParameters } from '../schemas/transport.js';
import { COST_WIRE_CAPABILITIES } from './cost-capabilities.js';
import {
  BILLING_CACHE_SOURCE_CAPABILITY,
  CACHE_SCHEMA_VERSION,
  DEFAULT_MATURITY_POLICY,
  digestObject,
  evaluateMaturity,
  monthBillingPeriod,
} from '../billing-cache/index.js';
import type {
  BillingCacheRecord,
  CacheCellKey,
  CostView,
  CurrencyMode,
  FileBillingCacheStore,
  MaturityPolicy,
} from '../billing-cache/index.js';

export interface CostEvidenceProviderOptions {
  store: FileBillingCacheStore;
  scope: Scope;
  costView: CostView;
  currencyMode?: CurrencyMode;
  policy?: MaturityPolicy;
  /** Injected clock (epoch ms) for the maturity gate. Defaults to Date.now. */
  now?: () => number;
}

export interface CacheServeResult {
  /** Cache-served cost EvidenceRecords (source_capability = az_pixiu_billing_cache). */
  servedRecords: EvidenceRecord[];
  /** One cache-served transport entry per hit (final_outcome 'success', no wire attempt). */
  servedTransport: TransportSummaryEntry[];
  /** The plan minus the requests served from cache — what the live executor runs. */
  remainingPlan: EvidencePlan;
  /** Number of cost requests served from cache (= live cost calls avoided). */
  hitCount: number;
}

interface CostCell {
  key: CacheCellKey;
  month: string;
  subscriptionId: string;
}

export class CostEvidenceProvider {
  private readonly store: FileBillingCacheStore;
  private readonly scope: Scope;
  private readonly costView: CostView;
  private readonly currencyMode: CurrencyMode;
  private readonly policy: MaturityPolicy;
  private readonly now: () => number;
  /**
   * The single finalized calendar month this run is eligible to cache, or
   * null when the run's analysis window is not exactly one usage-stable
   * full month. Keyed off the SCOPE window (which the operator controls)
   * rather than each request's parameters, so eligibility is independent
   * of the cost-call param shape — the playbook sends a `time_window`
   * object + `granularity`, while the live planner sends `startTime` /
   * `endTime` and no granularity (the AMG-MCP wire schema).
   */
  private readonly eligibleMonth: string | null;

  constructor(options: CostEvidenceProviderOptions) {
    this.store = options.store;
    this.scope = options.scope;
    this.costView = options.costView;
    this.currencyMode = options.currencyMode ?? 'normalized_usd';
    this.policy = options.policy ?? DEFAULT_MATURITY_POLICY;
    this.now = options.now ?? Date.now;
    this.eligibleMonth =
      this.scope.analysis_type === 'cost_summary' && this.scope.time_window
        ? this.windowToFinalizedMonth(this.scope.time_window.start, this.scope.time_window.end)
        : null;
  }

  /** Lift cache-eligible cost requests that hit into served records; leave the rest in the plan. */
  async serveFromCache(plan: EvidencePlan): Promise<CacheServeResult> {
    const servedRecords: EvidenceRecord[] = [];
    const servedTransport: TransportSummaryEntry[] = [];
    const remaining: EvidenceRequest[] = [];
    let hitCount = 0;

    for (const request of plan.requests) {
      const cell = this.costCellFor(request);
      if (!cell) {
        remaining.push(request);
        continue;
      }
      const record = await this.store.getRecord(cell.key);
      if (!record?.raw_evidence) {
        // Miss, or a summary-only cell with no replayable evidence.
        remaining.push(request);
        continue;
      }
      const served = this.serveRecord(record, hitCount + 1);
      servedRecords.push(...served.records);
      servedTransport.push(served.transport);
      hitCount += 1;
    }

    return {
      servedRecords,
      servedTransport,
      remainingPlan: { requests: remaining },
      hitCount,
    };
  }

  /** Persist freshly-retrieved finalized-month cost evidence so the next run hits. */
  async writeThrough(rawEvidence: readonly RawEvidence[]): Promise<number> {
    let written = 0;
    for (const raw of rawEvidence) {
      const cell = this.costCellFor(raw.request);
      if (!cell) continue;
      const record = this.buildCacheRecord(raw, cell);
      if (!record) continue;
      try {
        await this.store.set(record);
        written += 1;
      } catch {
        // Cache write failures are non-fatal — the analysis already has
        // the live evidence; the next run simply re-fetches.
      }
    }
    return written;
  }

  /**
   * Return the cache cell a request maps to, or null when it is not a
   * cache-eligible cost request. Eligibility: the run's scope is a single
   * finalized full month (computed once into {@link eligibleMonth}), the
   * request is a cost capability, and it targets exactly one subscription.
   * The cell's parameters digest covers the call's discriminating
   * parameters (grouping, datasource, filter — everything except the
   * subscription and window, which are already promoted to the key), so it
   * is stable across the playbook and live-planner param shapes.
   */
  private costCellFor(request: EvidenceRequest): CostCell | null {
    if (!this.eligibleMonth) return null;
    if (!COST_WIRE_CAPABILITIES.has(request.capability)) return null;

    const subs = scopeSubsetFromParameters(request.parameters)?.subscription_ids ?? null;
    if (!subs || subs.length !== 1) return null;
    const subscriptionId = subs[0]!;

    const key: CacheCellKey = {
      subscriptionId,
      month: this.eligibleMonth,
      costView: this.costView,
      currencyMode: this.currencyMode,
      parametersDigest: costQueryDigest(request.parameters),
    };
    return { key, month: this.eligibleMonth, subscriptionId };
  }

  /** Returns the YYYY-MM only when [start,end) is exactly a usage-stable full month. */
  private windowToFinalizedMonth(start: string, end: string): string | null {
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) return null;
    const d = new Date(startMs);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let period: { start: string; end: string };
    try {
      period = monthBillingPeriod(month);
    } catch {
      return null;
    }
    if (Date.parse(start) !== Date.parse(period.start)) return null;
    if (Date.parse(end) !== Date.parse(period.end)) return null;
    const maturity = evaluateMaturity({
      month,
      costView: this.costView,
      policy: this.policy,
      now: this.now,
    });
    return maturity.cacheable ? month : null;
  }

  private serveRecord(
    record: BillingCacheRecord,
    ordinal: number,
  ): { records: EvidenceRecord[]; transport: TransportSummaryEntry } {
    const re = record.raw_evidence!;
    const raw: RawEvidence = {
      request: {
        capability: re.capability,
        parameters: re.parameters,
        intent: re.intent as QueryIntent,
      },
      parameters_digest: parameterDigest(re.parameters),
      capability_version: re.capability_version,
      result: re.result as ToolCallResult,
      retrieved_at: record.maturity.retrieved_at,
    };

    // Normalize as the original cost capability so scopeFromCostPayload and
    // provenance minting run exactly as on the live path, then rewrite the
    // source so the record reads as cache-served.
    const { records } = new EvidenceNormalizer().normalize([raw], {
      defaultTimeWindow: this.scope.time_window,
    });
    const rewritten = records.map((r) =>
      EvidenceRecordSchema.parse({
        ...r,
        source_capability: BILLING_CACHE_SOURCE_CAPABILITY,
        capability_version: CACHE_SCHEMA_VERSION,
        caveats: [
          ...r.caveats,
          `Served from local billing cache (${record.maturity.cost_view} cost view, ${record.month}, ${record.maturity.status}; retrieved ${record.maturity.retrieved_at}). Original capability: ${re.capability}@${re.capability_version}.`,
        ],
      }),
    );

    const transport: TransportSummaryEntry = {
      logical_request_id: `cache-req-${ordinal}`,
      capability: BILLING_CACHE_SOURCE_CAPABILITY,
      scope_subset: scopeSubsetFromParameters(re.parameters),
      parameters_digest: record.source.parameters_digest,
      attempt_count: 0,
      retry_count: 0,
      final_outcome: 'success',
      pacing_applied: false,
      cumulative_backoff_ms: 0,
    };
    return { records: rewritten, transport };
  }

  private buildCacheRecord(raw: RawEvidence, cell: CostCell): BillingCacheRecord | null {
    // Decode the MCP content envelope the same way EvidenceNormalizer does:
    // the live AMG-MCP response is `{content:[{type:'text',text:'<json>'}]}`,
    // while fixture responses carry the decoded object directly. An upstream
    // wrapped error or an unparseable body yields no summary, so the cell is
    // not written (we never cache an error as authoritative billing data).
    const result = raw.result as ToolCallResult;
    const text = extractText(result);
    if (isWrappedError(text)) return null;
    const parsed = tryParseJson(text);
    const decoded = parsed ?? (text.length > 0 ? text : result.content);
    const summary = summarizeCostPayload(decoded);
    if (!summary) return null; // Don't cache a payload we can't summarize honestly.

    const maturity = evaluateMaturity({
      month: cell.month,
      costView: this.costView,
      policy: this.policy,
      now: this.now,
    });
    const period = monthBillingPeriod(cell.month);

    return {
      schema_version: CACHE_SCHEMA_VERSION,
      subscription_id: cell.subscriptionId,
      month: cell.month,
      billing_period: {
        start: period.start,
        end: period.end,
        granularity: 'Daily',
        billing_account_type: 'unknown',
      },
      maturity: {
        status: maturity.status,
        cost_view: this.costView,
        stabilization_offset_days: this.policy.stabilizationOffsetDays,
        became_cacheable_on: maturity.became_cacheable_on,
        late_adjustment_possible: maturity.late_adjustment_possible,
        retrieved_at: raw.retrieved_at,
      },
      source: {
        capability: raw.request.capability,
        capability_version: raw.capability_version,
        amg_mcp_endpoint_hash: this.store.cacheIdentity().endpointHash,
        scope: 'subscription',
        parameters_digest: cell.key.parametersDigest,
        currency_mode: this.currencyMode,
      },
      totals: summary.totals,
      dimensions: summary.dimensions,
      coverage: summary.coverage,
      raw_evidence: {
        capability: raw.request.capability,
        parameters: raw.request.parameters,
        intent: raw.request.intent,
        capability_version: raw.capability_version,
        result: raw.result,
      },
    };
  }
}

/**
 * Digest the cost query's SEMANTIC shape — the grouping, granularity, and
 * filter that determine *what* cost data is returned — normalized across the
 * playbook (snake_case + `grouping` / `granularity`) and live-planner
 * (camelCase; the wire schema allows none of those) param shapes.
 *
 * Deliberately an allowlist, not "everything except subscription + window":
 * an LLM planner echoes incidental wire params (e.g. `azureMonitorDatasourceUid`)
 * inconsistently from run to run, so digesting the whole call shape churned
 * the cache key and the cache could only ever write, never hit. Keying on
 * the query semantics keeps the same logical cost question stable across
 * runs. (This assumes one Azure Monitor data source per AMG-MCP endpoint —
 * the common case; the endpoint already partitions the tree above this.)
 */
function costQueryDigest(params: Record<string, unknown>): string {
  const grouping = Array.isArray(params.grouping)
    ? [...params.grouping].filter((g): g is string => typeof g === 'string').sort()
    : [];
  const granularity = typeof params.granularity === 'string' ? params.granularity : null;
  const filter = params.filter ?? null;
  return digestObject({ grouping, granularity, filter });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface CostSummary {
  totals: BillingCacheRecord['totals'];
  dimensions: BillingCacheRecord['dimensions'];
  coverage: BillingCacheRecord['coverage'];
}

/**
 * Summarize a cost-analysis payload into the audit-facing totals /
 * dimensions / coverage of a cache record. Handles the tabular shape
 * (`{columns, rows, total}`, what fixtures and the current AMG-MCP cost
 * surface return) and the live structured shape (`{subscriptions:[...]}`).
 * Returns null for anything unrecognized so the provider declines to cache
 * a misleading summary. The replay path does NOT depend on this — it uses
 * the retained raw payload — so this is provenance, not load-bearing data.
 */
export function summarizeCostPayload(content: unknown): CostSummary | null {
  if (typeof content !== 'object' || content === null) return null;
  const c = content as Record<string, unknown>;

  if (Array.isArray(c.rows) && Array.isArray(c.columns)) {
    return summarizeTabular(c);
  }
  if (Array.isArray(c.subscriptions)) {
    return summarizeLive(c.subscriptions);
  }
  return null;
}

function summarizeTabular(c: Record<string, unknown>): CostSummary | null {
  const cols = (c.columns as unknown[]).map((x) =>
    typeof x === 'object' && x !== null && typeof (x as { name?: unknown }).name === 'string'
      ? ((x as { name: string }).name)
      : '',
  );
  const di = cols.indexOf('UsageDate');
  const si = cols.indexOf('ServiceName');
  const ci = cols.indexOf('Cost');
  const cui = cols.indexOf('Currency');
  if (ci < 0) return null;

  const dailyMap = new Map<string, number>();
  const serviceMap = new Map<string, number>();
  const serviceDaily: Array<{ date: string; name: string; cost: number }> = [];
  let currency = 'USD';

  for (const row of c.rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    const cost = typeof row[ci] === 'number' ? (row[ci] as number) : 0;
    const date = di >= 0 ? String(row[di]) : '';
    const service = si >= 0 ? String(row[si]) : '';
    if (cui >= 0 && typeof row[cui] === 'string') currency = row[cui] as string;
    if (date) dailyMap.set(date, (dailyMap.get(date) ?? 0) + cost);
    if (service) {
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + cost);
      if (date) serviceDaily.push({ date, name: service, cost: round2(cost) });
    }
  }

  const total = c.total as { cost?: unknown; currency?: unknown } | undefined;
  const monthTotal =
    typeof total?.cost === 'number'
      ? total.cost
      : [...dailyMap.values()].reduce((a, b) => a + b, 0);
  if (typeof total?.currency === 'string') currency = total.currency;

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cost]) => ({ date, cost: round2(cost) }));
  const serviceMonthly = [...serviceMap.entries()].map(([name, cost]) => ({
    name,
    cost: round2(cost),
  }));
  const serviceSum = serviceMonthly.reduce((a, b) => a + b.cost, 0);

  return {
    totals: {
      currency,
      exchange_rate_date: null,
      month_total: round2(monthTotal),
      unattributed: round2(Math.max(0, monthTotal - serviceSum)),
      daily,
    },
    dimensions: {
      service: { monthly: serviceMonthly, daily: si >= 0 ? serviceDaily : [] },
      region: { monthly: [], daily: [], status: 'not_available_in_source' },
      resource_type: { monthly: [], daily: [], status: 'not_available_in_source' },
      resource_group: { monthly: [], daily: [], status: 'not_supported_by_current_capability' },
    },
    coverage: {
      complete: true,
      dimensions_reconcile: Math.abs(monthTotal - serviceSum) < 0.01,
      missing_dimensions: ['region', 'resource_type', 'resource_group', 'meter_category'],
      included_charge_classes: ['first_party_usage'],
      excluded_charge_classes: ['marketplace', 'tax', 'credits'],
      warnings: [],
    },
  };
}

function summarizeLive(subscriptions: unknown[]): CostSummary | null {
  let monthTotal = 0;
  let currency = 'USD';
  const serviceMap = new Map<string, number>();
  for (const sub of subscriptions) {
    if (typeof sub !== 'object' || sub === null) continue;
    const s = sub as Record<string, unknown>;
    if (typeof s.totalCost === 'number') monthTotal += s.totalCost;
    if (typeof s.currency === 'string') currency = s.currency;
    if (Array.isArray(s.byService)) {
      for (const entry of s.byService) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const name =
          typeof e.name === 'string'
            ? e.name
            : typeof e.serviceName === 'string'
              ? e.serviceName
              : undefined;
        const cost = typeof e.cost === 'number' ? e.cost : 0;
        if (name) serviceMap.set(name, (serviceMap.get(name) ?? 0) + cost);
      }
    }
  }
  const serviceMonthly = [...serviceMap.entries()].map(([name, cost]) => ({
    name,
    cost: round2(cost),
  }));
  const serviceSum = serviceMonthly.reduce((a, b) => a + b.cost, 0);
  return {
    totals: {
      currency,
      exchange_rate_date: null,
      month_total: round2(monthTotal),
      unattributed: round2(Math.max(0, monthTotal - serviceSum)),
      daily: [],
    },
    dimensions: {
      service: { monthly: serviceMonthly, daily: [], daily_status: 'not_available_in_source' },
      resource_group: { monthly: [], daily: [], status: 'not_supported_by_current_capability' },
    },
    coverage: {
      complete: true,
      dimensions_reconcile: Math.abs(monthTotal - serviceSum) < 0.01,
      missing_dimensions: ['region', 'resource_type', 'resource_group', 'meter_category'],
      included_charge_classes: ['first_party_usage'],
      excluded_charge_classes: ['marketplace', 'tax', 'credits'],
      warnings: [],
    },
  };
}
