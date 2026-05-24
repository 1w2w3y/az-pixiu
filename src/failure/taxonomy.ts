import type { DataQualityCategory } from '../schemas/index.js';
import {
  CapabilityNotAllowedError,
  DiscoveryNotPerformedError,
} from '../mcp/client.js';
import { FixtureError, FixtureNotFoundError } from '../mcp/fixture.js';

/**
 * Failure taxonomy (design §4.4). Translates every raw MCP error into
 * one of eight stable failure classes (a subset of DataQualityCategory).
 *
 * Recognized categories at this layer:
 *   auth, authz_gap, unsupported_capability, invalid_scope, timeout,
 *   rate_limit, schema_mismatch, empty_result.
 *
 * The remaining DataQualityCategory values (stale_data, partial_coverage,
 * tagging_gap, missing_telemetry) come from the normalizer (§4.6 / step 5)
 * and the reasoner — they describe analytical quality, not call failures.
 */
export const FAILURE_CATEGORIES = [
  'auth',
  'authz_gap',
  'unsupported_capability',
  'invalid_scope',
  'timeout',
  'rate_limit',
  'schema_mismatch',
  'empty_result',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * A single failed call's classification — what category it belongs to,
 * which capability raised it, and operator-facing diagnostic text.
 *
 * Deliberately does NOT carry scope context (subscription ids,
 * resource group names). The cron-comparison-improvements convergence
 * note proposed adding scope to ClassifiedFailure so coverage detection
 * could attribute partial failures to specific subscriptions, but the
 * implementation took a different path: scope context is carried on
 * {@link import('../schemas/transport.js').TransportSummaryEntry.scope_subset}
 * instead. Two reasons:
 *
 *   1. The executor already extracts scope from the request parameters
 *      when it writes the TransportSummaryEntry — adding the same field
 *      to ClassifiedFailure would duplicate it.
 *   2. Scope is a property of the *call*, not the *classification* —
 *      the same FailureCategory can arise from a single-sub call or a
 *      multi-sub call, and ClassifiedFailure stays small and category-
 *      shaped this way.
 *
 * If a future analyzer needs scope alongside a failure (e.g. for a
 * recommendation tied to one subscription), it should join through
 * TransportSummaryEntry by capability + parameters_digest, not by
 * widening this type.
 */
export interface ClassifiedFailure {
  category: FailureCategory & DataQualityCategory;
  capability: string;
  message: string;
  actionable_hint?: string;
  /**
   * Where the failure was detected. `transport` is the default — an
   * exception thrown by `MCPClient.invoke()`, classified by HTTP status
   * or error message heuristics below. `payload-embedded` means the
   * call returned a 200-OK envelope but the per-capability inspector
   * in `src/evidence/payload-failure.ts` found a failure signal inside
   * the payload (e.g. `subscriptions[*].error = "rate limit (429) …"`
   * on `amgmcp_cost_analysis`). Carried so downstream surfaces can tell
   * "wire 429" apart from "embedded 429" without parsing messages.
   */
  source?: 'transport' | 'payload-embedded';
  cause?: unknown;
}

/**
 * Thrown by {@link import('../evidence/executor.js').EvidenceExecutor}
 * when the per-capability payload inspector detects a failure embedded
 * inside an otherwise-successful {@link
 * import('../schemas/index.js').ToolCallResult}. The exception carries
 * the already-classified failure so {@link classifyFailure} can
 * short-circuit and the retry / backoff substrate runs unchanged.
 * Lives in this module (rather than `evidence/payload-failure.ts`) so
 * the failure layer has no upward dependency on the evidence layer.
 */
export class EmbeddedPayloadFailure extends Error {
  public readonly failure: ClassifiedFailure;
  constructor(failure: ClassifiedFailure) {
    super(`Embedded ${failure.category} in ${failure.capability} payload: ${failure.message}`);
    this.name = 'EmbeddedPayloadFailure';
    this.failure = failure;
  }
}

export interface ClassificationContext {
  capability: string;
}

/**
 * Inspect an arbitrary error and return one of the eight failure classes.
 * Pattern of inspection (cheapest first):
 *   1. Specific exported error classes from mcp_client / fixture
 *   2. HTTP-style status codes attached as a property
 *   3. Substring match on the error message (defensive — covers errors
 *      from libraries that don't yet expose typed shapes)
 *   4. Default → schema_mismatch (treat as version drift; flagged for
 *      maintainer per design §11)
 */
export function classifyFailure(
  err: unknown,
  context: ClassificationContext,
): ClassifiedFailure {
  const capability = context.capability;

  // 0. Payload-embedded failures are already classified by the
  //    per-capability inspector — short-circuit so heuristics below
  //    don't re-run and the source/cause carried by the inspector are
  //    preserved verbatim through the retry path.
  if (err instanceof EmbeddedPayloadFailure) {
    return err.failure;
  }

  // 1. Specific error classes
  if (err instanceof CapabilityNotAllowedError) {
    return {
      category: 'unsupported_capability',
      capability,
      message: `Capability "${capability}" is not allowed: ${err.reason}`,
      actionable_hint: 'Either AMG-MCP does not advertise this capability or it falls outside the Phase 1 read-only allowlist (design §12).',
      cause: err,
    };
  }

  if (err instanceof FixtureNotFoundError) {
    return {
      category: 'unsupported_capability',
      capability,
      message: `No fixture recorded for ${capability} with the given parameters (digest ${err.parametersDigest.slice(0, 16)}…).`,
      actionable_hint: 'Record a new fixture or align the call parameters with an existing one.',
      cause: err,
    };
  }

  if (err instanceof FixtureError) {
    return {
      category: 'schema_mismatch',
      capability,
      message: `Fixture for ${capability} failed schema validation: ${err.message}`,
      actionable_hint: 'Re-record the fixture from a current AMG-MCP response.',
      cause: err,
    };
  }

  if (err instanceof DiscoveryNotPerformedError) {
    // Programming error, not a runtime failure-class. Re-throw so the
    // caller sees it instead of silently turning it into a DQ finding.
    throw err;
  }

  // 2. HTTP-style status codes (will matter once LiveMCPTransport lands)
  const statusCode = readStatusCode(err);
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401:
        return {
          category: 'auth',
          capability,
          message: `Authentication failed (401) calling ${capability}.`,
          actionable_hint: 'Run `az login` to refresh your Azure CLI token, then retry.',
          cause: err,
        };
      case 403:
        return {
          category: 'authz_gap',
          capability,
          message: `Authorization denied (403) calling ${capability}.`,
          actionable_hint: 'Ensure your identity holds a Grafana role on the AMG instance and Reader on the target scope.',
          cause: err,
        };
      case 404:
        return {
          category: 'unsupported_capability',
          capability,
          message: `Capability ${capability} reported 404 — likely not advertised by this AMG-MCP version.`,
          actionable_hint: 'Check the capability catalog at startup.',
          cause: err,
        };
      case 408:
      case 502:
      case 503:
      case 504:
        return {
          category: 'timeout',
          capability,
          message: `Request to ${capability} timed out (HTTP ${statusCode}).`,
          actionable_hint: 'Retry with a narrower scope or longer client timeout.',
          cause: err,
        };
      case 429:
        return {
          category: 'rate_limit',
          capability,
          message: `Rate-limited (429) calling ${capability}.`,
          actionable_hint: 'Back off and serialize calls per subscription; tighten the analysis scope if persistent.',
          cause: err,
        };
      case 400:
      case 422:
        return {
          category: 'invalid_scope',
          capability,
          message: `${capability} rejected the request as invalid (HTTP ${statusCode}).`,
          actionable_hint: 'Re-check the scope (subscription IDs, resource group names, time window).',
          cause: err,
        };
    }
  }

  // 3. Substring fallback for libraries that don't expose typed errors
  const message = errorMessage(err).toLowerCase();
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout') ||
    message.includes('aborted')
  ) {
    return {
      category: 'timeout',
      capability,
      message: `Network/timeout error calling ${capability}: ${errorMessage(err)}`,
      cause: err,
    };
  }
  if (message.includes('rate limit') || message.includes('throttle') || message.includes('429')) {
    return {
      category: 'rate_limit',
      capability,
      message: `Rate-limited calling ${capability}: ${errorMessage(err)}`,
      cause: err,
    };
  }
  if (message.includes('unauthorized') || message.includes('401')) {
    return {
      category: 'auth',
      capability,
      message: `Authentication error calling ${capability}: ${errorMessage(err)}`,
      cause: err,
    };
  }
  if (message.includes('forbidden') || message.includes('403') || message.includes('insufficient permissions')) {
    return {
      category: 'authz_gap',
      capability,
      message: `Authorization error calling ${capability}: ${errorMessage(err)}`,
      cause: err,
    };
  }
  if (message.includes('not found') || message.includes('unknown tool') || message.includes('unsupported')) {
    return {
      category: 'unsupported_capability',
      capability,
      message: `${capability} not supported by this AMG-MCP: ${errorMessage(err)}`,
      cause: err,
    };
  }
  if (message.includes('empty') && message.includes('result')) {
    return {
      category: 'empty_result',
      capability,
      message: `${capability} returned an empty result: ${errorMessage(err)}`,
      cause: err,
    };
  }

  // 4. Default: schema drift / unrecognized error
  return {
    category: 'schema_mismatch',
    capability,
    message: `Unclassified failure calling ${capability}: ${errorMessage(err)}`,
    actionable_hint: 'Inspect the raw error in the trace; capability version drift is likely.',
    cause: err,
  };
}

/**
 * Inspect a successful ToolCallResult and decide whether it should be
 * treated as empty_result. Called by the normalizer (step 5) so the same
 * category vocabulary covers both call-failures and content-failures.
 */
export function isEmptyResult(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === 'string' && content.length === 0) return true;
  if (Array.isArray(content) && content.length === 0) return true;
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    // Common shapes: { rows: [], count: 0 }, { data: [] }, { entries: [] }
    if (Object.keys(obj).length === 0) return true;
    if (Array.isArray(obj.rows) && obj.rows.length === 0) return true;
    if (Array.isArray(obj.data) && obj.data.length === 0) return true;
    if (Array.isArray(obj.entries) && obj.entries.length === 0) return true;
    if (typeof obj.count === 'number' && obj.count === 0) return true;
  }
  return false;
}

// --- helpers ---

function readStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const v of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v < 600) return v;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
