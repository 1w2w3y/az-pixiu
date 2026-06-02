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
} from './shared.js';

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
  /**
   * One-line `**Run outcome:**` header for the Run Quality section
   * (DESIGN-NOTE.md §Bug A). The orchestrator computes this so the
   * report, run.json `metadata.status`, and the CLI stderr block all
   * tell the same story. Optional so existing test call sites that
   * construct `RenderReportInput` by hand continue to work without
   * threading the field through.
   */
  runOutcomeSummary?: {
    label: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    sentence: string;
  };
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
    runOutcomeSummary,
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
    runQualitySection(inputDataQuality, rollup, coverage, runOutcomeSummary),
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
 */

function runQualitySection(
  inputDataQuality: readonly DataQualityFinding[],
  rollup: TransportRollup,
  coverage: CostCoverage,
  runOutcomeSummary:
    | { label: 'SUCCESS' | 'PARTIAL' | 'FAILED'; sentence: string }
    | undefined,
): string {
  const findings = inputDataQuality.filter((d) => RUN_QUALITY_CATEGORIES.has(d.category));
  const freshnessCount = inputDataQuality.filter(
    (d) => d.category === 'freshness_partial_window' || d.category === 'freshness_uniform_drop',
  ).length;
  const lines: string[] = ['## Run Quality', ''];

  // Run outcome banner (DESIGN-NOTE.md §Bug A). Rendered as the very
  // first line of Run Quality so a reader skimming the report cannot
  // miss that retrieval failed even when nothing else made it
  // visually obvious (e.g. when the partial-success path still landed
  // a tagging recommendation but cost retrieval as a whole failed).
  if (runOutcomeSummary) {
    lines.push(
      `**Run outcome:** ${runOutcomeSummary.label} — ${runOutcomeSummary.sentence}`,
      '',
    );
  }

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
    `### Data Quality finding ${d.dq_id} — ${d.category}`,
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
      ...summary.topServices.map(
        (s) => `- ${expandServiceName(s.name)}: ${formatMoney(s.cost, summary.currency)}`,
      ),
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
  const expander = makeAbbrExpander();
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
      lines.push(renderWasteCandidateLine(c, expander));
    }
    lines.push('');
    const total = lane.lane_total;
    const totalLine =
      total.available_count > 0
        ? `**Lane total (${total.available_count} priced candidate(s)):** ~$${total.low_usd.toFixed(2)}–$${total.high_usd.toFixed(2)}/week, list-price estimate.`
        : `**Lane total:** no priced candidates (every ${expander.sku()} was unavailable from the rate card).`;
    lines.push(totalLine);
    if (total.unavailable_count > 0) {
      const skus = total.unavailable_skus.map((s) => s.sku).join(', ');
      lines.push(
        `_${total.unavailable_count} candidate(s) excluded from the total — rate unavailable for ${expander.sku()}(s): ${skus}._`,
      );
    }
    lines.push('');
    lines.push(`**Classification predicate:** \`${lane.predicate_text}\``);
    lines.push(
      `**Rate source:** in-repo rate card captured ${lane.rate_source_captured_at}; list-price only — reservations, savings plans, hybrid benefit, and negotiated discounts are NOT modelled.`,
    );
    if (lane.unparsed_row_count > 0) {
      lines.push(
        `_${lane.unparsed_row_count} ${expander.arg()} row(s) were unparseable by this lane and excluded from the enumeration._`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderWasteCandidateLine(
  c: WasteLaneResult['candidates'][number],
  expander: ReturnType<typeof makeAbbrExpander>,
): string {
  const id = c.candidate.resource_id;
  const sku = c.candidate.sku;
  const region = c.candidate.location || '(unknown)';
  const impact = c.estimated_weekly_impact;
  if (impact.kind === 'available') {
    return `- **${c.candidate.name}** (\`${id}\`) — ${expander.sku()} ${sku} in ${region} — ~$${impact.low_usd.toFixed(2)}–$${impact.high_usd.toFixed(2)}/week`;
  }
  return `- **${c.candidate.name}** (\`${id}\`) — ${expander.sku()} ${sku} in ${region} — _(rate unavailable for SKU ${sku})_`;
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
    `### Recommendation ${rec.recommendation_id} — ${rec.priority.toUpperCase()} / ${rec.confidence.level.toUpperCase()} (impact: ${rec.impact})`,
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
      citedHyps.map((h) => `Hypothesis ${h.hypothesis_id}: ${h.statement}`),
    ),
    section(
      'Cited facts',
      citedFacts.map((f) => `Fact ${f.fact_id}: ${f.statement}`),
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
      `### Hypothesis ${h.hypothesis_id} — confidence ${h.confidence.level}`,
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
    `### Fact ${f.fact_id}\n\n${f.statement}\n\n**Evidence:** ${f.evidence_ids.join(', ')}`,
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
    `### Data Quality finding ${d.dq_id} — ${d.category}`,
    '',
    d.consequence_for_analysis,
    ...(d.affected_capability ? [`**Affected capability:** ${d.affected_capability}`] : []),
    ...(d.actionable_hint ? [`**Actionable hint:** ${d.actionable_hint}`] : []),
    ...(d.impact_on_recommendations.length > 0
      ? [`**Weakens recommendations:** ${d.impact_on_recommendations.map((id) => `Recommendation ${id}`).join(', ')}`]
      : []),
  ].join('\n');
}

function metadataFooter(metadata: RunMetadata): string {
  const items: Record<string, string> = {
    run_id: metadata.run_id,
    trace_id: metadata.trace_id,
    status: metadata.status,
    model: `${metadata.model_provider}/${metadata.model_name} (${metadata.model_deployment_sku ? `sku: ${metadata.model_deployment_sku}, ` : ''}config_hash: ${metadata.model_config_hash})`,
    prompts: `planner: ${metadata.prompt_versions.planner}, reasoner: ${metadata.prompt_versions.reasoner}`,
    credential: `${metadata.credential_source.implementation} (${metadata.credential_source.identity})`,
    capabilities:
      Object.entries(metadata.capability_versions)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ') || '(none)',
    fixture: metadata.fixture_id ?? '(live)',
    started_at: metadata.started_at,
    ended_at: metadata.ended_at ?? '(in-progress)',
  };
  if (metadata.discovery_funnel) {
    const f = metadata.discovery_funnel;
    items['Discovery funnel'] =
      `Azure Resource Graph (ARG) ranked ${f.arg_ranked} subscription(s) → probed top ${f.probed} for billing access → ${f.passed} passed → selected top ${f.selected}` +
      (f.cache_hits + f.cache_misses > 0
        ? ` (cache: ${f.cache_hits} hit(s), ${f.cache_misses} miss(es))`
        : '');
  }
  return ['---', '', '## Run Metadata', '', bullets(items)].join('\n');
}

// ---------------- helpers ----------------

function bullets(items: Record<string, string>): string {
  return Object.entries(items)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');
}

function section(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return [`**${title}:**`, ...items.map((s) => `- ${s}`)].join('\n');
}
