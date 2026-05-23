import { z } from 'zod';

/**
 * Pricing rate source (Phase 3 — design/cost-summary-depth.md §Gap 3).
 *
 * Provides per-SKU list-price weekly rates so the impact calculator
 * can attach a *calibrated estimate range* to each waste candidate.
 * The interface is deliberately narrow — one lookup operation — so a
 * future implementation backed by the Azure Retail Prices API can be
 * swapped in without changing the calculator or its callers.
 *
 * Three guardrails the design commits to (and that callers must honour):
 *   - Estimates are list-price only. Reservations / savings plans /
 *     negotiated discounts / hybrid benefit are NOT modelled.
 *   - An unknown SKU returns `undefined`, never zero. Silent omission
 *     would distort lane totals; the calculator turns undefined into
 *     "rate unavailable" on the candidate.
 *   - The card is small and updateable; entries carry source_url and
 *     captured_at so an operator can verify or refresh them.
 */

export const RateCardEntrySchema = z
  .object({
    sku: z.string().min(1),
    /**
     * Optional region. When omitted the entry is a region-fallback —
     * used when no entry matches the queried (sku, region) pair on
     * region. Useful for SKUs with region-flat list pricing (e.g.
     * Standard public IPs).
     */
    region: z.string().min(1).optional(),
    list_price_weekly_usd: z.number().nonnegative(),
    /**
     * URL pointing to the Azure pricing page the rate was captured
     * from, so a reviewer can verify it. Required because every
     * estimate the calculator emits must cite its source.
     */
    source_url: z.string().url(),
    /**
     * Optional free-text note, e.g. the per-hour or per-month formula
     * the weekly figure was derived from.
     */
    notes: z.string().optional(),
  })
  .strict();

export const RateCardSchema = z
  .object({
    schema_version: z.literal('1'),
    captured_at: z.string().min(1),
    currency: z.literal('USD'),
    notes: z.array(z.string()).optional(),
    entries: z.array(RateCardEntrySchema),
  })
  .strict();

export type RateCardEntry = z.infer<typeof RateCardEntrySchema>;
export type RateCard = z.infer<typeof RateCardSchema>;

export interface PricingRateLookupOptions {
  sku: string;
  /**
   * Optional region — when supplied, an exact (sku, region) match is
   * preferred; if absent, falls back to a region-omitted entry for the
   * same SKU. When the caller omits region entirely, only region-omitted
   * entries are considered.
   */
  region?: string;
}

export interface PricingRateSource {
  /**
   * Returns the rate-card entry for the requested SKU (and optionally
   * region), or `undefined` when no entry matches. Implementations
   * must not invent rates; an unknown SKU is the calibrated-estimate
   * boundary, not an error.
   */
  lookup(options: PricingRateLookupOptions): RateCardEntry | undefined;
  /**
   * Capture date of the rate-card snapshot the source was built from.
   * Surfaced in the report footnote and the trace's `rate_source`
   * attribute so reviewers can see how fresh the estimates are.
   */
  capturedAt(): string;
}
