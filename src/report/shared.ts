import type {
  DataQualityFinding,
  EvidenceRecord,
  Recommendation,
  Scope,
} from '../schemas/index.js';
import { extractSubscriptions } from '../run/subscription-discovery.js';
import { COST_EVIDENCE_CAPABILITIES } from '../run/cost-capabilities.js';
import { isFullCoverage, type CostCoverage } from './coverage.js';

/**
 * Helpers shared between the markdown and HTML report renderers. The
 * two renderers walk the same {@link ReasoningOutput} sections and rely
 * on the same priority/confidence sort, money formatting, cost-evidence
 * summarisation, and coverage disclosure logic — extracting those keeps
 * both views in lockstep without either renderer importing the other.
 */

// ---------- abbreviation handling ----------

/**
 * Section-local abbreviation expander. The report stays primarily in
 * English; the only stylistic rule is that any obscure 2–3 letter
 * abbreviation must be spelled out on its first occurrence inside a
 * given section as `Full Phrase (ABBR)` and may be used bare in every
 * subsequent occurrence within that same section. Each top-level
 * section that mints such terms gets its own expander instance so the
 * code does not have to track document-global first-use.
 */
export function makeAbbrExpander(): {
  sku(): string;
  arg(): string;
} {
  const seen = new Set<string>();
  function expand(key: string, full: string, abbr: string): string {
    if (seen.has(key)) return abbr;
    seen.add(key);
    return `${full} (${abbr})`;
  }
  return {
    sku: () => expand('SKU', 'Stock Keeping Unit', 'SKU'),
    arg: () => expand('ARG', 'Azure Resource Graph', 'ARG'),
  };
}

/**
 * Service-name display helper. Cost-API responses surface a handful of
 * Azure service names whose canonical form contains a bare obscure
 * abbreviation (e.g. "Azure DDOS Protection"). The renderer expands
 * those on every occurrence — service-line rows are read out-of-order
 * by the operator (skim the top-services bullets, jump to a fact),
 * so a section-local "first use" rule does not buy clarity here.
 * Unrecognized service names pass through unchanged so the helper is
 * safe to apply uniformly wherever a cost-API service name is
 * rendered into the report.
 */
const SERVICE_NAME_EXPANSIONS: Record<string, string> = {
  'Azure DDOS Protection': 'Azure Distributed Denial of Service (DDoS) Protection',
  'Azure DDoS Protection': 'Azure Distributed Denial of Service (DDoS) Protection',
};

export function expandServiceName(name: string): string {
  return SERVICE_NAME_EXPANSIONS[name] ?? name;
}

// ---------- run-quality categories ----------

/**
 * Phase 2.5 — design/cost-summary-depth.md §Gap 6: the data-quality
 * categories the Run Quality section owns (transport / freshness).
 * Findings in these categories surface in Run Quality and are excluded
 * from the analytical "Data Quality — Retrieval Stage" section so the
 * report does not duplicate them.
 */
export const RUN_QUALITY_CATEGORIES: ReadonlySet<DataQualityFinding['category']> = new Set<
  DataQualityFinding['category']
>([
  'rate_limit',
  'timeout',
  'auth',
  'authz_gap',
  'schema_mismatch',
  'unsupported_capability',
  'stale_data',
  'freshness_partial_window',
  'freshness_uniform_drop',
  'cost_zero_suspected',
  'zero_unresolved',
  'cost_scope_mismatch',
  // Phase 3 — billing-access pre-flight probe excludes a candidate
  // before the analysis runs; the finding belongs in Run Quality
  // because it describes the operational state of subscription
  // discovery, not an analytical coverage gap.
  'billing_probe_excluded',
]);

// ---------- recommendation ordering ----------

const PRIORITY_ORDER: Record<Recommendation['priority'], number> = { high: 0, medium: 1, low: 2 };
const LEVEL_ORDER: Record<Recommendation['confidence']['level'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function sortedRecommendations(recs: readonly Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return LEVEL_ORDER[a.confidence.level] - LEVEL_ORDER[b.confidence.level];
  });
}

// ---------- formatting ----------

export function formatMoney(value: number, currency: string): string {
  const amount = value.toFixed(2);
  return currency === 'unknown' ? amount : `${amount} ${currency}`;
}

export function fmtWindow(w: { start: string; end: string }): string {
  return `${w.start} → ${w.end}`;
}

/**
 * Render a subscription id as `"<name>" (<id>)` when a name is known,
 * otherwise the bare id.
 */
export function fmtSubscription(id: string, names: Record<string, string>): string {
  const name = names[id];
  return name ? `"${name}" (${id})` : id;
}

/**
 * Build a (subscription_id → display name) lookup. Prefers names that
 * were carried on the Scope (e.g. populated by auto-discovery), and
 * falls back to extracting them from the
 * `amgmcp_query_azure_subscriptions` evidence record so explicit-id
 * runs also get readable names.
 */
export function buildSubscriptionNameMap(
  scope: Scope,
  evidence: readonly EvidenceRecord[],
): Record<string, string> {
  const out: Record<string, string> = { ...(scope.subscription_display_names ?? {}) };
  for (const ev of evidence) {
    if (ev.source_capability !== 'amgmcp_query_azure_subscriptions') continue;
    if (ev.payload_ref.kind !== 'inline') continue;
    for (const sub of extractSubscriptions(ev.payload_ref.data)) {
      if (sub.display_name && !out[sub.subscription_id]) {
        out[sub.subscription_id] = sub.display_name;
      }
    }
  }
  return out;
}

export function countBy<T>(items: readonly T[], fn: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = fn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ---------- executive-summary coverage / DQ helpers ----------

/**
 * Phase 3 §S2: deterministic coverage disclosure. The Executive Summary
 * surfaces incomplete cost-scope coverage as a first-class sentence so
 * an operator scanning the report header cannot miss that the analysis
 * was bounded. Renderer-owned, not prompt-owned.
 *
 * Returns null when coverage is fully complete or non-derivable with no
 * retrieval-stage failures — neither case needs disclosure.
 */
export function executiveCoverageLine(
  coverage: CostCoverage,
  inputDataQuality: readonly DataQualityFinding[],
): string | null {
  if (!coverage.derivable) {
    const failureFindings = inputDataQuality.filter((d) =>
      ['rate_limit', 'timeout', 'auth', 'authz_gap', 'unsupported_capability'].includes(d.category),
    );
    if (failureFindings.length === 0) return null;
    const categories = Array.from(new Set(failureFindings.map((d) => d.category))).sort();
    return `Coverage was incomplete due to retrieval-stage ${categories.join(', ')} finding(s); see Run Quality.`;
  }
  if (isFullCoverage(coverage)) return null;
  const covered = coverage.covered_ids.length;
  const expected = coverage.expected_ids.length;
  const unavailable = coverage.unavailable_ids.length;
  if (unavailable > 0) {
    const categories = Object.keys(coverage.unavailable_by_category).sort().join(', ');
    return `**Coverage:** ${covered} of ${expected} subscription(s) returned cost evidence; ${unavailable} had retrieval failures (${categories}).`;
  }
  const unknown = coverage.unknown_ids.length;
  return `**Coverage:** ${covered} of ${expected} subscription(s) returned cost evidence; ${unknown} returned neither evidence nor a classified failure.`;
}

export function formatExecutiveDqLine(
  reasonerDq: readonly DataQualityFinding[],
  inputDq: readonly DataQualityFinding[],
): string {
  if (reasonerDq.length === 0 && inputDq.length === 0) {
    return 'No data-quality concerns surfaced.';
  }
  const parts: string[] = [];
  if (reasonerDq.length > 0) {
    const byCategory = countBy(reasonerDq, (d) => d.category);
    parts.push(
      `Data-quality concerns: ${Object.entries(byCategory)
        .map(([k, v]) => `${k} (${v})`)
        .join(', ')}.`,
    );
  }
  const reasonerCategories = new Set(reasonerDq.map((d) => d.category));
  const droppedByCategory: Record<string, number> = {};
  for (const f of inputDq) {
    if (RUN_QUALITY_CATEGORIES.has(f.category)) continue;
    if (!reasonerCategories.has(f.category)) {
      droppedByCategory[f.category] = (droppedByCategory[f.category] ?? 0) + 1;
    }
  }
  const droppedEntries = Object.entries(droppedByCategory);
  if (droppedEntries.length > 0) {
    parts.push(
      `Retrieval-stage findings not echoed by the reasoner: ${droppedEntries
        .map(([k, v]) => `${k} (${v})`)
        .join(', ')}.`,
    );
  }
  return parts.join(' ');
}

// ---------- cost summary extraction ----------

export interface CostSummary {
  totalCost: number;
  currency: string;
  rowCount: number;
  evidenceIds: string[];
  topServices: Array<{ name: string; cost: number }>;
  dailyTotals: Array<{ date: string; cost: number }>;
}

interface CostRow {
  date: string;
  serviceName: string;
  cost: number;
}

interface ParsedCostPayload {
  rows: CostRow[];
  totalCost?: number;
  currency?: string;
  liveServiceCosts?: Array<{ serviceName: string; cost: number }>;
}

export function summarizeCostEvidence(
  evidence: readonly EvidenceRecord[],
): CostSummary | undefined {
  // Includes wire cost evidence and cache-served cost evidence
  // (`az_pixiu_billing_cache`) so the Cost Summary Overview still renders
  // when a usage-stable month was served from the local billing cache.
  const costRecords = evidence.filter((e) => COST_EVIDENCE_CAPABILITIES.has(e.source_capability));
  if (costRecords.length === 0) return undefined;

  let totalFromRows = 0;
  let totalFromPayloads = 0;
  let rowCount = 0;
  let currency = 'unknown';
  const serviceTotals = new Map<string, number>();
  const dailyTotals = new Map<string, number>();
  const evidenceIds: string[] = [];

  for (const record of costRecords) {
    evidenceIds.push(record.evidence_id);
    const payload = record.payload_ref.kind === 'inline' ? record.payload_ref.data : undefined;
    const parsed = parseCostAnalysisPayload(payload);
    if (!parsed) continue;

    if (parsed.currency) currency = parsed.currency;
    if (parsed.totalCost !== undefined) totalFromPayloads += parsed.totalCost;
    rowCount += parsed.rows.length;

    for (const row of parsed.rows) {
      totalFromRows += row.cost;
      add(serviceTotals, row.serviceName, row.cost);
      add(dailyTotals, row.date, row.cost);
    }

    if (parsed.liveServiceCosts) {
      for (const entry of parsed.liveServiceCosts) {
        add(serviceTotals, entry.serviceName, entry.cost);
      }
      rowCount += parsed.liveServiceCosts.length;
    }
  }

  const totalCost = totalFromRows > 0 ? totalFromRows : totalFromPayloads;
  return {
    totalCost,
    currency,
    rowCount,
    evidenceIds,
    topServices: topEntries(serviceTotals, 5).map(([name, cost]) => ({ name, cost })),
    dailyTotals: topEntries(dailyTotals, dailyTotals.size).map(([date, cost]) => ({ date, cost })),
  };
}

function parseCostAnalysisPayload(payload: unknown): ParsedCostPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;

  const rawRows = Array.isArray(obj.rows) ? obj.rows : [];
  const columnIndexes = costColumnIndexes(obj.columns);
  const rows: CostRow[] = [];
  for (const raw of rawRows) {
    const row = parseCostRow(raw, columnIndexes);
    if (row) rows.push(row);
  }
  const totalObj =
    typeof obj.total === 'object' && obj.total !== null
      ? (obj.total as Record<string, unknown>)
      : undefined;
  let totalCost = typeof totalObj?.cost === 'number' ? totalObj.cost : undefined;
  let currency: string | undefined =
    typeof totalObj?.currency === 'string'
      ? totalObj.currency
      : firstRowCurrency(rawRows, columnIndexes.currency);

  let liveServiceCosts: Array<{ serviceName: string; cost: number }> | undefined;
  if (Array.isArray(obj.subscriptions)) {
    const services: Array<{ serviceName: string; cost: number }> = [];
    for (const sub of obj.subscriptions) {
      if (typeof sub !== 'object' || sub === null) continue;
      const s = sub as Record<string, unknown>;
      if (typeof s.totalCost === 'number') {
        totalCost = (totalCost ?? 0) + s.totalCost;
      }
      if (!currency && typeof s.currency === 'string') currency = s.currency;
      const byService = Array.isArray(s.byService) ? s.byService : [];
      for (const entry of byService) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name === 'string' && typeof e.cost === 'number') {
          services.push({ serviceName: e.name, cost: e.cost });
        }
      }
    }
    if (services.length > 0) liveServiceCosts = services;
  }

  return {
    rows,
    ...(totalCost !== undefined ? { totalCost } : {}),
    currency: currency ?? 'unknown',
    ...(liveServiceCosts ? { liveServiceCosts } : {}),
  };
}

function parseCostRow(
  raw: unknown,
  indexes: { date: number; serviceName: number; cost: number },
): CostRow | undefined {
  if (!Array.isArray(raw)) return undefined;
  const date = typeof raw[indexes.date] === 'string' ? raw[indexes.date] : undefined;
  const serviceName =
    typeof raw[indexes.serviceName] === 'string' ? raw[indexes.serviceName] : undefined;
  const cost = typeof raw[indexes.cost] === 'number' ? raw[indexes.cost] : undefined;
  if (!date || !serviceName || cost === undefined) return undefined;
  return { date, serviceName, cost };
}

function costColumnIndexes(columns: unknown): {
  date: number;
  serviceName: number;
  cost: number;
  currency: number;
} {
  if (!Array.isArray(columns)) return { date: 0, serviceName: 1, cost: 2, currency: 3 };
  const names = columns.map((c) =>
    typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string'
      ? (c as { name: string }).name.toLowerCase()
      : '',
  );
  return {
    date: indexOrDefault(names, ['usagedate', 'date'], 0),
    serviceName: indexOrDefault(names, ['servicename', 'service'], 1),
    cost: indexOrDefault(names, ['cost', 'pretaxcost'], 2),
    currency: indexOrDefault(names, ['currency'], 3),
  };
}

function indexOrDefault(names: string[], candidates: string[], fallback: number): number {
  const index = names.findIndex((name) => candidates.includes(name));
  return index === -1 ? fallback : index;
}

function firstRowCurrency(rows: unknown[], currencyIndex: number): string | undefined {
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const value = row[currencyIndex];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()]
    .sort((a, b) => {
      const byValue = b[1] - a[1];
      if (byValue !== 0) return byValue;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit);
}
