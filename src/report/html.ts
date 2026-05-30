import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  DataQualityFinding,
  Fact,
  Hypothesis,
  Recommendation,
  TransportSummaryEntry,
} from '../schemas/index.js';
import {
  rollupTransportSummary,
  type TransportCapabilityRollup,
  type TransportRollup,
} from '../schemas/transport.js';
import {
  computeCostCoverage,
  isFullCoverage,
  type CostCoverage,
} from './coverage.js';
import type { WasteLaneResult } from '../playbooks/waste-lanes/types.js';
import {
  RUN_QUALITY_CATEGORIES,
  buildSubscriptionNameMap,
  executiveCoverageLine,
  expandServiceName,
  fmtSubscription,
  fmtWindow,
  formatExecutiveDqLine,
  formatMoney,
  makeAbbrExpander,
  sortedRecommendations,
  summarizeCostEvidence,
  type CostSummary,
} from './shared.js';
import type { RenderReportInput } from './markdown.js';
import { CSS_INLINE, JS_INLINE } from './html-assets.js';

/**
 * HTML report assembler. Mirrors {@link renderMarkdownReport}
 * section-for-section against the same structured {@link ReasoningOutput},
 * so the markdown file and HTML file describe the same analysis but the
 * HTML adds layout, color, sticky TOC, citation links, and a copyable
 * recommendation filter. The output is a single self-contained file —
 * no external CSS, fonts, scripts, or images.
 */

export function renderHtmlReport(input: RenderReportInput): string {
  const {
    scope,
    reasoning,
    evidence,
    metadata,
    inputDataQuality = [],
    transportSummary = [],
    wasteLanes = [],
  } = input;
  const coverage = computeCostCoverage({ scope, evidence, transportSummary });
  const rollup = rollupTransportSummary(transportSummary);
  const sortedRecs = sortedRecommendations(reasoning.recommendations);
  const backlinks = buildBacklinks(reasoning);
  // Pull §7.5 post-process cleanup findings (dq-synth-*) out of the
  // main DQ lists so they don't clutter Run Quality or the retrieval-
  // stage analytical view — they're rendered together in a collapsed
  // cleanup block below.
  const cleanupFindings = inputDataQuality.filter((d) => d.dq_id.startsWith('dq-synth-'));
  const nonCleanupInputDq = inputDataQuality.filter((d) => !d.dq_id.startsWith('dq-synth-'));

  // Pre-compute TOC entries; order matches the body. Sections are
  // skipped from the TOC when their body would render empty so the
  // sidebar stays an honest map of the page.
  const tocEntries: TocEntry[] = [];
  pushToc(tocEntries, 'scope', 'Scope & Data Sources');
  pushToc(tocEntries, 'run-quality', 'Run Quality');
  if (scope.analysis_type === 'cost_summary') {
    pushToc(tocEntries, 'cost-overview', 'Cost Summary Overview');
  }
  pushToc(tocEntries, 'executive', 'Executive Summary');
  if (wasteLanes.length > 0) {
    pushToc(
      tocEntries,
      'waste',
      'Waste Candidates',
      wasteLanes.reduce((sum, l) => sum + l.candidates.length, 0),
    );
  }
  pushToc(tocEntries, 'recommendations', 'Recommendations', sortedRecs.length);
  pushToc(tocEntries, 'hypotheses', 'Hypotheses', reasoning.hypotheses.length);
  pushToc(tocEntries, 'facts', 'Observed Facts', reasoning.facts.length);
  const analyticalInputDq = nonCleanupInputDq.filter(
    (d) => !RUN_QUALITY_CATEGORIES.has(d.category),
  );
  if (analyticalInputDq.length > 0 || cleanupFindings.length > 0) {
    pushToc(
      tocEntries,
      'dq-retrieval',
      'Data Quality — Retrieval Stage',
      analyticalInputDq.length + cleanupFindings.length,
    );
  }
  pushToc(tocEntries, 'dq', 'Data Quality', reasoning.data_quality.length);
  pushToc(tocEntries, 'metadata', 'Run Metadata');

  const body = [
    titleBlock(scope),
    scopeSection(scope, evidence, metadata),
    runQualitySection(nonCleanupInputDq, rollup, coverage),
    costOverviewSection(scope, evidence),
    executiveSection(reasoning, inputDataQuality, coverage, sortedRecs),
    wasteSection(wasteLanes),
    recommendationsSection(sortedRecs, reasoning, backlinks),
    hypothesesSection(reasoning, backlinks),
    factsSection(reasoning, backlinks),
    retrievalStageDqSection(analyticalInputDq, cleanupFindings, reasoning),
    dataQualitySection(reasoning),
    metadataSection(metadata),
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  const titleText = `Az-Pixiu ${analysisDisplay(scope.analysis_type)} Report`;

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">`,
    `<title>${escapeHtml(titleText)}</title>`,
    `<style>${CSS_INLINE}</style>`,
    '</head>',
    '<body>',
    '<div class="toolbar">',
    '<button type="button" id="theme-toggle" class="btn" aria-label="Toggle color theme">🌙 Dark</button>',
    '</div>',
    '<div class="layout">',
    renderToc(tocEntries),
    '<main class="main">',
    renderMobileToc(tocEntries),
    body,
    '</main>',
    '</div>',
    `<script>${JS_INLINE}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------- title + scope ----------------

function analysisDisplay(t: Scope['analysis_type']): string {
  const map: Record<Scope['analysis_type'], string> = {
    cost_surprise: 'Cost-Surprise',
    cost_summary: 'Cost Summary',
    idle_underused: 'Idle / Underused',
    quarterly_review: 'Quarterly Review',
    cost_telemetry_correlation: 'Cost-Telemetry Correlation',
    tagging_hygiene: 'Tagging Hygiene',
  };
  return map[t];
}

function titleBlock(scope: Scope): string {
  return `<h1>Az-Pixiu ${escapeHtml(analysisDisplay(scope.analysis_type))} Report</h1>`;
}

function scopeSection(scope: Scope, evidence: EvidenceRecord[], metadata: RunMetadata): string {
  const names = buildSubscriptionNameMap(scope, evidence);
  const capabilities = Array.from(new Set(evidence.map((e) => e.source_capability))).sort();
  const subscriptions = scope.subscription_ids.map((id) => fmtSubscription(id, names)).join(', ');
  const items: Array<[string, string]> = [
    ['Subscriptions', subscriptions],
    ['Resource groups', scope.resource_group_names?.join(', ') ?? '(all in scope)'],
    ['Analysis window', fmtWindow(scope.time_window)],
  ];
  if (scope.baseline_window) items.push(['Baseline window', fmtWindow(scope.baseline_window)]);
  items.push(
    ['Analysis type', scope.analysis_type],
    ['Resource type filter', scope.resource_type_filter?.join(', ') ?? '(none)'],
    ['Effective scope', scope.effective_scope_summary],
    ['Capabilities used', capabilities.length > 0 ? capabilities.join(', ') : '(none)'],
    ['AMG-MCP endpoint', metadata.amg_mcp_endpoint],
  );
  const rows = items
    .map(
      ([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`,
    )
    .join('');
  return [
    sectionOpen('scope', 'Scope & Data Sources'),
    `<div class="scope-grid">${rows}</div>`,
  ].join('\n');
}

// ---------------- run quality ----------------

function runQualitySection(
  inputDataQuality: readonly DataQualityFinding[],
  rollup: TransportRollup,
  coverage: CostCoverage,
): string {
  const findings = inputDataQuality.filter((d) => RUN_QUALITY_CATEGORIES.has(d.category));
  const freshnessCount = inputDataQuality.filter(
    (d) => d.category === 'freshness_partial_window' || d.category === 'freshness_uniform_drop',
  ).length;
  const baselineLine = runQualityBaseline(rollup, coverage, freshnessCount);
  const capabilityItems = recoveredCapabilityItems(rollup);

  const parts = [sectionOpen('run-quality', 'Run Quality'), `<p>${escapeHtml(baselineLine)}</p>`];
  if (capabilityItems.length > 0) {
    parts.push(
      '<ul>',
      ...capabilityItems.map((line) => `<li>${line}</li>`),
      '</ul>',
    );
  }
  for (const finding of findings) {
    parts.push(renderRunQualityFinding(finding));
  }
  return parts.join('\n');
}

function runQualityBaseline(
  rollup: TransportRollup,
  coverage: CostCoverage,
  freshnessCount: number,
): string {
  const callCount = `${rollup.exhausted_count} transport error(s), ${rollup.retry_count} retry attempt(s), ${freshnessCount} freshness finding(s) across ${rollup.total_calls} evidence request(s)`;
  let coverageClause: string;
  if (!coverage.derivable) {
    coverageClause = 'cost-scope coverage not derivable from evidence metadata';
  } else if (isFullCoverage(coverage)) {
    coverageClause = `full cost-scope coverage (${coverage.covered_ids.length} of ${coverage.expected_ids.length} subscription(s) returned cost evidence)`;
  } else {
    coverageClause = `partial cost-scope coverage (${coverage.covered_ids.length} of ${coverage.expected_ids.length} subscription(s) returned cost evidence)`;
  }
  return `${callCount}; ${coverageClause}.`;
}

function recoveredCapabilityItems(rollup: TransportRollup): string[] {
  const entries: Array<[string, TransportCapabilityRollup]> = Object.entries(
    rollup.by_capability,
  ).sort((a, b) => a[0].localeCompare(b[0]));
  const lines: string[] = [];
  for (const [name, c] of entries) {
    if (c.retry_count === 0 && !c.rate_limit_seen) continue;
    const backoffSeconds = Math.round(c.cumulative_backoff_ms / 1000);
    const outcome =
      c.exhausted_count === 0
        ? 'all attempts ultimately succeeded'
        : c.recovered_count === 0
          ? 'all retries exhausted'
          : `${c.recovered_count} recovered, ${c.exhausted_count} exhausted`;
    lines.push(
      `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(c.retry_count + ' retry attempt(s), ' + backoffSeconds + 's cumulative backoff, ' + outcome)}.`,
    );
  }
  return lines;
}

function renderRunQualityFinding(d: DataQualityFinding): string {
  return [
    `<article class="dq" id="${escapeAttr(d.dq_id)}">`,
    `<div class="card-head"><span class="title">Data Quality finding ${escapeHtml(d.dq_id)} — ${escapeHtml(d.category)}</span></div>`,
    `<p class="statement">${escapeHtml(d.consequence_for_analysis)}</p>`,
    d.affected_capability
      ? `<p><strong>Affected capability:</strong> <code>${escapeHtml(d.affected_capability)}</code></p>`
      : '',
    d.actionable_hint ? `<p><strong>Actionable hint:</strong> ${escapeHtml(d.actionable_hint)}</p>` : '',
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------- cost overview ----------------

function costOverviewSection(scope: Scope, evidence: EvidenceRecord[]): string {
  if (scope.analysis_type !== 'cost_summary') return '';
  const summary = summarizeCostEvidence(evidence);
  const parts = [sectionOpen('cost-overview', 'Cost Summary Overview')];
  if (!summary) {
    parts.push(
      `<p class="note">No cost-analysis payload was available for a deterministic spend overview. See Data Quality and Run Metadata for the bounded analysis context.</p>`,
    );
    return parts.join('\n');
  }
  parts.push(renderCostStats(summary));
  if (summary.topServices.length > 0) {
    parts.push('<h3>Top services</h3>', renderCostBars(summary));
  }
  if (summary.dailyTotals.length > 0) {
    parts.push(renderDailySparkline(summary));
    parts.push(renderPeakTrough(summary));
  }
  return parts.join('\n');
}

function renderCostStats(s: CostSummary): string {
  const tiles = [
    {
      label: 'Total observed cost',
      value: formatMoney(s.totalCost, s.currency),
    },
    {
      label: 'Cost records',
      value: String(s.rowCount),
    },
    {
      label: 'Cost evidence',
      monoValue: s.evidenceIds.join(', '),
    },
  ];
  return [
    '<div class="stat-grid">',
    ...tiles.map((t) => {
      if ('monoValue' in t && t.monoValue !== undefined) {
        return `<div class="stat"><div class="label">${escapeHtml(t.label)}</div><div class="value-mono">${escapeHtml(t.monoValue)}</div></div>`;
      }
      return `<div class="stat"><div class="label">${escapeHtml(t.label)}</div><div class="value">${escapeHtml(t.value!)}</div></div>`;
    }),
    '</div>',
  ].join('');
}

function renderCostBars(s: CostSummary): string {
  const max = Math.max(...s.topServices.map((x) => x.cost), 0);
  if (max <= 0) return '';
  const rows = s.topServices
    .map((svc) => {
      const pct = Math.round((svc.cost / max) * 100);
      const label = expandServiceName(svc.name);
      return `<li class="bar"><span class="bar__label">${escapeHtml(label)}</span><div class="bar__bar" style="--w:${pct}%"></div><span class="bar__value">${escapeHtml(formatMoney(svc.cost, s.currency))}</span></li>`;
    })
    .join('');
  return `<ul class="bars">${rows}</ul>`;
}

function renderDailySparkline(s: CostSummary): string {
  if (s.dailyTotals.length < 2) return '';
  // dailyTotals as returned is sorted high-to-low by cost; render the
  // sparkline in chronological order so the shape is meaningful.
  const chronological = [...s.dailyTotals].sort((a, b) => a.date.localeCompare(b.date));
  const W = 600;
  const H = 60;
  const PAD = 4;
  const max = Math.max(...chronological.map((d) => d.cost));
  const min = Math.min(...chronological.map((d) => d.cost));
  const range = max - min || 1;
  const stepX = chronological.length === 1 ? 0 : (W - 2 * PAD) / (chronological.length - 1);
  const points = chronological.map((d, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - ((d.cost - min) / range) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${points.join(' L ')}`;
  const span = `${chronological[0]!.date} → ${chronological[chronological.length - 1]!.date}`;
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily cost trend"><title>Daily cost trend: ${escapeHtml(span)}</title><path d="${escapeAttr(path)}" /></svg>`;
}

function renderPeakTrough(s: CostSummary): string {
  const peak = s.dailyTotals[0]!;
  const trough = s.dailyTotals[s.dailyTotals.length - 1]!;
  const rows = [
    [
      'Peak observed day',
      `${peak.date} (${formatMoney(peak.cost, s.currency)})`,
    ],
    [
      'Lowest observed day',
      `${trough.date} (${formatMoney(trough.cost, s.currency)})`,
    ],
  ];
  return [
    '<div class="scope-grid">',
    ...rows.map(
      ([k, v]) => `<div class="k">${escapeHtml(k!)}</div><div class="v">${escapeHtml(v!)}</div>`,
    ),
    '</div>',
  ].join('');
}

// ---------------- executive summary ----------------

function executiveSection(
  reasoning: ReasoningOutput,
  inputDataQuality: readonly DataQualityFinding[],
  coverage: CostCoverage,
  sortedRecs: readonly Recommendation[],
): string {
  const coverageLine = executiveCoverageLine(coverage, inputDataQuality);
  const parts = [sectionOpen('executive', 'Executive Summary')];
  if (coverageLine !== null) {
    parts.push(`<p>${renderInlineMarkdown(coverageLine)}</p>`);
  }
  if (sortedRecs.length === 0) {
    parts.push(
      '<p>No recommendations were produced. Refer to the Data Quality section for the reasons coverage was bounded.</p>',
    );
    return parts.join('\n');
  }
  const top = sortedRecs[0]!;
  parts.push(
    `<p>${escapeHtml(String(sortedRecs.length))} recommendation(s) across this scope. The top-priority item is <strong>${escapeHtml(top.priority)}/${escapeHtml(top.confidence.level)}</strong>: ${escapeHtml(top.statement)}</p>`,
  );
  const dqLine = formatExecutiveDqLine(reasoning.data_quality, inputDataQuality);
  parts.push(`<p>${escapeHtml(dqLine)}</p>`);
  return parts.join('\n');
}

// ---------------- waste candidates ----------------

function wasteSection(lanes: readonly WasteLaneResult[]): string {
  if (lanes.length === 0) return '';
  const parts = [sectionOpen('waste', 'Waste Candidates')];
  for (const lane of lanes) {
    const expander = makeAbbrExpander();
    parts.push(`<h3>${escapeHtml(lane.title)} (<code>${escapeHtml(lane.lane)}</code>)</h3>`);
    if (lane.failed) {
      parts.push(
        `<p class="note">The lane's resource-graph call did not return data this run (transport failure or retries exhausted). No candidates enumerated; see Run Quality for details.</p>`,
        `<p><strong>Classification predicate:</strong> <code>${escapeHtml(lane.predicate_text)}</code></p>`,
      );
      continue;
    }
    if (lane.candidates.length === 0) {
      parts.push(
        `<p class="note">No matching resources in scope.</p>`,
        `<p><strong>Classification predicate:</strong> <code>${escapeHtml(lane.predicate_text)}</code></p>`,
      );
      continue;
    }
    parts.push('<ul>');
    for (const c of lane.candidates) {
      parts.push(`<li>${renderWasteCandidate(c, expander)}</li>`);
    }
    parts.push('</ul>');
    const total = lane.lane_total;
    if (total.available_count > 0) {
      parts.push(
        `<p><strong>Lane total (${escapeHtml(String(total.available_count))} priced candidate(s)):</strong> ~$${escapeHtml(total.low_usd.toFixed(2))}–$${escapeHtml(total.high_usd.toFixed(2))}/week, list-price estimate.</p>`,
      );
    } else {
      parts.push(
        `<p><strong>Lane total:</strong> no priced candidates (every ${escapeHtml(expander.sku())} was unavailable from the rate card).</p>`,
      );
    }
    if (total.unavailable_count > 0) {
      const skus = total.unavailable_skus.map((s) => s.sku).join(', ');
      parts.push(
        `<p class="note">${escapeHtml(String(total.unavailable_count))} candidate(s) excluded from the total — rate unavailable for ${escapeHtml(expander.sku())}(s): ${escapeHtml(skus)}.</p>`,
      );
    }
    parts.push(
      `<p><strong>Classification predicate:</strong> <code>${escapeHtml(lane.predicate_text)}</code></p>`,
      `<p><strong>Rate source:</strong> in-repo rate card captured ${escapeHtml(lane.rate_source_captured_at)}; list-price only — reservations, savings plans, hybrid benefit, and negotiated discounts are NOT modelled.</p>`,
    );
    if (lane.unparsed_row_count > 0) {
      parts.push(
        `<p class="note">${escapeHtml(String(lane.unparsed_row_count))} ${escapeHtml(expander.arg())} row(s) were unparseable by this lane and excluded from the enumeration.</p>`,
      );
    }
  }
  return parts.join('\n');
}

function renderWasteCandidate(
  c: WasteLaneResult['candidates'][number],
  expander: ReturnType<typeof makeAbbrExpander>,
): string {
  const id = c.candidate.resource_id;
  const sku = c.candidate.sku;
  const region = c.candidate.location || '(unknown)';
  const impact = c.estimated_weekly_impact;
  if (impact.kind === 'available') {
    return `<strong>${escapeHtml(c.candidate.name)}</strong> (<code>${escapeHtml(id)}</code>) — ${escapeHtml(expander.sku())} ${escapeHtml(sku)} in ${escapeHtml(region)} — ~$${escapeHtml(impact.low_usd.toFixed(2))}–$${escapeHtml(impact.high_usd.toFixed(2))}/week`;
  }
  return `<strong>${escapeHtml(c.candidate.name)}</strong> (<code>${escapeHtml(id)}</code>) — ${escapeHtml(expander.sku())} ${escapeHtml(sku)} in ${escapeHtml(region)} — <em>(rate unavailable for SKU ${escapeHtml(sku)})</em>`;
}

// ---------------- recommendations ----------------

function recommendationsSection(
  sortedRecs: readonly Recommendation[],
  reasoning: ReasoningOutput,
  backlinks: Backlinks,
): string {
  const parts = [sectionOpen('recommendations', 'Recommendations')];
  if (sortedRecs.length === 0) {
    parts.push('<p class="note">(none)</p>');
    return parts.join('\n');
  }
  parts.push(
    '<div class="filter-row">',
    '<input id="rec-filter" type="text" placeholder="Filter recommendations by statement, id, signature…" aria-label="Filter recommendations">',
    '<span id="rec-match-count" class="match-count"></span>',
    '</div>',
  );
  for (const rec of sortedRecs) {
    parts.push(renderRecommendationCard(rec, reasoning, backlinks));
  }
  return parts.join('\n');
}

function renderRecommendationCard(
  rec: Recommendation,
  reasoning: ReasoningOutput,
  _backlinks: Backlinks,
): string {
  const factById = new Map(reasoning.facts.map((f) => [f.fact_id, f] as const));
  const hypById = new Map(reasoning.hypotheses.map((h) => [h.hypothesis_id, h] as const));
  const citedHyps = rec.supported_by_hypothesis_ids
    .map((id) => hypById.get(id))
    .filter((h): h is Hypothesis => Boolean(h));
  const citedFacts = rec.supported_by_fact_ids
    .map((id) => factById.get(id))
    .filter((f): f is Fact => Boolean(f));
  const search = [
    rec.recommendation_id,
    rec.recommendation_signature,
    rec.statement,
    rec.priority,
    rec.confidence.level,
  ].join(' ');

  const parts: string[] = [
    `<article class="rec rec--${escapeAttr(rec.priority)}" id="${escapeAttr(rec.recommendation_id)}" data-search="${escapeAttr(search)}">`,
    '<div class="card-head">',
    `<span class="badge badge--prio-${escapeAttr(rec.priority)}">${escapeHtml(rec.priority)}</span>`,
    `<span class="badge badge--conf-${escapeAttr(rec.confidence.level)}">${escapeHtml(rec.confidence.level)}</span>`,
    `<span class="badge badge--impact">impact: ${escapeHtml(rec.impact)}</span>`,
    `<span class="title">Recommendation <code>${escapeHtml(rec.recommendation_id)}</code></span>`,
    '<button type="button" class="copy-btn" data-copy="' +
      escapeAttr(rec.recommendation_id) +
      '" aria-label="Copy recommendation id">copy</button>',
    `<span class="sig">signature: ${escapeHtml(rec.recommendation_signature)}</span>`,
    '</div>',
    `<p class="statement">${escapeHtml(rec.statement)}</p>`,
    `<p><strong>Confidence:</strong> ${escapeHtml(rec.confidence.level)} — ${escapeHtml(rec.confidence.rationale)}</p>`,
    renderDims(rec.confidence.dimensions),
    `<p><strong>Audience:</strong> ${escapeHtml(rec.suggested_audience.replace(/_/g, ' '))}</p>`,
    renderSubList('Suggested human actions', rec.suggested_human_actions),
    renderSubList('Validation steps', rec.validation_steps),
    renderSubList('Assumptions', rec.assumptions),
    renderSubList('False-positive considerations', rec.false_positive_considerations),
    renderCitationList(
      'Cited hypotheses',
      citedHyps.map((h) => ({
        anchor: h.hypothesis_id,
        label: `Hypothesis ${h.hypothesis_id}`,
        text: h.statement,
      })),
    ),
    renderCitationList(
      'Cited facts',
      citedFacts.map((f) => ({
        anchor: f.fact_id,
        label: `Fact ${f.fact_id}`,
        text: f.statement,
      })),
    ),
    '</article>',
  ];
  return parts.filter(Boolean).join('\n');
}

function renderDims(dims: Recommendation['confidence']['dimensions']): string {
  const cell = (
    label: string,
    value: string,
    flavor: 'strong' | 'mixed' | 'weak',
  ): string =>
    `<div class="dim dim--${flavor}"><div class="dim-label">${escapeHtml(label)}</div><div class="dim-value">${escapeHtml(value)}</div></div>`;
  const coverageFlavor: 'strong' | 'mixed' | 'weak' =
    dims.evidence_coverage === 'strong'
      ? 'strong'
      : dims.evidence_coverage === 'adequate'
        ? 'mixed'
        : 'weak';
  const qualityFlavor: 'strong' | 'mixed' | 'weak' =
    dims.signal_quality === 'strong'
      ? 'strong'
      : dims.signal_quality === 'mixed'
        ? 'mixed'
        : 'weak';
  const agreementFlavor: 'strong' | 'mixed' | 'weak' =
    dims.signal_agreement === 'aligned'
      ? 'strong'
      : dims.signal_agreement === 'mixed'
        ? 'mixed'
        : 'weak';
  return [
    '<div class="dims">',
    cell('evidence coverage', dims.evidence_coverage, coverageFlavor),
    cell('signal quality', dims.signal_quality, qualityFlavor),
    cell('signal agreement', dims.signal_agreement, agreementFlavor),
    '</div>',
  ].join('');
}

function renderSubList(label: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  const lis = items.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  return `<div class="subsec"><h4>${escapeHtml(label)}</h4><ul>${lis}</ul></div>`;
}

function renderCitationList(
  label: string,
  cites: ReadonlyArray<{ anchor: string; label: string; text: string }>,
): string {
  if (cites.length === 0) return '';
  const lis = cites
    .map(
      (c) =>
        `<li><a class="citation" href="#${escapeAttr(c.anchor)}">${escapeHtml(c.label)}</a>: ${escapeHtml(c.text)}</li>`,
    )
    .join('');
  return `<div class="subsec"><h4>${escapeHtml(label)}</h4><ul>${lis}</ul></div>`;
}

// ---------------- hypotheses ----------------

function hypothesesSection(reasoning: ReasoningOutput, backlinks: Backlinks): string {
  const parts = [sectionOpen('hypotheses', 'Hypotheses')];
  if (reasoning.hypotheses.length === 0) {
    parts.push('<p class="note">(none)</p>');
    return parts.join('\n');
  }
  const factById = new Map(reasoning.facts.map((f) => [f.fact_id, f] as const));
  for (const h of reasoning.hypotheses) {
    parts.push(renderHypothesisCard(h, factById, backlinks));
  }
  return parts.join('\n');
}

function renderHypothesisCard(
  h: Hypothesis,
  factById: ReadonlyMap<string, Fact>,
  backlinks: Backlinks,
): string {
  const support = h.supported_by_fact_ids.map((id) => ({
    anchor: id,
    label: `Fact ${id}`,
    text: factById.get(id)?.statement ?? `(missing: ${id})`,
  }));
  const counter = h.counter_evidence_fact_ids.map((id) => ({
    anchor: id,
    label: `Fact ${id}`,
    text: factById.get(id)?.statement ?? `(missing: ${id})`,
  }));
  const back = backlinks.hypotheses[h.hypothesis_id] ?? [];
  return [
    `<article class="hyp hyp--${escapeAttr(h.confidence.level)}" id="${escapeAttr(h.hypothesis_id)}">`,
    '<div class="card-head">',
    `<span class="badge badge--conf-${escapeAttr(h.confidence.level)}">${escapeHtml(h.confidence.level)}</span>`,
    `<span class="title">Hypothesis <code>${escapeHtml(h.hypothesis_id)}</code></span>`,
    '</div>',
    `<p class="statement">${escapeHtml(h.statement)}</p>`,
    `<p><em>Rationale:</em> ${escapeHtml(h.confidence.rationale)}</p>`,
    renderCitationList('Supporting facts', support),
    counter.length > 0 ? renderCitationList('Counter-evidence facts', counter) : '',
    renderBacklinks(back),
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------- facts ----------------

function factsSection(reasoning: ReasoningOutput, backlinks: Backlinks): string {
  const parts = [sectionOpen('facts', 'Observed Facts')];
  if (reasoning.facts.length === 0) {
    parts.push('<p class="note">(none)</p>');
    return parts.join('\n');
  }
  for (const f of reasoning.facts) {
    const back = backlinks.facts[f.fact_id] ?? [];
    parts.push(renderFactCard(f, back));
  }
  return parts.join('\n');
}

function renderFactCard(f: Fact, back: ReadonlyArray<BacklinkEntry>): string {
  const chips = f.evidence_ids
    .map((id) => `<span class="evidence-chip">${escapeHtml(id)}</span>`)
    .join('');
  return [
    `<article class="fact" id="${escapeAttr(f.fact_id)}">`,
    '<div class="card-head">',
    `<span class="title">Fact <code>${escapeHtml(f.fact_id)}</code></span>`,
    '</div>',
    `<p class="statement">${escapeHtml(f.statement)}</p>`,
    `<div><strong>Evidence:</strong><div class="evidence-chips">${chips}</div></div>`,
    renderBacklinks(back),
    '</article>',
  ].join('\n');
}

// ---------------- DQ sections ----------------

function retrievalStageDqSection(
  analyticalFindings: readonly DataQualityFinding[],
  cleanupFindings: readonly DataQualityFinding[],
  reasoning: ReasoningOutput,
): string {
  if (analyticalFindings.length === 0 && cleanupFindings.length === 0) return '';
  const reasonerCategories = new Set(reasoning.data_quality.map((d) => d.category));
  const parts = [sectionOpen('dq-retrieval', 'Data Quality — Retrieval Stage')];
  for (const d of analyticalFindings) {
    const dropped = !reasonerCategories.has(d.category);
    parts.push(renderAnalyticalDqCard(d, dropped));
  }
  if (cleanupFindings.length > 0) {
    parts.push(
      '<details class="cleanup-group">',
      `<summary>Post-process cleanup (${cleanupFindings.length} finding(s))</summary>`,
      ...cleanupFindings.map((d) =>
        renderAnalyticalDqCard(d, !reasonerCategories.has(d.category)),
      ),
      '</details>',
    );
  }
  return parts.join('\n');
}

function dataQualitySection(reasoning: ReasoningOutput): string {
  const parts = [sectionOpen('dq', 'Data Quality')];
  if (reasoning.data_quality.length === 0) {
    parts.push('<p class="note">(none)</p>');
    return parts.join('\n');
  }
  for (const d of reasoning.data_quality) {
    parts.push(renderAnalyticalDqCard(d, false));
  }
  return parts.join('\n');
}

function renderAnalyticalDqCard(d: DataQualityFinding, dropped: boolean): string {
  const droppedBadge = dropped
    ? '<span class="badge badge--dropped">dropped by reasoner</span>'
    : '';
  return [
    `<article class="dq${dropped ? ' dropped' : ''}" id="${escapeAttr(d.dq_id)}">`,
    '<div class="card-head">',
    `<span class="title">Data Quality finding ${escapeHtml(d.dq_id)} — ${escapeHtml(d.category)}</span>`,
    droppedBadge,
    '</div>',
    `<p class="statement">${escapeHtml(d.consequence_for_analysis)}</p>`,
    d.affected_capability
      ? `<p><strong>Affected capability:</strong> <code>${escapeHtml(d.affected_capability)}</code></p>`
      : '',
    d.actionable_hint
      ? `<p><strong>Actionable hint:</strong> ${escapeHtml(d.actionable_hint)}</p>`
      : '',
    d.impact_on_recommendations.length > 0
      ? `<p><strong>Weakens recommendations:</strong> ${d.impact_on_recommendations
          .map(
            (id) =>
              `<a class="citation" href="#${escapeAttr(id)}">Recommendation ${escapeHtml(id)}</a>`,
          )
          .join(', ')}</p>`
      : '',
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------- metadata footer ----------------

function metadataSection(metadata: RunMetadata): string {
  const items: Array<[string, string]> = [
    ['run_id', metadata.run_id],
    ['trace_id', metadata.trace_id],
    ['status', metadata.status],
    [
      'model',
      `${metadata.model_provider}/${metadata.model_name} (${metadata.model_deployment_sku ? `sku: ${metadata.model_deployment_sku}, ` : ''}config_hash: ${metadata.model_config_hash})`,
    ],
    [
      'prompts',
      `planner: ${metadata.prompt_versions.planner}, reasoner: ${metadata.prompt_versions.reasoner}`,
    ],
    [
      'credential',
      `${metadata.credential_source.implementation} (${metadata.credential_source.identity})`,
    ],
    [
      'capabilities',
      Object.entries(metadata.capability_versions)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ') || '(none)',
    ],
    ['fixture', metadata.fixture_id ?? '(live)'],
    ['started_at', metadata.started_at],
    ['ended_at', metadata.ended_at ?? '(in-progress)'],
  ];
  const rows = items
    .map(
      ([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`,
    )
    .join('');
  return [
    sectionOpen('metadata', 'Run Metadata'),
    `<div class="scope-grid">${rows}</div>`,
  ].join('\n');
}

// ---------------- TOC / layout ----------------

interface TocEntry {
  id: string;
  label: string;
  count?: number;
}

function pushToc(out: TocEntry[], id: string, label: string, count?: number): void {
  if (count === undefined) out.push({ id, label });
  else out.push({ id, label, count });
}

function renderToc(entries: TocEntry[]): string {
  return [
    '<aside class="toc" aria-label="Table of contents">',
    '<h2>Contents</h2>',
    '<ol>',
    ...entries.map(
      (e) =>
        `<li><a href="#${escapeAttr(e.id)}">${escapeHtml(e.label)}${e.count !== undefined ? ` <span class="count">${escapeHtml(String(e.count))}</span>` : ''}</a></li>`,
    ),
    '</ol>',
    '</aside>',
  ].join('\n');
}

function renderMobileToc(entries: TocEntry[]): string {
  return [
    '<details class="mobile-toc">',
    '<summary>Contents</summary>',
    '<ol>',
    ...entries.map(
      (e) =>
        `<li><a href="#${escapeAttr(e.id)}">${escapeHtml(e.label)}${e.count !== undefined ? ` (${escapeHtml(String(e.count))})` : ''}</a></li>`,
    ),
    '</ol>',
    '</details>',
  ].join('\n');
}

function sectionOpen(id: string, label: string): string {
  return `<h2 id="${escapeAttr(id)}">${escapeHtml(label)}</h2>`;
}

// ---------------- backlinks ----------------

interface BacklinkEntry {
  anchor: string;
  label: string;
}

interface Backlinks {
  facts: Record<string, BacklinkEntry[]>;
  hypotheses: Record<string, BacklinkEntry[]>;
}

function buildBacklinks(reasoning: ReasoningOutput): Backlinks {
  const out: Backlinks = { facts: {}, hypotheses: {} };
  for (const rec of reasoning.recommendations) {
    const entry: BacklinkEntry = {
      anchor: rec.recommendation_id,
      label: `Recommendation ${rec.recommendation_id}`,
    };
    for (const id of rec.supported_by_fact_ids) {
      (out.facts[id] ??= []).push(entry);
    }
    for (const id of rec.supported_by_hypothesis_ids) {
      (out.hypotheses[id] ??= []).push(entry);
    }
  }
  for (const hyp of reasoning.hypotheses) {
    const entry: BacklinkEntry = {
      anchor: hyp.hypothesis_id,
      label: `Hypothesis ${hyp.hypothesis_id}`,
    };
    for (const id of hyp.supported_by_fact_ids) {
      (out.facts[id] ??= []).push(entry);
    }
    for (const id of hyp.counter_evidence_fact_ids) {
      (out.facts[id] ??= []).push(entry);
    }
  }
  return out;
}

function renderBacklinks(back: ReadonlyArray<BacklinkEntry>): string {
  if (back.length === 0) return '';
  const links = back
    .map((b) => `<a href="#${escapeAttr(b.anchor)}">${escapeHtml(b.label)}</a>`)
    .join(', ');
  return `<div class="backlinks">Referenced by: ${links}</div>`;
}

// ---------------- escape helpers ----------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'/]/g, (ch) => HTML_ESCAPES[ch]!);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Renders one of the coverage strings produced by
 * {@link executiveCoverageLine}, honouring the `**bold**` segments the
 * markdown version uses (e.g. `**Coverage:** 1 of 3 …`). Everything
 * outside the bold markers is escaped as plain text — the helper never
 * interprets arbitrary HTML.
 */
function renderInlineMarkdown(s: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const next = s.indexOf('**', i);
    if (next === -1) {
      parts.push(escapeHtml(s.slice(i)));
      break;
    }
    if (next > i) parts.push(escapeHtml(s.slice(i, next)));
    const end = s.indexOf('**', next + 2);
    if (end === -1) {
      parts.push(escapeHtml(s.slice(next)));
      break;
    }
    parts.push(`<strong>${escapeHtml(s.slice(next + 2, end))}</strong>`);
    i = end + 2;
  }
  return parts.join('');
}
