/**
 * Cache-cell identity: digest derivation and the on-disk filename grammar.
 *
 * A subscription id and a calendar month do not uniquely identify a Cost
 * Management number — cost view, currency mode, granularity, scope, and
 * any filter all change the result. The discriminating dimensions that are
 * not already in the filename (granularity, scope, grouping, filter) are
 * folded into a stable digest so two differently-parameterized fetches
 * never collide on one file. See docs/design/local-billing-cache.md.
 */

import { createHash } from 'node:crypto';
import type {
  CacheCellKey,
  CostRequestParams,
  CostView,
  CurrencyMode,
} from './types.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CELL_FILE_RE =
  /^(\d{4}-(?:0[1-9]|1[0-2]))\.(actual|amortized)-(billing|normalized_usd)-([0-9a-f]{16})\.json$/;
// A subscription id becomes a path segment, so it must be path-safe: no
// separators and no `..` traversal. Real ids are GUIDs; the looser class
// also admits the friendly ids used in tests and fixtures.
const SAFE_SUBSCRIPTION_ID_RE = /^(?!.*\.\.)[A-Za-z0-9._-]+$/;

export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

export function isPathSafeSubscriptionId(subscriptionId: string): boolean {
  return SAFE_SUBSCRIPTION_ID_RE.test(subscriptionId);
}

/** sha256 of `input`, truncated to 16 hex chars — the project's digest idiom. */
export function digest16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Stable 16-hex digest over an arbitrary JSON-serializable value (object
 * keys sorted, `undefined` encoded distinctly). Used by the cost-evidence
 * provider to digest a cost call's discriminating parameters regardless of
 * the wire param shape (playbook snake_case vs live-planner camelCase).
 */
export function digestObject(value: unknown): string {
  return digest16(canonicalize(value));
}

/** Canonical JSON with sorted object keys so digests are order-independent. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  // Encode `undefined` distinctly. JSON.stringify would otherwise drop an
  // object property whose value is undefined and serialize an undefined
  // array slot as null, collapsing `{a:1,b:undefined}` with `{a:1}` and
  // `[1,undefined,2]` with `[1,null,2]` — breaking the collision-free
  // digest invariant for filters carrying undefined.
  if (value === undefined) return { __undef__: true };
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Digest over the request parameters that discriminate a cell beyond
 * (subscription, month, cost view, currency mode). Grouping order is
 * normalized so `['ServiceName','ResourceType']` and the reverse collide
 * intentionally — they describe the same query.
 */
export function computeParametersDigest(params: CostRequestParams): string {
  return digest16(
    canonicalize({
      granularity: params.granularity,
      scope: params.scope,
      grouping: params.grouping ? [...params.grouping].sort() : [],
      filter: params.filter ?? null,
    }),
  );
}

export function buildCacheCellKey(args: {
  subscriptionId: string;
  month: string;
  costView: CostView;
  currencyMode: CurrencyMode;
  params: CostRequestParams;
}): CacheCellKey {
  if (!isValidMonth(args.month)) {
    throw new Error(`invalid cache month "${args.month}" (expected YYYY-MM)`);
  }
  if (!isPathSafeSubscriptionId(args.subscriptionId)) {
    throw new Error(`unsafe subscription id "${args.subscriptionId}" for a cache path`);
  }
  return {
    subscriptionId: args.subscriptionId,
    month: args.month,
    costView: args.costView,
    currencyMode: args.currencyMode,
    parametersDigest: computeParametersDigest(args.params),
  };
}

/** `2026-05.amortized-normalized_usd-<digest>.json` */
export function cellFileName(key: CacheCellKey): string {
  return `${key.month}.${key.costView}-${key.currencyMode}-${key.parametersDigest}.json`;
}

export interface ParsedCellFileName {
  month: string;
  costView: CostView;
  currencyMode: CurrencyMode;
  parametersDigest: string;
}

/**
 * Parse a strict cell filename. Returns `undefined` for anything that
 * isn't an exact match — including stray `*.tmp-*` files — so a directory
 * scan never mistakes a temp or foreign file for a cached cell.
 */
export function parseCellFileName(name: string): ParsedCellFileName | undefined {
  const m = CELL_FILE_RE.exec(name);
  if (!m) return undefined;
  return {
    month: m[1] as string,
    costView: m[2] as CostView,
    currencyMode: m[3] as CurrencyMode,
    parametersDigest: m[4] as string,
  };
}
