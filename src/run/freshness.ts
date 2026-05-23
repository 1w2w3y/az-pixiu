import type { DataQualityFinding, EvidenceRecord } from '../schemas/index.js';

/**
 * Freshness check (Phase 3 — design/cost-summary-depth.md §Gap 4).
 *
 * Detects the most common cost-API freshness artefact: an analysis
 * `time_window.end` that falls within the API's known late-posting
 * window, so the totals returned are expected to revise upward over
 * the next 24–48h. When that's the case, hypotheses and recommendations
 * that depend on those totals should be caveated rather than acted on,
 * and the reasoner is shown a {@link DataQualityFinding} of category
 * `freshness_partial_window` so it has the cue.
 *
 * This first slice covers the partial-window heuristic only. The
 * cross-subscription uniform-drop heuristic (`freshness_uniform_drop`)
 * is reserved by name in the schema and will land with the broader
 * Phase 3 freshness work — that heuristic needs comparison data from a
 * baseline window (cost_surprise) or from prior runs (requires
 * extending RunSummary), neither of which is wired here yet.
 *
 * The default lag threshold is 48h, matching the design's stated
 * starting heuristic. It is configurable per call so tests and future
 * calibration work can override it without code change.
 *
 * Pure function: no side effects, no clock dependency unless `now` is
 * left to default. Tests should pass `now` explicitly.
 */

export interface FreshnessCheckOptions {
  /**
   * Lag threshold in milliseconds. Any cost-analysis evidence whose
   * `time_window.end` falls within this window of `now` produces a
   * `freshness_partial_window` finding. Default is 48h.
   */
  lagThresholdMs?: number;
  /**
   * Clock injection point. Defaults to `Date.now()`. Tests pass a fixed
   * value so the heuristic is reproducible.
   */
  now?: () => Date;
  /**
   * Starting counter for the synthesized DQ ids. The orchestrator
   * passes the size of the existing DQ list so freshness ids do not
   * collide with normalizer or failure-taxonomy ids.
   */
  startingCounter?: number;
}

const DEFAULT_LAG_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * Source capabilities whose evidence is interpreted as carrying
 * cost-API totals subject to posting lag. Kept narrow on purpose —
 * resource-graph or activity-log timestamps are not affected by the
 * cost-API's posting cadence and would produce false positives.
 */
const COST_CAPABILITIES: ReadonlySet<string> = new Set([
  'amgmcp_cost_analysis',
  'cost_analysis',
]);

export function checkFreshness(
  evidence: readonly EvidenceRecord[],
  options: FreshnessCheckOptions = {},
): DataQualityFinding[] {
  const lagThresholdMs = options.lagThresholdMs ?? DEFAULT_LAG_THRESHOLD_MS;
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  let counter = options.startingCounter ?? 0;

  const costRecords = evidence.filter((e) => COST_CAPABILITIES.has(e.source_capability));
  const findings: DataQualityFinding[] = [];

  for (const record of costRecords) {
    const endMs = new Date(record.time_window.end).getTime();
    if (!Number.isFinite(endMs)) continue;
    const lagMs = nowMs - endMs;
    // Within the lag window when the period ended recently (lag is
    // small) OR has not ended yet (lag is negative — window extends
    // into the future). Periods whose end is far in the past are
    // assumed fully posted and skipped.
    if (lagMs < 0 || lagMs < lagThresholdMs) {
      counter += 1;
      findings.push({
        dq_id: `dq-freshness-${counter}`,
        category: 'freshness_partial_window',
        affected_capability: record.source_capability,
        affected_scope_subset: record.scope_subset,
        consequence_for_analysis:
          `Cost-analysis window ${record.time_window.start} → ${record.time_window.end} ends within the cost-API's late-posting threshold (` +
          `${Math.round(lagThresholdMs / 3_600_000)}h). Totals from this window are expected to revise upward as billing catches up; ` +
          'hypotheses and recommendations that depend on absolute totals should be caveated.',
        impact_on_recommendations: [],
        actionable_hint:
          'Re-run the analysis after the lag window has elapsed, or treat the current totals as a lower bound.',
      });
    }
  }

  return findings;
}
