import type { PricingRateSource } from './source.js';

/**
 * Calibrated weekly impact estimator (Phase 3 — design/cost-summary-depth.md
 * §Gap 3).
 *
 * Joins a candidate count to a {@link PricingRateSource} entry and
 * returns the impact as an *estimate range* with the rate source
 * identified, never as a point figure. Three rendering invariants from
 * the design:
 *
 *   1. Unknown SKU → {@link UnavailableEstimate}, never a silent zero.
 *      Lane totals exclude unavailable estimates; the report renders
 *      "rate unavailable for SKU X" so the limitation is visible.
 *   2. Range is symmetric ±{@link DEFAULT_RANGE_PERCENT} around the
 *      list-price point so the estimate honours the calibrated-uncertainty
 *      framing — reservations / discounts / consumption variability are
 *      not modelled, so a single number would overstate precision.
 *   3. The rendered output cites `source_url` and `captured_at` from the
 *      rate-card entry so reviewers can verify the rate independently.
 *
 * Pure function: no I/O, no clock dependency. Callers must have already
 * awaited {@link PricingRateSource}'s construction (e.g.
 * `await JsonFileRateSource.load(...)`).
 */

export const DEFAULT_RANGE_PERCENT = 0.10;

export interface AvailableEstimate {
  kind: 'available';
  low_usd: number;
  high_usd: number;
  /** Point value the range was derived from; useful for diagnostics. */
  point_usd: number;
  count: number;
  sku: string;
  region?: string;
  /** URL of the public Azure pricing page the rate came from. */
  source_url: string;
  /** ISO-ish date stamp from the rate card. */
  captured_at: string;
}

export interface UnavailableEstimate {
  kind: 'unavailable';
  reason: 'sku_not_in_rate_card';
  count: number;
  sku: string;
  region?: string;
}

export type EstimateResult = AvailableEstimate | UnavailableEstimate;

export interface EstimateWeeklyImpactOptions {
  count: number;
  sku: string;
  region?: string;
  rateSource: PricingRateSource;
  /**
   * Half-width of the range as a fraction of the point estimate.
   * Default 0.10 (±10%). Tests and future calibration work can widen
   * this when the rate-source uncertainty is known to be larger.
   */
  rangePercent?: number;
}

export function estimateWeeklyImpactRange(options: EstimateWeeklyImpactOptions): EstimateResult {
  if (!Number.isFinite(options.count) || options.count < 0) {
    throw new RangeError(`estimateWeeklyImpactRange: count must be a non-negative finite number, got ${options.count}`);
  }
  const entry = options.rateSource.lookup({
    sku: options.sku,
    ...(options.region !== undefined ? { region: options.region } : {}),
  });
  if (!entry) {
    return {
      kind: 'unavailable',
      reason: 'sku_not_in_rate_card',
      count: options.count,
      sku: options.sku,
      ...(options.region !== undefined ? { region: options.region } : {}),
    };
  }
  const point = entry.list_price_weekly_usd * options.count;
  const halfWidth = point * (options.rangePercent ?? DEFAULT_RANGE_PERCENT);
  return {
    kind: 'available',
    low_usd: round2(point - halfWidth),
    high_usd: round2(point + halfWidth),
    point_usd: round2(point),
    count: options.count,
    sku: options.sku,
    ...(options.region !== undefined ? { region: options.region } : {}),
    source_url: entry.source_url,
    captured_at: options.rateSource.capturedAt(),
  };
}

/**
 * Rolls a list of estimates into a lane total, summing only available
 * estimates and reporting separately how many candidates were excluded
 * for missing rates. Used by the report writer to render lane summaries
 * without misrepresenting unavailable rates as zero.
 */
export interface LaneTotal {
  low_usd: number;
  high_usd: number;
  point_usd: number;
  available_count: number;
  unavailable_count: number;
  /** Distinct (sku, region) pairs with no rate-card entry, for the footnote. */
  unavailable_skus: Array<{ sku: string; region?: string }>;
}

export function rollUpLaneTotal(estimates: readonly EstimateResult[]): LaneTotal {
  let low = 0;
  let high = 0;
  let point = 0;
  let availableCount = 0;
  const unavailable: Array<{ sku: string; region?: string }> = [];
  const seenUnavailable = new Set<string>();

  for (const e of estimates) {
    if (e.kind === 'available') {
      low += e.low_usd;
      high += e.high_usd;
      point += e.point_usd;
      availableCount += 1;
    } else {
      const key = `${e.sku}|${e.region ?? ''}`;
      if (!seenUnavailable.has(key)) {
        seenUnavailable.add(key);
        unavailable.push({ sku: e.sku, ...(e.region !== undefined ? { region: e.region } : {}) });
      }
    }
  }

  return {
    low_usd: round2(low),
    high_usd: round2(high),
    point_usd: round2(point),
    available_count: availableCount,
    unavailable_count: estimates.length - availableCount,
    unavailable_skus: unavailable,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
