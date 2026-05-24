import { extractText, tryParseJson } from '../mcp/content.js';
import type { ClassifiedFailure } from '../failure/taxonomy.js';
import type { ToolCallResult } from '../schemas/index.js';

/**
 * Payload-failure inspector framework (design/embedded-rate-limit.md).
 *
 * Some AMG-MCP tools wrap upstream failures into a schema-valid 200-OK
 * payload — most notably `amgmcp_cost_analysis`, which encodes Cost
 * Management 429s as a per-subscription `error` string inside an
 * otherwise-empty `subscriptions[*]` row. None of the existing
 * detection paths fire on that shape (no exception → no
 * `classifyFailure()`; the envelope is not a text wrapped-error; the
 * payload is not empty; the normalizer's cost summarize branch ignores
 * `subscriptions[*].error`). The result is silent false success: the
 * deterministic pipeline records `final_outcome=success` for runs that
 * produced zero usable cost data.
 *
 * The inspector closes that hole at the same lifecycle point as
 * wire-level failure classification: between {@link import('../mcp/client.js').MCPClient.invoke}
 * returning a {@link ToolCallResult} and `raw_evidence.push()` in the
 * executor. Its output type matches the existing classifier
 * ({@link ClassifiedFailure}) so the retry substrate, backoff, pacing,
 * budget, `transport_summary` rollup, and Langfuse trace events are
 * reused unchanged.
 *
 * Per-capability conservative by design:
 *   - only registered capabilities are inspected (unknown capability →
 *     `undefined`, executor unchanged)
 *   - only well-known field paths are read (no free-text scan)
 *   - only well-known patterns produce known categories; unmatched
 *     errors on known field paths fall back to `schema_mismatch` so
 *     the operator gets a DQ finding rather than a silent zero
 *
 * TODO: remove once AMG-MCP surfaces upstream Cost Management 429s as
 * `isError: true` on the {@link ToolCallResult} or via a typed
 * structured-partial-failure field. Tracked under the PR 4 upstream
 * cleanup item in `docs/design/embedded-rate-limit.md`.
 */
export type PayloadInspector = (payload: unknown) => ClassifiedFailure | undefined;

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/i,
  /rate.?limit/i,
  /throttl/i,
];

const AUTH_PATTERNS: readonly RegExp[] = [/\bunauthor/i];

const AUTHZ_PATTERNS: readonly RegExp[] = [/forbidden|access denied/i];

/**
 * Inspect a successful `amgmcp_cost_analysis` payload for upstream
 * failures encoded as `subscriptions[*].error`. The live shape is
 * `{ subscriptions: [{ subscriptionId, totalCost, byService, byRegion,
 *   byResourceType, error? }, ...] }`. When `error` is present and
 * matches a known pattern, the corresponding category is returned;
 * priority order is `rate_limit` > `auth` > `authz_gap` >
 * `schema_mismatch`. When `error` is present but matches no pattern
 * and the data fields are empty (`totalCost === 0 && byService.length === 0`),
 * `schema_mismatch` is returned — "unknown payload-embedded error".
 * When no `subscriptions[*]` carries a non-empty `error`, returns
 * `undefined` (the payload is clean and the executor records success).
 *
 * Today's cost-summary playbook is per-subscription, so in practice
 * `subscriptions` has length 1. The multi-sub case is handled by
 * surfacing the first matching category — full partial-success
 * handling (per-sub split into retriable/permanent/success-subset) is
 * deliberately out of scope here per the design's Out-of-scope note.
 */
const costAnalysisInspector: PayloadInspector = (payload) => {
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as { subscriptions?: unknown };
  if (!Array.isArray(obj.subscriptions)) return undefined;

  let firstAuth: { sub: Record<string, unknown>; text: string } | undefined;
  let firstAuthz: { sub: Record<string, unknown>; text: string } | undefined;
  let firstUnclassified: { sub: Record<string, unknown>; text: string } | undefined;

  for (const sub of obj.subscriptions) {
    if (sub === null || typeof sub !== 'object') continue;
    const s = sub as Record<string, unknown>;
    const err = s.error;
    if (typeof err !== 'string' || err.length === 0) continue;

    if (RATE_LIMIT_PATTERNS.some((p) => p.test(err))) {
      return {
        category: 'rate_limit',
        capability: 'amgmcp_cost_analysis',
        message: err,
        actionable_hint:
          'Back off and retry; if persistent, narrow the analysis scope or stagger calls across subscriptions.',
        source: 'payload-embedded',
        cause: { subscriptionId: stringOrUndefined(s.subscriptionId) },
      };
    }
    if (!firstAuth && AUTH_PATTERNS.some((p) => p.test(err))) {
      firstAuth = { sub: s, text: err };
    } else if (!firstAuthz && AUTHZ_PATTERNS.some((p) => p.test(err))) {
      firstAuthz = { sub: s, text: err };
    } else if (!firstUnclassified && hasEmptyData(s)) {
      firstUnclassified = { sub: s, text: err };
    }
  }

  if (firstAuth) {
    return {
      category: 'auth',
      capability: 'amgmcp_cost_analysis',
      message: firstAuth.text,
      actionable_hint:
        'Re-authenticate (e.g. `az login`) and verify the Grafana Azure Monitor data source can authenticate to Azure on behalf of your identity.',
      source: 'payload-embedded',
      cause: { subscriptionId: stringOrUndefined(firstAuth.sub.subscriptionId) },
    };
  }
  if (firstAuthz) {
    return {
      category: 'authz_gap',
      capability: 'amgmcp_cost_analysis',
      message: firstAuthz.text,
      actionable_hint:
        'Ensure your identity (or the Grafana data source service principal) holds Reader on the target scope.',
      source: 'payload-embedded',
      cause: { subscriptionId: stringOrUndefined(firstAuthz.sub.subscriptionId) },
    };
  }
  if (firstUnclassified) {
    return {
      category: 'schema_mismatch',
      capability: 'amgmcp_cost_analysis',
      message: firstUnclassified.text,
      actionable_hint:
        'Unrecognised payload-embedded error — inspect the raw payload; AMG-MCP error wording may have drifted.',
      source: 'payload-embedded',
      cause: { subscriptionId: stringOrUndefined(firstUnclassified.sub.subscriptionId) },
    };
  }
  return undefined;
};

const INSPECTORS: Readonly<Record<string, PayloadInspector>> = {
  amgmcp_cost_analysis: costAnalysisInspector,
};

/**
 * Dispatch a payload to the per-capability inspector. Returns
 * `undefined` when no inspector is registered for `capability` (the
 * executor then behaves exactly as it does today) or when the
 * inspector finds no failure.
 */
export function inspectPayloadForFailure(
  capability: string,
  payload: unknown,
): ClassifiedFailure | undefined {
  const inspector = INSPECTORS[capability];
  if (!inspector) return undefined;
  return inspector(payload);
}

/**
 * Convenience: inspect a raw {@link ToolCallResult} (decoding the MCP
 * text-content envelope first). The executor uses this so the
 * inspector can match against the live AMG-MCP wire shape — `content`
 * is `[{type:"text", text:"<json>"}]` — and against the fixture shape
 * where `content` is the decoded object directly.
 */
export function inspectToolCallResultForFailure(
  capability: string,
  result: ToolCallResult,
): ClassifiedFailure | undefined {
  if (!(capability in INSPECTORS)) return undefined;
  const decoded = decodeForInspection(result);
  return inspectPayloadForFailure(capability, decoded);
}

function decodeForInspection(result: ToolCallResult): unknown {
  const text = extractText(result);
  const parsed = tryParseJson(text);
  if (parsed !== undefined) return parsed;
  return result.content;
}

function hasEmptyData(sub: Record<string, unknown>): boolean {
  const totalCost = sub.totalCost;
  const byService = sub.byService;
  const totalIsZero = typeof totalCost === 'number' && totalCost === 0;
  const byServiceEmpty = Array.isArray(byService) && byService.length === 0;
  return totalIsZero && byServiceEmpty;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
