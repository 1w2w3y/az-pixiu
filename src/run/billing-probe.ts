import type { MCPClient } from '../mcp/client.js';
import { extractText, isWrappedError, classifyWrappedError, tryParseJson } from '../mcp/content.js';
import { inspectPayloadForFailure } from '../evidence/payload-failure.js';
import type { BillingProbeCache, ProbeOutcome } from './billing-probe-cache.js';

/**
 * Billing-access probe.
 *
 * Auto-discovery currently picks the top N subscriptions by ARG resource
 * count. ARG read access does not imply Cost Management read access, so
 * a sub that ranks high on resources can still return `RBACAccessDenied`
 * from `amgmcp_cost_analysis` mid-run and waste the rest of the
 * analysis. The probe issues the cheapest valid `amgmcp_cost_analysis`
 * call (1-day window, single sub, no grouping) against each candidate
 * before final selection. Subs that fail are excluded from auto-pick
 * and surfaced as data-quality findings with an actionable hint.
 *
 * Outcome classification reuses the existing helpers — `extractText`,
 * `isWrappedError`, `classifyWrappedError`, and `inspectPayloadForFailure`
 * — so the probe and the real cost-analysis call agree on what counts
 * as "denied" vs "transient".
 *
 * The probe is observability-only: its results never enter
 * `raw_evidence`, `transport_summary`, or the reasoner. The actual
 * cost-analysis call that *is* evidence runs unchanged in the normal
 * evidence pipeline.
 */

export interface ProbeOptions {
  /**
   * Per-probe timeout in milliseconds. Default 15000. Implemented via
   * AbortController; the underlying transport may not honour cancel —
   * in that case the Promise.race wrapper short-circuits the caller
   * while the doomed call drains in the background.
   */
  timeoutMs?: number;
  /** Max concurrent probes. Default 5, max 10. */
  concurrency?: number;
  /**
   * Optional cache. When set, the probe consults it before issuing a
   * call and writes the resulting outcome back through it.
   */
  cache?: BillingProbeCache;
  /** Override the clock for retry jitter. Defaults to Math.random. */
  random?: () => number;
  /**
   * Per-probe progress callback — fires once per subscription, after
   * the outcome is determined. Used by the orchestrator to land a
   * `probe.end` event on the SubscriptionDiscovery span.
   */
  onProbe?: (event: ProbeProgressEvent) => void;
}

export interface ProbeProgressEvent {
  subscription_id: string;
  outcome: ProbeOutcome;
  classification?: string;
  latency_ms: number;
  cache_hit: boolean;
}

export interface ProbeResult {
  subscription_id: string;
  outcome: ProbeOutcome;
  /** Short classification tag ("rbac_access_denied", "rate_limit", etc.). */
  classification?: string;
  /** Truncated upstream message — useful for DQ rendering. */
  message?: string;
  latency_ms: number;
  cache_hit: boolean;
}

export interface ProbeStats {
  cache_hits: number;
  cache_misses: number;
}

export interface ProbeRunResult {
  results: ProbeResult[];
  stats: ProbeStats;
}

/**
 * Probe each candidate subscription's billing-access. Returns a result
 * per candidate, in input order. Concurrency is capped via a small
 * worker pool so a long candidate list does not fan out beyond the
 * caller's budget.
 */
export async function probeBillingAccess(
  client: MCPClient,
  subscriptionIds: readonly string[],
  options: ProbeOptions = {},
): Promise<ProbeRunResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 5));
  const random = options.random ?? Math.random;

  const results = new Array<ProbeResult>(subscriptionIds.length);
  const stats: ProbeStats = { cache_hits: 0, cache_misses: 0 };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= subscriptionIds.length) return;
      const subId = subscriptionIds[index]!;
      const result = await probeOne(client, subId, { timeoutMs, random, ...(options.cache ? { cache: options.cache } : {}) });
      if (result.cache_hit) stats.cache_hits += 1;
      else stats.cache_misses += 1;
      results[index] = result;
      options.onProbe?.({
        subscription_id: result.subscription_id,
        outcome: result.outcome,
        ...(result.classification ? { classification: result.classification } : {}),
        latency_ms: result.latency_ms,
        cache_hit: result.cache_hit,
      });
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return { results, stats };
}

interface ProbeOneOptions {
  timeoutMs: number;
  random: () => number;
  cache?: BillingProbeCache;
}

async function probeOne(
  client: MCPClient,
  subscriptionId: string,
  options: ProbeOneOptions,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  if (options.cache) {
    const cached = await options.cache.get(subscriptionId);
    if (cached) {
      return {
        subscription_id: subscriptionId,
        outcome: cached.outcome,
        ...(cached.classification ? { classification: cached.classification } : {}),
        ...(cached.message ? { message: cached.message } : {}),
        latency_ms: Date.now() - startedAt,
        cache_hit: true,
      };
    }
  }

  const first = await singleProbeAttempt(client, subscriptionId, options.timeoutMs);
  let classified = classifyProbeOutcome(first);

  // Single inline retry for transient outcomes — small jitter
  // (50–250ms) so concurrent probes don't synchronise their retries.
  if (classified.outcome === 'transient') {
    const jitter = 50 + Math.floor(options.random() * 200);
    await delay(jitter);
    const second = await singleProbeAttempt(client, subscriptionId, options.timeoutMs);
    classified = classifyProbeOutcome(second);
  }

  const result: ProbeResult = {
    subscription_id: subscriptionId,
    outcome: classified.outcome,
    ...(classified.classification ? { classification: classified.classification } : {}),
    ...(classified.message ? { message: classified.message } : {}),
    latency_ms: Date.now() - startedAt,
    cache_hit: false,
  };

  if (options.cache) {
    await options.cache.set(subscriptionId, {
      outcome: result.outcome,
      ...(result.classification ? { classification: result.classification } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  }
  return result;
}

interface AttemptResult {
  ok: true;
  text: string;
  parsed: unknown;
}
interface AttemptError {
  ok: false;
  kind: 'timeout' | 'thrown';
  message: string;
}

async function singleProbeAttempt(
  client: MCPClient,
  subscriptionId: string,
  timeoutMs: number,
): Promise<AttemptResult | AttemptError> {
  // The probe deliberately uses the cheapest valid payload — 1-day
  // window, single subscription, no grouping or pagination. The shape
  // mirrors a normal cost-analysis call so an upstream that gates on
  // request shape (rather than scope) treats the probe identically.
  const params = {
    subscriptionId,
    startTime: 'now-1d',
    endTime: 'now',
  };
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const invocation = client.invoke('amgmcp_cost_analysis', params);
    const timeout = new Promise<AttemptError>((resolve) => {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, kind: 'timeout', message: `probe timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    const winner = await Promise.race([
      invocation.then(
        (result): AttemptResult | AttemptError => {
          if (settled) return { ok: false, kind: 'timeout', message: 'late' };
          settled = true;
          const text = extractText(result);
          const parsed = tryParseJson(text);
          return { ok: true, text, parsed };
        },
        (err): AttemptError => {
          if (settled) return { ok: false, kind: 'timeout', message: 'late' };
          settled = true;
          return { ok: false, kind: 'thrown', message: err instanceof Error ? err.message : String(err) };
        },
      ),
      timeout,
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ClassifiedProbe {
  outcome: ProbeOutcome;
  classification?: string;
  message?: string;
}

const DENIED_TOKENS = [
  'rbacaccessdenied',
  'forbidden',
  'authorizationfailed',
  'access denied',
  'insufficient',
] as const;
const UNAUTH_TOKENS = ['unauthorized', 'not authenticated', 'invalid_grant', '401'] as const;
const RATE_LIMIT_TOKENS = ['429', 'rate limit', 'throttle'] as const;
const TIMEOUT_TOKENS = ['timed out', 'timeout', 'etimedout', 'aborted', 'gateway', '502', '503', '504'] as const;

/**
 * Classify a probe attempt to one of the four outcomes. Order matters:
 *
 *   1. Exceptions or timeouts → `transient` (we'll retry once upstream).
 *   2. Wrapped errors (200-OK with error text) — use the existing
 *      `classifyWrappedError` to bucket auth/authz/schema, then
 *      decorate with `denied` vs `transient` depending on the bucket.
 *   3. Payload-embedded errors — defer to the cost-analysis inspector.
 *      Rate-limit / auth / authz embedded in the payload are mapped
 *      consistently with the real evidence pipeline.
 *   4. Clean payloads — `pass`. Empty 1-day spend is fine; the probe is
 *      about access, not about presence of cost.
 */
function classifyProbeOutcome(attempt: AttemptResult | AttemptError): ClassifiedProbe {
  if (!attempt.ok) {
    if (attempt.kind === 'timeout') {
      return { outcome: 'transient', classification: 'timeout', message: attempt.message };
    }
    const lower = attempt.message.toLowerCase();
    if (DENIED_TOKENS.some((t) => lower.includes(t))) {
      return { outcome: 'denied', classification: 'authz', message: attempt.message };
    }
    if (UNAUTH_TOKENS.some((t) => lower.includes(t))) {
      return { outcome: 'denied', classification: 'auth', message: attempt.message };
    }
    if (RATE_LIMIT_TOKENS.some((t) => lower.includes(t))) {
      return { outcome: 'transient', classification: 'rate_limit', message: attempt.message };
    }
    if (TIMEOUT_TOKENS.some((t) => lower.includes(t))) {
      return { outcome: 'transient', classification: 'timeout', message: attempt.message };
    }
    return { outcome: 'unknown', classification: 'unclassified_error', message: attempt.message };
  }

  const text = attempt.text;
  if (text.length > 0 && isWrappedError(text)) {
    const tag = classifyWrappedError(text);
    const lower = text.toLowerCase();
    // classifyWrappedError reports `authz_gap` for forbidden/access-denied,
    // `auth` for unauthorized/not-authenticated, `schema_mismatch` otherwise.
    // RBACAccessDenied is the canonical Cost Management denial wrapper;
    // catch it explicitly because Grafana's wrapped error text often
    // doesn't contain the bare word "forbidden".
    if (lower.includes('rbacaccessdenied') || lower.includes('authorizationfailed')) {
      return { outcome: 'denied', classification: 'rbac_access_denied', message: shortMessage(text) };
    }
    if (tag === 'authz_gap') {
      return { outcome: 'denied', classification: 'authz_gap', message: shortMessage(text) };
    }
    if (tag === 'auth') {
      return { outcome: 'denied', classification: 'auth', message: shortMessage(text) };
    }
    // schema_mismatch — could be a real schema drift, could be a transient
    // upstream. Conservative: treat as transient so a single eval doesn't
    // drop the sub on a parser hiccup; the inline retry will sort it out.
    if (RATE_LIMIT_TOKENS.some((t) => lower.includes(t))) {
      return { outcome: 'transient', classification: 'rate_limit', message: shortMessage(text) };
    }
    return { outcome: 'transient', classification: 'schema_mismatch', message: shortMessage(text) };
  }

  if (attempt.parsed !== undefined) {
    const embedded = inspectPayloadForFailure('amgmcp_cost_analysis', attempt.parsed);
    if (embedded) {
      if (embedded.category === 'auth') {
        return { outcome: 'denied', classification: 'auth', message: shortMessage(embedded.message) };
      }
      if (embedded.category === 'authz_gap') {
        return { outcome: 'denied', classification: 'authz_gap', message: shortMessage(embedded.message) };
      }
      if (embedded.category === 'rate_limit') {
        return { outcome: 'transient', classification: 'rate_limit', message: shortMessage(embedded.message) };
      }
      return { outcome: 'transient', classification: 'schema_mismatch', message: shortMessage(embedded.message) };
    }
  }

  // Clean response — either real data or a structurally valid empty
  // payload. Both mean "this subscription has billing read access".
  return { outcome: 'pass' };
}

function shortMessage(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 240 ? cleaned.slice(0, 237) + '…' : cleaned;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}
