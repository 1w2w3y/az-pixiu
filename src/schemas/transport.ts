import type { FailureCategory } from '../failure/taxonomy.js';
import type { ScopeSubset } from './common.js';

/**
 * Transport summary substrate (Phase 3 — design/cron-comparison-improvements.md §S4).
 *
 * One {@link TransportSummaryEntry} per *logical* evidence request — the
 * shape is invariant whether the request succeeded on the first attempt
 * or needed retries. PR 1 emits single-attempt rows; PR 2 (§Gap 7 retry)
 * populates the same shape with real attempt/retry counts and backoff
 * totals. Per-attempt detail belongs in Langfuse trace events, not here:
 * `run.json` keeps the rollup so cross-run continuity can reason about
 * "this capability has been throttled in N of last M runs" without
 * bloating the artifact with raw attempt logs.
 *
 * Raw call parameters are never persisted — only the digest and an
 * optional minimal scope subset extracted from the request (e.g. the
 * subscription id the playbook fanned out to). This is what lets the
 * Executive Summary coverage helper (§S2) say "1 of 3 subscriptions
 * returned cost evidence" precisely.
 */
export interface TransportSummaryEntry {
  /**
   * Stable, run-scoped identifier for the logical request. Today this is
   * an ordinal in plan order; sufficient to correlate within a run.
   */
  logical_request_id: string;
  capability: string;
  /**
   * Minimal scope context extracted from the request (e.g. the single
   * subscription a cost-analysis fan-out call targeted). Carried so PR
   * 5's coverage helper can identify dropped subscriptions even when the
   * call never produced an evidence record. Null when the request is not
   * scope-fanned (e.g. a global resource-graph query).
   */
  scope_subset: ScopeSubset | null;
  parameters_digest: string;
  /** Total attempts made (1 + retries). PR 1 always emits 1. */
  attempt_count: number;
  /** Retries beyond the initial attempt. PR 1 always emits 0. */
  retry_count: number;
  final_outcome: TransportFinalOutcome;
  /** Failure category from the taxonomy, present iff final_outcome !== 'success'. */
  failure_category?: FailureCategory;
  /** Whether per-capability pacing was applied to this call (PR 2). */
  pacing_applied: boolean;
  /** Sum of backoff slept between retries. PR 1 always emits 0. */
  cumulative_backoff_ms: number;
}

export type TransportFinalOutcome =
  | 'success'
  | 'rate_limit'
  | 'timeout'
  | 'transport'
  | 'other';

/**
 * Compact transport-level rollup that the run-history store indexes for
 * cross-run continuity. Computed from {@link TransportSummaryEntry}[] at
 * `summarise()` time; old artifacts without transport summaries surface
 * as zeroed-out rollups so downstream readers can treat absence as
 * "nothing observed".
 */
export interface TransportRollup {
  total_calls: number;
  total_attempts: number;
  retry_count: number;
  recovered_count: number;
  exhausted_count: number;
  rate_limit_seen: boolean;
  cumulative_backoff_ms: number;
  by_capability: Record<string, TransportCapabilityRollup>;
}

export interface TransportCapabilityRollup {
  calls: number;
  attempts: number;
  retry_count: number;
  recovered_count: number;
  exhausted_count: number;
  rate_limit_seen: boolean;
  cumulative_backoff_ms: number;
}

/**
 * Map a {@link FailureCategory} to a {@link TransportFinalOutcome} bucket.
 * Outcomes are intentionally coarser than failure categories — PR 1's
 * consumers (history rollup, future Run Quality rendering) only need to
 * distinguish the retry-relevant cases.
 */
export function failureCategoryToOutcome(
  category: FailureCategory,
): TransportFinalOutcome {
  switch (category) {
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    case 'schema_mismatch':
      return 'transport';
    default:
      return 'other';
  }
}

const EMPTY_CAPABILITY_ROLLUP: TransportCapabilityRollup = {
  calls: 0,
  attempts: 0,
  retry_count: 0,
  recovered_count: 0,
  exhausted_count: 0,
  rate_limit_seen: false,
  cumulative_backoff_ms: 0,
};

/**
 * Reduce a list of per-request transport summary entries into a single
 * {@link TransportRollup}. Used both by the markdown renderer (Phase 2.5
 * §S3 Run Quality enrichment) and the history store's `summarise()` so
 * the rollup definition is identical in both surfaces.
 */
export function rollupTransportSummary(
  entries: readonly TransportSummaryEntry[],
): TransportRollup {
  const by_capability: Record<string, TransportCapabilityRollup> = {};
  let total_attempts = 0;
  let retry_count = 0;
  let recovered_count = 0;
  let exhausted_count = 0;
  let rate_limit_seen = false;
  let cumulative_backoff_ms = 0;

  for (const entry of entries) {
    total_attempts += entry.attempt_count;
    retry_count += entry.retry_count;
    cumulative_backoff_ms += entry.cumulative_backoff_ms;
    const recovered = entry.retry_count > 0 && entry.final_outcome === 'success';
    const exhausted = entry.final_outcome !== 'success';
    if (recovered) recovered_count += 1;
    if (exhausted) exhausted_count += 1;
    if (entry.final_outcome === 'rate_limit' || entry.failure_category === 'rate_limit') {
      rate_limit_seen = true;
    }

    const cap = by_capability[entry.capability] ?? { ...EMPTY_CAPABILITY_ROLLUP };
    cap.calls += 1;
    cap.attempts += entry.attempt_count;
    cap.retry_count += entry.retry_count;
    cap.cumulative_backoff_ms += entry.cumulative_backoff_ms;
    if (recovered) cap.recovered_count += 1;
    if (exhausted) cap.exhausted_count += 1;
    if (
      entry.final_outcome === 'rate_limit' ||
      entry.failure_category === 'rate_limit'
    ) {
      cap.rate_limit_seen = true;
    }
    by_capability[entry.capability] = cap;
  }

  return {
    total_calls: entries.length,
    total_attempts,
    retry_count,
    recovered_count,
    exhausted_count,
    rate_limit_seen,
    cumulative_backoff_ms,
    by_capability,
  };
}

/**
 * Extract a minimal {@link ScopeSubset} from request parameters. The
 * playbooks pass either `subscription_id: <id>` (per-sub fan-out) or
 * `subscription_ids: [<id>, ...]` (multi-sub queries); both are recognised
 * so PR 5's coverage helper can answer "which subscriptions did this call
 * cover?" without re-parsing parameters at render time.
 *
 * Returns null when no scope context is recoverable — the helper treats
 * `null` as "unknown coverage", not "no coverage".
 */
export function scopeSubsetFromParameters(
  parameters: Readonly<Record<string, unknown>>,
): ScopeSubset | null {
  const subIds: string[] = [];
  const single = parameters.subscription_id;
  if (typeof single === 'string' && single.length > 0) {
    subIds.push(single);
  }
  const multi = parameters.subscription_ids;
  if (Array.isArray(multi)) {
    for (const v of multi) {
      if (typeof v === 'string' && v.length > 0) subIds.push(v);
    }
  }
  if (subIds.length === 0) return null;
  return {
    subscription_ids: Array.from(new Set(subIds)),
    resource_group_names: null,
    resource_ids: null,
  };
}
