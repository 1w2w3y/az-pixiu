import type { FailureCategory } from '../failure/taxonomy.js';

/**
 * Retry policy for the evidence executor (Phase 3 — cron-comparison §Gap 7).
 *
 * Categorical, not status-coded: the retry oracle reads
 * {@link FailureCategory} from `classifyFailure()` instead of inspecting
 * raw HTTP status. This keeps the policy stable across transports (live
 * vs fixture) and against future taxonomy additions, and means the
 * executor never needs to know what an MCP error wire-shape looks like.
 *
 * Numbers are anchored to the reference cron's empirical recovery times
 * (60–180s observed, ~7 min worst-case cumulative backoff in Run 6):
 *   - 30s base, doubling each retry, capped at 180s, plus jitter in [0, 30s).
 *   - 3 retries max (so 4 attempts) per logical request.
 *   - 540s total per-run budget — guarantees the worst case still
 *     finishes inside 10 minutes even when every cost call gets
 *     throttled three times.
 */
export interface RetryPolicy {
  /** Max attempts including the initial. Default 4 (1 + 3 retries). */
  maxAttempts: number;
  /** Base delay for the first retry (before jitter). Default 30s. */
  baseDelayMs: number;
  /** Cap on the (exponential + jitter) delay per attempt. Default 180s. */
  maxDelayMs: number;
  /** Width of the jitter window [0, jitterMs). Default 30s. */
  jitterMs: number;
  /**
   * Per-run cumulative *retry-backoff* ceiling. Counts only backoff
   * sleeps inside the retry loop; per-capability pacing sleeps are
   * tracked separately by {@link totalPacingBudgetMs}. Default 540s (9 min).
   */
  totalBudgetMs: number;
  /**
   * Inter-call pacing applied to subsequent calls of a capability after
   * the first observed rate_limit on that capability. Default 30s.
   * 0 disables pacing.
   */
  paceAfterRateLimitMs: number;
  /**
   * Per-run cumulative *pacing* ceiling. A run with many cost calls and
   * one early 429 can otherwise spend the whole runtime pacing. Defaults
   * to 5× the per-call pace (150s) — generous enough for ~5 paced calls
   * but tight enough that runaway pacing falls through to a no-pace
   * dispatch rather than blocking the run indefinitely. 0 disables the
   * pacing budget (pace every call as long as the per-call value is set).
   */
  totalPacingBudgetMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 30_000,
  maxDelayMs: 180_000,
  jitterMs: 30_000,
  totalBudgetMs: 540_000,
  paceAfterRateLimitMs: 30_000,
  totalPacingBudgetMs: 150_000,
};

/**
 * Retriable failure categories. Tight on purpose: only rate_limit and
 * timeout are safely retriable across the taxonomy as-is. (502/503 land
 * in `timeout` via the taxonomy's status-code branch — see
 * failure/taxonomy.ts.) Categories like auth, authz_gap, invalid_scope,
 * unsupported_capability, schema_mismatch, and empty_result describe
 * conditions retry cannot resolve.
 */
const RETRIABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'rate_limit',
  'timeout',
]);

export function isRetriableCategory(category: FailureCategory): boolean {
  return RETRIABLE_CATEGORIES.has(category);
}

/**
 * Backoff before the (retryIndex+1)-th retry — `retryIndex = 0` means
 * the delay between the first attempt and the first retry. Pure: jitter
 * is passed in (in [0, jitterMs)) so tests can supply 0 and assert
 * deterministic delays.
 *
 * The cap is applied to the full exponential + jitter sum, not just the
 * exponential portion, so operator-facing language ("retries are capped
 * at maxDelayMs per attempt") is literal at every retry index.
 */
export function computeBackoffMs(
  retryIndex: number,
  policy: RetryPolicy,
  jitter: number,
): number {
  const exp = policy.baseDelayMs * Math.pow(2, retryIndex);
  const j = Math.max(0, Math.min(jitter, policy.jitterMs));
  return Math.min(exp + j, policy.maxDelayMs);
}
