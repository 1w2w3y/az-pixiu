import { parameterDigest } from '../mcp/digest.js';
import { classifyFailure, type ClassifiedFailure } from '../failure/taxonomy.js';
import type { MCPClient, DiscoveredCatalog } from '../mcp/client.js';
import type { EvidencePlan, EvidenceRequest, ToolCallResult } from '../schemas/index.js';
import {
  failureCategoryToOutcome,
  scopeSubsetFromParameters,
  type TransportSummaryEntry,
} from '../schemas/transport.js';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  isRetriableCategory,
  type RetryPolicy,
} from './retry-policy.js';

/**
 * Per-request retrieval result before normalization (§7.2 step 5).
 * Carries enough provenance for the normalizer (step 6) to build the
 * EvidenceRecord.
 */
export interface RawEvidence {
  request: EvidenceRequest;
  parameters_digest: string;
  capability_version: string;
  result: ToolCallResult;
  retrieved_at: string;
}

export interface ExecutionResult {
  raw_evidence: RawEvidence[];
  failures: ClassifiedFailure[];
  /**
   * One {@link TransportSummaryEntry} per logical evidence request, in
   * plan order. Single-attempt rows when nothing retried; recovered and
   * exhausted retries fill the same shape with attempt_count > 1 and
   * cumulative_backoff_ms > 0.
   */
  transport_summary: TransportSummaryEntry[];
}

/**
 * Per-attempt observability event emitted as retries happen. The
 * executor stays OTEL-naive — the orchestrator wires this callback to
 * the active evidence_retrieval span via emitEvent(). Tests can inject
 * a recorder to assert per-attempt detail without standing up a tracer.
 *
 *   - `retry_scheduled`: a transient failure was observed and a retry
 *     was scheduled. `backoff_ms` is the slept-or-to-be-slept delay
 *     before the next attempt; `failure_category` is the classified
 *     transient category. The terminal outcome is unknown at this point.
 *   - `pacing_applied`: a per-capability pacing sleep ran before the
 *     first attempt because an earlier call to the same capability had
 *     been rate-limited.
 */
export type ExecutorEvent =
  | {
      kind: 'retry_scheduled';
      logical_request_id: string;
      capability: string;
      attempt: number;
      failure_category: ClassifiedFailure['category'];
      backoff_ms: number;
    }
  | {
      kind: 'pacing_applied';
      logical_request_id: string;
      capability: string;
      pacing_ms: number;
    };

export interface EvidenceExecutorOptions {
  client: MCPClient;
  catalog: DiscoveredCatalog;
  /**
   * Now-supplier for retrieved_at timestamps. Defaults to () => new Date()
   * — overridable in tests for deterministic timestamps.
   */
  now?: () => Date;
  /**
   * Retry policy. Defaults to {@link DEFAULT_RETRY_POLICY}. Tests
   * override `maxAttempts`, `paceAfterRateLimitMs`, etc. to keep tests
   * fast and deterministic.
   */
  retryPolicy?: RetryPolicy;
  /**
   * Sleep injection point. Defaults to `setTimeout`-based. Tests pass a
   * recording no-op so the suite stays fast.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Jitter source returning a value in `[0, jitterMs)`. Defaults to
   * `Math.random() * policy.jitterMs`. Tests inject `() => 0` for
   * reproducible delays.
   */
  jitter?: (policy: RetryPolicy) => number;
  /**
   * Per-attempt observability sink. Called synchronously inside the
   * retry loop so events land on the active retrieval span. Optional;
   * unit tests pass a recorder, the orchestrator wires it to
   * emitEvent().
   */
  onEvent?: (event: ExecutorEvent) => void;
}

/**
 * The evidence executor (design §4.6, §7.2 step 5). Walks the
 * EvidencePlan, dispatching each request through the MCPClient and
 * classifying per-call failures via the failure_taxonomy. Failures are
 * collected, not thrown — analysis continues with bounded coverage (§11)
 * unless an unrecoverable error escapes (e.g., DiscoveryNotPerformedError,
 * which classifyFailure deliberately re-throws).
 *
 * Phase 3 §Gap 7: transient failures (rate_limit, timeout) retry with
 * exponential backoff + jitter. Recovered retries emit a normal raw
 * evidence record and NO DataQualityFinding — recommendation confidence
 * should not weaken when all evidence eventually arrived. Exhausted
 * retries follow the existing failure path (one ClassifiedFailure that
 * becomes a `rate_limit` / `timeout` DQ). Per-attempt detail surfaces in
 * the `transport_summary` substrate (§S4) and Langfuse trace events;
 * raw call parameters are never persisted.
 *
 * Back-pressure: when any rate_limit is observed on a capability,
 * subsequent calls to that same capability in the same run wait
 * `paceAfterRateLimitMs` before dispatching. The executor is already
 * sequential, so this is the practical realisation of "serialize per
 * subscription on 429" without introducing a queue.
 */
export class EvidenceExecutor {
  private readonly client: MCPClient;
  private readonly catalog: DiscoveredCatalog;
  private readonly now: () => Date;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: (policy: RetryPolicy) => number;
  private readonly onEvent: (event: ExecutorEvent) => void;

  constructor(options: EvidenceExecutorOptions) {
    this.client = options.client;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.jitter =
      options.jitter ??
      ((policy) => Math.random() * policy.jitterMs);
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async execute(plan: EvidencePlan): Promise<ExecutionResult> {
    const raw_evidence: RawEvidence[] = [];
    const failures: ClassifiedFailure[] = [];
    const transport_summary: TransportSummaryEntry[] = [];

    // Per-run scheduler state. rateLimitedCapabilities triggers the
    // inter-call pace; runBackoffSpentMs caps total cumulative retry
    // backoff; runPacingSpentMs caps total cumulative pacing sleeps.
    // The two budgets are tracked separately so a long retry tail on
    // one capability does not silently disable pacing on subsequent
    // calls (Codex should-fix #2).
    const rateLimitedCapabilities = new Set<string>();
    let runBackoffSpentMs = 0;
    let runPacingSpentMs = 0;

    for (let i = 0; i < plan.requests.length; i++) {
      const request = plan.requests[i]!;
      const parameters_digest = parameterDigest(request.parameters);
      const logical_request_id = `req-${i + 1}`;

      const wantPacing =
        rateLimitedCapabilities.has(request.capability) &&
        this.retryPolicy.paceAfterRateLimitMs > 0;
      let pacing = false;
      if (wantPacing) {
        // 0 totalPacingBudgetMs means "no aggregate cap" — pace every
        // eligible call as long as the per-call value is set.
        const pacingBudget = this.retryPolicy.totalPacingBudgetMs;
        const remaining =
          pacingBudget === 0
            ? this.retryPolicy.paceAfterRateLimitMs
            : Math.max(0, pacingBudget - runPacingSpentMs);
        const wait = Math.min(this.retryPolicy.paceAfterRateLimitMs, remaining);
        if (wait > 0) {
          await this.sleep(wait);
          runPacingSpentMs += wait;
          pacing = true;
          this.onEvent({
            kind: 'pacing_applied',
            logical_request_id,
            capability: request.capability,
            pacing_ms: wait,
          });
        }
      }

      let attempt = 0;
      let attemptBackoffMs = 0;
      let success: ToolCallResult | undefined;
      let lastFailure: ClassifiedFailure | undefined;
      let lastOutcomeBucket: TransportSummaryEntry['final_outcome'] = 'success';
      // Failure categories observed on attempts that did not return the
      // final outcome — populated as retries happen. On the recovered
      // path this is what keeps `rate_limit_seen` honest after
      // `lastFailure` is cleared (see schema/transport.ts).
      const observed_failure_categories: ClassifiedFailure['category'][] = [];

      while (attempt < this.retryPolicy.maxAttempts) {
        attempt += 1;
        try {
          success = await this.client.invoke(request.capability, request.parameters);
          lastFailure = undefined;
          break;
        } catch (err) {
          const failure = classifyFailure(err, { capability: request.capability });
          lastFailure = failure;
          lastOutcomeBucket = failureCategoryToOutcome(failure.category);
          observed_failure_categories.push(failure.category);
          if (failure.category === 'rate_limit') {
            rateLimitedCapabilities.add(request.capability);
          }
          const exhausted = attempt >= this.retryPolicy.maxAttempts;
          const retriable = isRetriableCategory(failure.category);
          if (!retriable || exhausted) break;

          const jitterMs = this.jitter(this.retryPolicy);
          const desiredBackoff = computeBackoffMs(
            attempt - 1,
            this.retryPolicy,
            jitterMs,
          );
          const remainingBudget = Math.max(
            0,
            this.retryPolicy.totalBudgetMs - runBackoffSpentMs - attemptBackoffMs,
          );
          if (remainingBudget <= 0) break;
          const actualBackoff = Math.min(desiredBackoff, remainingBudget);
          this.onEvent({
            kind: 'retry_scheduled',
            logical_request_id,
            capability: request.capability,
            attempt,
            failure_category: failure.category,
            backoff_ms: actualBackoff,
          });
          await this.sleep(actualBackoff);
          attemptBackoffMs += actualBackoff;
        }
      }

      runBackoffSpentMs += attemptBackoffMs;

      // Dedupe-preserving order: typically 1–3 distinct categories, so a
      // simple filter is cheaper than a Set+sort and the observed-order
      // is informative ("429 then 504 then success" vs "504 then 429
      // then success").
      const distinctObserved = observed_failure_categories.filter(
        (c, i, arr) => arr.indexOf(c) === i,
      );
      if (success !== undefined) {
        raw_evidence.push({
          request,
          parameters_digest,
          capability_version:
            this.catalog.capability_versions[request.capability] ?? 'unknown',
          result: success,
          retrieved_at: this.now().toISOString(),
        });
        transport_summary.push({
          logical_request_id,
          capability: request.capability,
          scope_subset: scopeSubsetFromParameters(request.parameters),
          parameters_digest,
          attempt_count: attempt,
          retry_count: attempt - 1,
          final_outcome: 'success',
          ...(distinctObserved.length > 0
            ? { observed_failure_categories: distinctObserved }
            : {}),
          pacing_applied: pacing,
          cumulative_backoff_ms: attemptBackoffMs,
        });
      } else if (lastFailure) {
        failures.push(lastFailure);
        // Pre-terminal categories distinct from the final failure are
        // included so an exhausted "504 → 504 → 429 → 429" still shows
        // that 504 was part of the path.
        const preTerminal = distinctObserved.filter((c) => c !== lastFailure.category);
        transport_summary.push({
          logical_request_id,
          capability: request.capability,
          scope_subset: scopeSubsetFromParameters(request.parameters),
          parameters_digest,
          attempt_count: attempt,
          retry_count: attempt - 1,
          final_outcome: lastOutcomeBucket,
          failure_category: lastFailure.category,
          ...(preTerminal.length > 0 ? { observed_failure_categories: preTerminal } : {}),
          pacing_applied: pacing,
          cumulative_backoff_ms: attemptBackoffMs,
        });
      }
    }

    return { raw_evidence, failures, transport_summary };
  }
}
