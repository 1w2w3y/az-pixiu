import type {
  DataQualityFinding,
  EvidenceRecord,
  ScopeSubset,
} from '../schemas/index.js';

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

/**
 * Category included in the dedupe key so that, when the cross-subscription
 * `freshness_uniform_drop` heuristic lands (Phase 3 §Gap 4), a
 * partial-window finding and a uniform-drop finding from the same
 * capability and end timestamp don't collapse into one rendered finding.
 * Today's only category is `freshness_partial_window` — the test
 * `freshness.test.ts` captures the intent so when the second category
 * lands the dedupe semantics don't quietly regress.
 */
type FreshnessCategory = 'freshness_partial_window' | 'freshness_uniform_drop';

interface FreshnessGroup {
  category: FreshnessCategory;
  source_capability: string;
  time_window: EvidenceRecord['time_window'];
  scope_subsets: ScopeSubset[];
  representativeStart: string;
}

export function checkFreshness(
  evidence: readonly EvidenceRecord[],
  options: FreshnessCheckOptions = {},
): DataQualityFinding[] {
  const lagThresholdMs = options.lagThresholdMs ?? DEFAULT_LAG_THRESHOLD_MS;
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  let counter = options.startingCounter ?? 0;

  const costRecords = evidence.filter((e) => COST_CAPABILITIES.has(e.source_capability));

  // Group affected records by (category, source_capability, time_window.end)
  // so a fan-out call that produces N near-identical findings becomes one
  // (cron-comparison §S1). source_capability is part of the key so a
  // future analyzer producing freshness findings from a different
  // capability with the same end timestamp is not collapsed into this
  // bucket; category is part of the key so the Phase 3
  // `freshness_uniform_drop` heuristic will not collapse with
  // `freshness_partial_window` once it lands.
  const partialCategory: FreshnessCategory = 'freshness_partial_window';
  const groups = new Map<string, FreshnessGroup>();
  for (const record of costRecords) {
    const endMs = new Date(record.time_window.end).getTime();
    if (!Number.isFinite(endMs)) continue;
    const lagMs = nowMs - endMs;
    if (!(lagMs < 0 || lagMs < lagThresholdMs)) continue;
    const key = `${partialCategory}::${record.source_capability}::${record.time_window.end}`;
    const existing = groups.get(key);
    if (existing) {
      existing.scope_subsets.push(record.scope_subset);
    } else {
      groups.set(key, {
        category: partialCategory,
        source_capability: record.source_capability,
        time_window: record.time_window,
        scope_subsets: [record.scope_subset],
        representativeStart: record.time_window.start,
      });
    }
  }

  const findings: DataQualityFinding[] = [];
  for (const group of groups.values()) {
    counter += 1;
    findings.push({
      dq_id: `dq-freshness-${counter}`,
      category: group.category,
      affected_capability: group.source_capability,
      affected_scope_subset: mergeScopeSubsets(group.scope_subsets),
      consequence_for_analysis:
        `Cost-analysis window ${group.representativeStart} → ${group.time_window.end} ends within the cost-API's late-posting threshold (` +
        `${Math.round(lagThresholdMs / 3_600_000)}h). Totals from this window are expected to revise upward as billing catches up; ` +
        'hypotheses and recommendations that depend on absolute totals should be caveated.',
      impact_on_recommendations: [],
      actionable_hint:
        'Re-run the analysis after the lag window has elapsed, or treat the current totals as a lower bound.',
    });
  }
  return findings;
}

/**
 * Merge the affected scope subsets of every record contributing to a
 * deduplicated freshness finding. Subscription ids and resource ids are
 * unioned; resource group names are unioned. When no member carries a
 * given field, the merged field stays `null` so the renderer does not
 * fabricate coverage. When every member has the same field present, the
 * union still reflects honest coverage.
 */
function mergeScopeSubsets(subsets: readonly ScopeSubset[]): ScopeSubset {
  const subs = new Set<string>();
  const rgs = new Set<string>();
  const ids = new Set<string>();
  let sawSubs = false;
  let sawRgs = false;
  let sawIds = false;
  for (const s of subsets) {
    if (s.subscription_ids && s.subscription_ids.length > 0) {
      sawSubs = true;
      for (const v of s.subscription_ids) subs.add(v);
    }
    if (s.resource_group_names && s.resource_group_names.length > 0) {
      sawRgs = true;
      for (const v of s.resource_group_names) rgs.add(v);
    }
    if (s.resource_ids && s.resource_ids.length > 0) {
      sawIds = true;
      for (const v of s.resource_ids) ids.add(v);
    }
  }
  return {
    subscription_ids: sawSubs ? Array.from(subs) : null,
    resource_group_names: sawRgs ? Array.from(rgs) : null,
    resource_ids: sawIds ? Array.from(ids) : null,
  };
}
