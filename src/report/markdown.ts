import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  Fact,
  Hypothesis,
  Recommendation,
  DataQualityFinding,
} from '../schemas/index.js';
import { extractSubscriptions } from '../run/subscription-discovery.js';

/**
 * Markdown report assembler (design §4.8 / §10.2). Deterministic template
 * — no third LLM call — so the structured object is the source of truth
 * and the markdown is purely a view. Section order follows §10.2.
 */

export interface RenderReportInput {
  scope: Scope;
  reasoning: ReasoningOutput;
  evidence: EvidenceRecord[];
  metadata: RunMetadata;
}

export function renderMarkdownReport(input: RenderReportInput): string {
  const { scope, reasoning, evidence, metadata } = input;
  const sections = [
    title(scope),
    scopeAndDataSources(scope, evidence, metadata),
    costSummaryOverview(scope, evidence),
    executiveSummary(reasoning),
    recommendationsSection(reasoning),
    hypothesesSection(reasoning),
    factsSection(reasoning),
    dataQualitySection(reasoning),
    metadataFooter(metadata),
  ].filter((section) => section.length > 0);
  return sections.join('\n\n').trimEnd() + '\n';
}

// ---------------- sections ----------------

function title(scope: Scope): string {
  const display: Record<typeof scope.analysis_type, string> = {
    cost_surprise: 'Cost-Surprise',
    cost_summary: 'Cost Summary',
    idle_underused: 'Idle / Underused',
    quarterly_review: 'Quarterly Review',
    cost_telemetry_correlation: 'Cost-Telemetry Correlation',
    tagging_hygiene: 'Tagging Hygiene',
  };
  return `# Az-Pixiu ${display[scope.analysis_type]} Report`;
}

function scopeAndDataSources(scope: Scope, evidence: EvidenceRecord[], metadata: RunMetadata): string {
  const capabilities = Array.from(new Set(evidence.map((e) => e.source_capability))).sort();
  const names = buildSubscriptionNameMap(scope, evidence);
  const items: Record<string, string> = {
    Subscriptions: scope.subscription_ids.map((id) => fmtSubscription(id, names)).join(', '),
    'Resource groups': scope.resource_group_names?.join(', ') ?? '(all in scope)',
    'Analysis window': fmtWindow(scope.time_window),
  };
  if (scope.baseline_window) {
    items['Baseline window'] = fmtWindow(scope.baseline_window);
  }
  items['Analysis type'] = scope.analysis_type;
  items['Resource type filter'] = scope.resource_type_filter?.join(', ') ?? '(none)';
  items['Effective scope'] = scope.effective_scope_summary;
  items['Capabilities used'] = capabilities.length > 0 ? capabilities.join(', ') : '(none)';
  items['AMG-MCP endpoint'] = metadata.amg_mcp_endpoint;
  return ['## Scope & Data Sources', '', bullets(items)].join('\n');
}

function executiveSummary(reasoning: ReasoningOutput): string {
  const sorted = sortedRecommendations(reasoning.recommendations);
  if (sorted.length === 0) {
    return [
      '## Executive Summary',
      '',
      'No recommendations were produced. Refer to the Data Quality section for the reasons coverage was bounded.',
    ].join('\n');
  }
  const top = sorted[0]!;
  const dqByCategory = countBy(reasoning.data_quality, (d) => d.category);
  const dqLine =
    reasoning.data_quality.length > 0
      ? `Data-quality concerns: ${Object.entries(dqByCategory).map(([k, v]) => `${k} (${v})`).join(', ')}.`
      : 'No data-quality concerns surfaced.';
  return [
    '## Executive Summary',
    '',
    `${sorted.length} recommendation(s) across this scope. The top-priority item is **${top.priority}/${top.confidence.level}**: ${top.statement}`,
    '',
    dqLine,
  ].join('\n');
}

function costSummaryOverview(scope: Scope, evidence: EvidenceRecord[]): string {
  if (scope.analysis_type !== 'cost_summary') return '';

  const summary = summarizeCostEvidence(evidence);
  if (!summary) {
    return [
      '## Cost Summary Overview',
      '',
      'No cost-analysis payload was available for a deterministic spend overview. See Data Quality and Run Metadata for the bounded analysis context.',
    ].join('\n');
  }

  const lines: string[] = [
    '## Cost Summary Overview',
    '',
    bullets({
      'Total observed cost': formatMoney(summary.totalCost, summary.currency),
      'Cost records': String(summary.rowCount),
      'Cost evidence': summary.evidenceIds.join(', '),
    }),
  ];

  if (summary.topServices.length > 0) {
    lines.push(
      '',
      '**Top services:**',
      ...summary.topServices.map((s) => `- ${s.name}: ${formatMoney(s.cost, summary.currency)}`),
    );
  }

  if (summary.dailyTotals.length > 0) {
    const peak = summary.dailyTotals[0]!;
    const trough = summary.dailyTotals[summary.dailyTotals.length - 1]!;
    lines.push(
      '',
      bullets({
        'Peak observed day': `${peak.date} (${formatMoney(peak.cost, summary.currency)})`,
        'Lowest observed day': `${trough.date} (${formatMoney(trough.cost, summary.currency)})`,
      }),
    );
  }

  return lines.join('\n');
}

function recommendationsSection(reasoning: ReasoningOutput): string {
  const sorted = sortedRecommendations(reasoning.recommendations);
  if (sorted.length === 0) return '## Recommendations\n\n_(none)_';
  const blocks = sorted.map((rec) => renderRecommendation(rec, reasoning));
  return ['## Recommendations', ...blocks].join('\n\n');
}

function renderRecommendation(rec: Recommendation, reasoning: ReasoningOutput): string {
  const factById = new Map(reasoning.facts.map((f) => [f.fact_id, f] as const));
  const hypById = new Map(reasoning.hypotheses.map((h) => [h.hypothesis_id, h] as const));
  const citedHyps = rec.supported_by_hypothesis_ids
    .map((id) => hypById.get(id))
    .filter((h): h is Hypothesis => Boolean(h));
  const citedFacts = rec.supported_by_fact_ids
    .map((id) => factById.get(id))
    .filter((f): f is Fact => Boolean(f));

  return [
    `### ${rec.recommendation_id} — ${rec.priority.toUpperCase()} / ${rec.confidence.level.toUpperCase()} (impact: ${rec.impact})`,
    '',
    rec.statement,
    '',
    `**Confidence:** ${rec.confidence.level} — ${rec.confidence.rationale}`,
    `(coverage: ${rec.confidence.dimensions.evidence_coverage}, quality: ${rec.confidence.dimensions.signal_quality}, agreement: ${rec.confidence.dimensions.signal_agreement})`,
    '',
    `**Audience:** ${rec.suggested_audience.replace(/_/g, ' ')}`,
    '',
    section('Suggested human actions', rec.suggested_human_actions),
    section('Validation steps', rec.validation_steps),
    section('Assumptions', rec.assumptions),
    section('False-positive considerations', rec.false_positive_considerations),
    section(
      'Cited hypotheses',
      citedHyps.map((h) => `${h.hypothesis_id}: ${h.statement}`),
    ),
    section(
      'Cited facts',
      citedFacts.map((f) => `${f.fact_id}: ${f.statement}`),
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

function hypothesesSection(reasoning: ReasoningOutput): string {
  if (reasoning.hypotheses.length === 0) return '## Hypotheses\n\n_(none)_';
  const factById = new Map(reasoning.facts.map((f) => [f.fact_id, f] as const));
  const blocks = reasoning.hypotheses.map((h) => {
    const support = h.supported_by_fact_ids
      .map((id) => factById.get(id)?.statement ?? `(missing: ${id})`)
      .map((s) => `- ${s}`)
      .join('\n');
    const counter = h.counter_evidence_fact_ids
      .map((id) => factById.get(id)?.statement ?? `(missing: ${id})`)
      .map((s) => `- ${s}`)
      .join('\n');
    return [
      `### ${h.hypothesis_id} — confidence ${h.confidence.level}`,
      '',
      h.statement,
      '',
      `_Rationale:_ ${h.confidence.rationale}`,
      '',
      '**Supporting facts:**',
      support || '_(none)_',
      ...(counter
        ? ['', '**Counter-evidence facts:**', counter]
        : []),
    ].join('\n');
  });
  return ['## Hypotheses', ...blocks].join('\n\n');
}

function factsSection(reasoning: ReasoningOutput): string {
  if (reasoning.facts.length === 0) return '## Observed Facts\n\n_(none)_';
  const blocks = reasoning.facts.map((f) =>
    `### ${f.fact_id}\n\n${f.statement}\n\n**Evidence:** ${f.evidence_ids.join(', ')}`,
  );
  return ['## Observed Facts', ...blocks].join('\n\n');
}

function dataQualitySection(reasoning: ReasoningOutput): string {
  if (reasoning.data_quality.length === 0) return '## Data Quality\n\n_(none)_';
  const blocks = reasoning.data_quality.map(renderDataQuality);
  return ['## Data Quality', ...blocks].join('\n\n');
}

function renderDataQuality(d: DataQualityFinding): string {
  return [
    `### ${d.dq_id} — ${d.category}`,
    '',
    d.consequence_for_analysis,
    ...(d.affected_capability ? [`**Affected capability:** ${d.affected_capability}`] : []),
    ...(d.actionable_hint ? [`**Actionable hint:** ${d.actionable_hint}`] : []),
    ...(d.impact_on_recommendations.length > 0
      ? [`**Weakens:** ${d.impact_on_recommendations.join(', ')}`]
      : []),
  ].join('\n');
}

function metadataFooter(metadata: RunMetadata): string {
  return [
    '---',
    '',
    '## Run Metadata',
    '',
    bullets({
      run_id: metadata.run_id,
      trace_id: metadata.trace_id,
      status: metadata.status,
      model: `${metadata.model_provider}/${metadata.model_name} (${metadata.model_deployment_sku ? `sku: ${metadata.model_deployment_sku}, ` : ''}config_hash: ${metadata.model_config_hash})`,
      prompts: `planner: ${metadata.prompt_versions.planner}, reasoner: ${metadata.prompt_versions.reasoner}`,
      credential: `${metadata.credential_source.implementation} (${metadata.credential_source.identity})`,
      capabilities: Object.entries(metadata.capability_versions)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ') || '(none)',
      fixture: metadata.fixture_id ?? '(live)',
      started_at: metadata.started_at,
      ended_at: metadata.ended_at ?? '(in-progress)',
    }),
  ].join('\n');
}

// ---------------- helpers ----------------

function fmtWindow(w: { start: string; end: string }): string {
  return `${w.start} → ${w.end}`;
}

/**
 * Render a subscription id as `"<name>" (<id>)` when a name is known,
 * otherwise the bare id.
 */
function fmtSubscription(id: string, names: Record<string, string>): string {
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
function buildSubscriptionNameMap(
  scope: Scope,
  evidence: EvidenceRecord[],
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

function bullets(items: Record<string, string>): string {
  return Object.entries(items)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');
}

function section(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return [`**${title}:**`, ...items.map((s) => `- ${s}`)].join('\n');
}

interface CostSummary {
  totalCost: number;
  currency: string;
  rowCount: number;
  evidenceIds: string[];
  topServices: Array<{ name: string; cost: number }>;
  dailyTotals: Array<{ date: string; cost: number }>;
}

function summarizeCostEvidence(evidence: EvidenceRecord[]): CostSummary | undefined {
  const costRecords = evidence.filter((e) => e.source_capability === 'amgmcp_cost_analysis');
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

interface CostRow {
  date: string;
  serviceName: string;
  cost: number;
}

function parseCostAnalysisPayload(
  payload: unknown,
): { rows: CostRow[]; totalCost?: number; currency?: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;
  const rawRows = Array.isArray(obj.rows) ? obj.rows : [];
  const columnIndexes = costColumnIndexes(obj.columns);
  const rows: CostRow[] = [];

  for (const raw of rawRows) {
    const row = parseCostRow(raw, columnIndexes);
    if (row) rows.push(row);
  }

  const totalObj = typeof obj.total === 'object' && obj.total !== null
    ? (obj.total as Record<string, unknown>)
    : undefined;
  const totalCost = typeof totalObj?.cost === 'number' ? totalObj.cost : undefined;
  const currency =
    typeof totalObj?.currency === 'string'
      ? totalObj.currency
      : firstRowCurrency(rawRows, columnIndexes.currency) ?? 'unknown';

  return {
    rows,
    ...(totalCost !== undefined ? { totalCost } : {}),
    currency,
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

function formatMoney(value: number, currency: string): string {
  const amount = value.toFixed(2);
  return currency === 'unknown' ? amount : `${amount} ${currency}`;
}

const PRIORITY_ORDER: Record<Recommendation['priority'], number> = { high: 0, medium: 1, low: 2 };
const LEVEL_ORDER: Record<Recommendation['confidence']['level'], number> = { high: 0, medium: 1, low: 2 };

function sortedRecommendations(recs: readonly Recommendation[]): Recommendation[] {
  return [...recs].sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return LEVEL_ORDER[a.confidence.level] - LEVEL_ORDER[b.confidence.level];
  });
}

function countBy<T>(items: readonly T[], fn: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = fn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
