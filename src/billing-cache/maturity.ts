/**
 * Maturity policy for the local billing cache.
 *
 * Whether a billing period is safe to cache is computed relative to the
 * billing-period end, in UTC, with an injectable clock. Anchoring to a
 * fixed civil day-of-month is only correct when the period ends on the
 * last day of the month; expressing the rule as `period_end + offset`
 * keeps it correct and keeps two operators (or one travelling laptop)
 * from disagreeing about the cacheable gate. See the design's
 * "maturity types and the stabilization boundary" section.
 */

import type { CostView, MaturityDecision, MaturityPolicy } from './types.js';
import { DEFAULT_MATURITY_POLICY } from './types.js';
import { isValidMonth } from './cache-key.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BillingPeriod {
  /** ISO UTC, inclusive first instant of the period. */
  start: string;
  /** ISO UTC, exclusive — the first instant of the following period. */
  end: string;
}

function parseMonth(month: string): { year: number; monthIndex: number } {
  if (!isValidMonth(month)) {
    throw new Error(`invalid month "${month}" (expected YYYY-MM)`);
  }
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  // Guard the Date.UTC century-aliasing trap: a year of 0-99 (e.g. "0050")
  // would be silently mapped to 1900-1999, desyncing the billing period
  // from the cache key. No real billing month predates year 1000.
  if (!Number.isInteger(year) || year < 1000) {
    throw new Error(`implausible cache year in "${month}"`);
  }
  return { year, monthIndex: Number(monthStr) };
}

/** Calendar-month billing period (UTC) for the given YYYY-MM. */
export function monthBillingPeriod(month: string): BillingPeriod {
  const { year, monthIndex } = parseMonth(month);
  // monthIndex is 1-based; Date.UTC takes a 0-based month.
  const startMs = Date.UTC(year, monthIndex - 1, 1);
  const endMs = Date.UTC(year, monthIndex, 1);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export interface MaturityInput {
  month: string; // YYYY-MM
  costView: CostView;
  policy?: MaturityPolicy;
  /** Injected clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
}

export function evaluateMaturity(input: MaturityInput): MaturityDecision {
  const policy = input.policy ?? DEFAULT_MATURITY_POLICY;
  const now = (input.now ?? Date.now)();
  const { year, monthIndex } = parseMonth(input.month);

  // First instant of the following month, UTC — the billing-period end.
  const periodEndMs = Date.UTC(year, monthIndex, 1);
  const stableBoundaryMs = periodEndMs + policy.stabilizationOffsetDays * DAY_MS;
  const horizonMs = Date.UTC(year, monthIndex + policy.invoiceCloseHorizonMonths, 1);

  const cacheable = now >= stableBoundaryMs;
  return {
    status: cacheable ? 'usage_stable' : 'not_mature',
    cost_view: input.costView,
    became_cacheable_on: new Date(stableBoundaryMs).toISOString().slice(0, 10),
    late_adjustment_possible: now < horizonMs,
    cacheable,
  };
}
