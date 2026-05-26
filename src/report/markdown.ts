import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  Fact,
  Hypothesis,
  Recommendation,
  DataQualityFinding,
  TransportSummaryEntry,
} from '../schemas/index.js';
import { extractSubscriptions } from '../run/subscription-discovery.js';
import {
  rollupTransportSummary,
  type TransportCapabilityRollup,
  type TransportRollup,
} from '../schemas/transport.js';
import {
  computeCostCoverage,
  hasIncompleteCoverage,
  isFullCoverage,
  type CostCoverage,
} from './coverage.js';
import type { WasteLaneResult } from '../playbooks/waste-lanes/types.js';

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
  /**
   * Data-quality findings detected during retrieval (normalizer +
   * failure-taxonomy classifications), before the reasoner saw the
   * evidence. Surfaced separately from {@link reasoning}.data_quality so
   * the report shows what the agent observed even when the reasoner
   * silently dropped a finding. Optional; the section is omitted when
   * the array is empty or undefined.
   */
  inputDataQuality?: DataQualityFinding[];
  /**
   * Per-logical-request transport summary from the EvidenceExecutor
   * (Phase 3 — cron-comparison §S4). Used by the Run Quality section to
   * render recovered/exhausted throttle lines and the quantified clean
   * baseline. Optional so older call sites that have not yet been
   * threaded continue to compile.
   */
  transportSummary?: TransportSummaryEntry[];
  /**
   * Per-lane waste-detection results (Phase 3 — design/cost-summary-depth.md
   * §Gap 1). When supplied and non-empty, the report renders a "Waste
   * Candidates" section between Data Quality and Recommendations: one
   * sub-block per lane listing each candidate by resource id with the
   * lane's classification predicate cited as the lane's defense.
   * Lane-level rate-card provenance (source_url + captured_at) is
   * footnoted so reviewers can audit the impact estimates.
   */
  wasteLanes?: WasteLaneResult[];
}

export function renderMarkdownReport(input: RenderReportInput): string {
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
  // Waste Candidates renders directly above Recommendations so the
  // operator sees the deterministic per-resource enumeration (the
  // evidence the reasoner cites) immediately before the
  // recommendation framing the reasoner derives from it. The existing
  // Data Quality sections remain after Recommendations / Hypotheses /
  // Facts — their position predates this PR and is preserved.
  const sections = [
    title(scope),
    scopeAndDataSources(scope, evidence, metadata),
    runQualitySection(inputDataQuality, rollup, coverage),
    costSummaryOverview(scope, evidence),
    executiveSummary(reasoning, inputDataQuality, coverage),
    wasteCandidatesSection(wasteLanes),
    recommendationsSection(reasoning),
    hypothesesSection(reasoning),
    factsSection(reasoning),
    retrievalStageDataQualitySection(inputDataQuality, reasoning),
    dataQualitySection(reasoning),
    metadataFooter(metadata),
  ].filter((section) => section.length > 0);
  return sections.join('\n\n').trimEnd() + '\n';
}

/**
 * Run Quality (Phase 2.5 — design/cost-summary-depth.md §Gap 6).
 *
 * Surfaces transport- and protocol-level findings as a first-class
 * report section between Scope & Data Sources and the analytical
 * content, so the operator reading the report sees the operational
 * health of the run before the conclusions that depend on it.
 *
 * This is distinct from the existing "Data Quality" sections, which
 * describe analytical coverage gaps (missing telemetry, tagging gaps,
 * partial coverage) the reasoner is asked to caveat its conclusions
 * with. Run Quality is about how the retrieval pass went, not about
 * what the resulting data does or does not cover.
 *
 * Phase 2.5 promotes a fixed set of categories: rate-limit and timeout
 * (transport-level), auth and authz_gap (call was made but rejected),
 * schema_mismatch (capability returned an unparseable shape),
 * unsupported_capability (planner asked for something the catalog does
 * not offer), and stale_data (closest current proxy for the Phase 3
 * freshness findings designed in §Gap 4). When none of these fire, a
 * one-line "no issues observed" rendering makes the section's silence
 * legible — the reference cron workflow's "0 throttles, all queries
 * returned valid data" footer is the design referent.
 */
const RUN_QUALITY_CATEGORIES: ReadonlySet<DataQualityFinding['category']> = new Set<
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
]);

function runQualitySection(
  inputDataQuality: readonly DataQualityFinding[],
  rollup: TransportRollup,
  coverage: CostCoverage,
): string {
  const findings = inputDataQuality.filter((d) => RUN_QUALITY_CATEGORIES.has(d.category));
  const freshnessCount = inputDataQuality.filter(
    (d) => d.category === 'freshness_partial_window' || d.category === 'freshness_uniform_drop',
  ).length;
  const lines: string[] = ['## Run Quality', ''];

  // Quantified baseline (Phase 3 §S3): describes the *retrieval pass*,
  // not the analysis. The reference cron's footer ("0 throttles, all 8
  // queries succeeded") is the design referent.
  lines.push(runQualityBaselineLine(rollup, coverage, freshnessCount));

  // Per-capability throttle rendering: surfaces recovered retries even
  // when no DQ finding exists (recovered throttles are not DQs by
  // design — see PR 2 commit message).
  const capabilityLines = recoveredCapabilityLines(rollup);
  if (capabilityLines.length > 0) {
    lines.push('');
    lines.push(...capabilityLines);
  }

  if (findings.length > 0) {
    const blocks = findings.map(renderRunQualityFinding);
    lines.push('', blocks.join('\n\n'));
  }

  return lines.join('\n');
}

function runQualityBaselineLine(
  rollup: TransportRollup,
  coverage: CostCoverage,
  freshnessCount: number,
): string {
  const transportErrors = rollup.exhausted_count;
  const retries = rollup.retry_count;
  const total = rollup.total_calls;
  const callCountClause = `${transportErrors} transport error(s), ${retries} retry attempt(s), ${freshnessCount} freshness finding(s) across ${total} evidence request(s)`;
  let coverageClause: string;
  if (!coverage.derivable) {
    coverageClause = 'cost-scope coverage not derivable from evidence metadata';
  } else if (isFullCoverage(coverage)) {
    coverageClause = `full cost-scope coverage (${coverage.covered_ids.length} of ${coverage.expected_ids.length} subscription(s) returned cost evidence)`;
  } else {
    const covered = coverage.covered_ids.length;
    const expected = coverage.expected_ids.length;
    coverageClause = `partial cost-scope coverage (${covered} of ${expected} subscription(s) returned cost evidence)`;
  }
  return `${callCountClause}; ${coverageClause}.`;
}

function recoveredCapabilityLines(rollup: TransportRollup): string[] {
  const entries: Array<[string, TransportCapabilityRollup]> = Object.entries(
    rollup.by_capability,
  ).sort((a, b) => a[0].localeCompare(b[0]));
  const lines: string[] = [];
  for (const [name, c] of entries) {
    if (c.retry_count === 0 && !c.rate_limit_seen) continue;
    const backoffSeconds = Math.round(c.cumulative_backoff_ms / 1000);
    const outcome = (() => {
      if (c.exhausted_count === 0) return 'all attempts ultimately succeeded';
      if (c.recovered_count === 0) return 'all retries exhausted';
      return `${c.recovered_count} recovered, ${c.exhausted_count} exhausted`;
    })();
    lines.push(
      `- **${name}:** ${c.retry_count} retry attempt(s), ${backoffSeconds}s cumulative backoff, ${outcome}.`,
    );
  }
  return lines;
}

function renderRunQualityFinding(d: DataQualityFinding): string {
  return [
    `### ${d.dq_id} — ${d.category}`,
    '',
    d.consequence_for_analysis,
    ...(d.affected_capability ? [`**Affected capability:** ${d.affected_capability}`] : []),
    ...(d.actionable_hint ? [`**Actionable hint:** ${d.actionable_hint}`] : []),
  ].join('\n');
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

function executiveSummary(
  reasoning: ReasoningOutput,
  inputDataQuality: readonly DataQualityFinding[],
  coverage: CostCoverage,
): string {
  const sorted = sortedRecommendations(reasoning.recommendations);
  const coverageLine = executiveCoverageLine(coverage, inputDataQuality);
  if (sorted.length === 0) {
    const baseLines = ['## Executive Summary', ''];
    if (coverageLine) baseLines.push(coverageLine, '');
    baseLines.push(
      'No recommendations were produced. Refer to the Data Quality section for the reasons coverage was bounded.',
    );
    return baseLines.join('\n');
  }
  const top = sorted[0]!;
  const dqLine = formatExecutiveDqLine(reasoning.data_quality, inputDataQuality);
  const lines: string[] = ['## Executive Summary', ''];
  if (coverageLine) lines.push(coverageLine, '');
  lines.push(
    `${sorted.length} recommendation(s) across this scope. The top-priority item is **${top.priority}/${top.confidence.level}**: ${top.statement}`,
    '',
    dqLine,
  );
  return lines.join('\n');
}

/**
 * Phase 3 §S2: deterministic coverage disclosure. The Executive Summary
 * surfaces incomplete cost-scope coverage as a first-class sentence so
 * an operator scanning the report header cannot miss that the analysis
 * was bounded. Renderer-owned, not prompt-owned — the reasoner gets a
 * scope-honesty rule in its prompt but the line itself is generated
 * here from scope + evidence + transport_summary.
 *
 * Returns null when coverage is fully complete or non-derivable with no
 * retrieval-stage failures — neither case needs disclosure.
 */
function executiveCoverageLine(
  coverage: CostCoverage,
  inputDataQuality: readonly DataQualityFinding[],
): string | null {
  if (!coverage.derivable) {
    // No subscription denominator. Surface generic incomplete-coverage
    // language only when retrieval-stage failure findings exist.
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

function formatExecutiveDqLine(
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
      `Data-quality concerns: ${Object.entries(byCategory).map(([k, v]) => `${k} (${v})`).join(', ')}.`,
    );
  }
  // Surface analytical categories the retrieval stage flagged but the
  // reasoner did not echo forward. Same-category matches are treated as
  // endorsed; new categories highlight that the reasoner silently dropped
  // them. Run-quality categories (transport / freshness) are not expected
  // to be echoed by the reasoner and are excluded here so they don't
  // appear as "dropped".
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
      `Retrieval-stage findings not echoed by the reasoner: ${droppedEntries.map(([k, v]) => `${k} (${v})`).join(', ')}.`,
    );
  }
  return parts.join(' ');
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

/**
 * Waste Candidates (Phase 3 — design/cost-summary-depth.md §Gap 1).
 *
 * Deterministic per-lane enumeration of waste-detection rows. The
 * reasoner is the only writer of recommendation framing in the report;
 * this section is the *cited evidence* that downstream recommendations
 * reference, rendered straight from the lane registry's structured
 * output rather than the LLM's voice. That separation honours the
 * design's "no autonomous remediation" rule — the lane code never
 * proposes deletion, it just enumerates what the predicate classified.
 *
 * Per-candidate line: `name (resource_id) — SKU X in region Y, alloc Z
 *   — ~$L–$H/week` or `(rate unavailable for SKU X)`. Lane footer
 * cites `predicate`, `rate_source captured_at`, and any unparsed-row
 * count so an operator can audit the lane's coverage.
 */
function wasteCandidatesSection(lanes: readonly WasteLaneResult[]): string {
  if (lanes.length === 0) return '';
  const lines: string[] = ['## Waste Candidates', ''];
  for (const lane of lanes) {
    lines.push(`### ${lane.title} (\`${lane.lane}\`)`);
    lines.push('');
    if (lane.failed) {
      lines.push(
        `_The lane's resource-graph call did not return data this run (transport failure or retries exhausted). No candidates enumerated; see Run Quality for details._`,
      );
      lines.push('');
      lines.push(`**Classification predicate:** \`${lane.predicate_text}\``);
      lines.push('');
      continue;
    }
    if (lane.candidates.length === 0) {
      lines.push(`_No matching resources in scope._`);
      lines.push('');
      lines.push(`**Classification predicate:** \`${lane.predicate_text}\``);
      lines.push('');
      continue;
    }
    for (const c of lane.candidates) {
      lines.push(renderWasteCandidateLine(c));
    }
    lines.push('');
    const total = lane.lane_total;
    const totalLine =
      total.available_count > 0
        ? `**Lane total (${total.available_count} priced candidate(s)):** ~$${total.low_usd.toFixed(2)}–$${total.high_usd.toFixed(2)}/week, list-price estimate.`
        : `**Lane total:** no priced candidates (every SKU was unavailable from the rate card).`;
    lines.push(totalLine);
    if (total.unavailable_count > 0) {
      const skus = total.unavailable_skus.map((s) => s.sku).join(', ');
      lines.push(
        `_${total.unavailable_count} candidate(s) excluded from the total — rate unavailable for SKU(s): ${skus}._`,
      );
    }
    lines.push('');
    lines.push(`**Classification predicate:** \`${lane.predicate_text}\``);
    lines.push(
      `**Rate source:** in-repo rate card captured ${lane.rate_source_captured_at}; list-price only — reservations, savings plans, hybrid benefit, and negotiated discounts are NOT modelled.`,
    );
    if (lane.unparsed_row_count > 0) {
      lines.push(
        `_${lane.unparsed_row_count} ARG row(s) were unparseable by this lane and excluded from the enumeration._`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderWasteCandidateLine(
  c: WasteLaneResult['candidates'][number],
): string {
  const id = c.candidate.resource_id;
  const sku = c.candidate.sku;
  const region = c.candidate.location || '(unknown)';
  const impact = c.estimated_weekly_impact;
  if (impact.kind === 'available') {
    return `- **${c.candidate.name}** (\`${id}\`) — SKU ${sku} in ${region} — ~$${impact.low_usd.toFixed(2)}–$${impact.high_usd.toFixed(2)}/week`;
  }
  return `- **${c.candidate.name}** (\`${id}\`) — SKU ${sku} in ${region} — _(rate unavailable for SKU ${sku})_`;
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

/**
 * Pre-reasoner data-quality findings: what the normalizer and failure
 * taxonomy detected during evidence retrieval. Surfaced separately from
 * the reasoner's endorsed findings so the report preserves provenance —
 * a category that was detected here but never appears under "## Data
 * Quality" was silently dropped by the reasoner.
 */
function retrievalStageDataQualitySection(
  inputDataQuality: readonly DataQualityFinding[],
  reasoning: ReasoningOutput,
): string {
  // Findings already rendered in the top-level Run Quality section
  // (transport / freshness) are not duplicated here; this section is for
  // analytical coverage gaps the reasoner is asked to caveat its
  // conclusions with.
  const analyticalFindings = inputDataQuality.filter((d) => !RUN_QUALITY_CATEGORIES.has(d.category));
  if (analyticalFindings.length === 0) return '';
  const reasonerCategories = new Set(reasoning.data_quality.map((d) => d.category));
  const blocks = analyticalFindings.map((d) => {
    const rendered = renderDataQuality(d);
    return reasonerCategories.has(d.category)
      ? rendered
      : `${rendered}\n_Status:_ not echoed by the reasoner.`;
  });
  return ['## Data Quality — Retrieval Stage', ...blocks].join('\n\n');
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

interface CostRow {
  date: string;
  serviceName: string;
  cost: number;
}

function parseCostAnalysisPayload(payload: unknown): ParsedCostPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;

  // Tabular shape (columns / rows / total) — what the cost-summary-001
  // synthetic fixture and the cost-surprise fixtures use.
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
  let totalCost = typeof totalObj?.cost === 'number' ? totalObj.cost : undefined;
  let currency: string | undefined =
    typeof totalObj?.currency === 'string'
      ? totalObj.currency
      : firstRowCurrency(rawRows, columnIndexes.currency);

  // Live AMG-MCP shape: { periodStart, periodEnd, subscriptions: [{
  // subscriptionId, totalCost, currency, byService[], byRegion[],
  // byResourceType[] }] }. No daily breakdown — the reasoner sees the
  // service / region / resource-type axes but not per-day costs. We
  // surface totals and service rollup here; dailyTotals stays empty so
  // the Peak/Lowest day block elides itself when only live-shape
  // payloads are present.
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

interface ParsedCostPayload {
  rows: CostRow[];
  totalCost?: number;
  currency?: string;
  liveServiceCosts?: Array<{ serviceName: string; cost: number }>;
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
