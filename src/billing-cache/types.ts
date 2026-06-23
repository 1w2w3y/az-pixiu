/**
 * In-memory value types and constants for the local billing cache
 * (docs/design/local-billing-cache.md). The schema-validated, on-disk
 * shapes live in ./schema.ts; this leaf module holds the lightweight
 * types the maturity policy, cache-key derivation, file store, and (in a
 * later sequencing step) the cost-evidence provider pass around.
 *
 * The string unions here mirror the zod enums in ./schema.ts on purpose —
 * keep them in sync. They are duplicated rather than inferred so this file
 * stays a dependency-free leaf that ./cache-key.ts and ./maturity.ts can
 * import without pulling in the full record schema.
 */

export type CostView = 'actual' | 'amortized';
export type CurrencyMode = 'billing' | 'normalized_usd';
export type Granularity = 'Daily';

/**
 * Maturity of a cached billing period. `not_mature` is never written;
 * `usage_stable` is the normal cacheable state ("most first-party usage
 * charges have stopped accruing"); `finalized` is reserved for an
 * invoice-backed signal the first implementation does not yet source.
 */
export type MaturityStatus = 'not_mature' | 'usage_stable' | 'finalized';

/**
 * Billing-account agreement type. The cache only treats accounts whose
 * billing period equals a calendar month (EA / MCA first-party usage) as
 * cacheable; CSP / New Commerce and shifted-cycle accounts are detected
 * and skipped rather than mis-cached.
 */
export type BillingAccountType = 'EA' | 'MCA' | 'MOSP' | 'CSP' | 'unknown';

/**
 * The synthetic `source_capability` a cache-served EvidenceRecord will
 * carry once the cost-evidence provider lands (sequencing steps 5-6),
 * alongside `az_pixiu_waste_lane` and `az_pixiu_run_history`. Defined
 * here so the magic string has a single home.
 */
export const BILLING_CACHE_SOURCE_CAPABILITY = 'az_pixiu_billing_cache';

export interface MaturityPolicy {
  /** Days after billing_period_end before a period is usage-stable. */
  stabilizationOffsetDays: number;
  /** Months after period end during which late adjustments may still post. */
  invoiceCloseHorizonMonths: number;
}

export const DEFAULT_MATURITY_POLICY: MaturityPolicy = {
  stabilizationOffsetDays: 5,
  invoiceCloseHorizonMonths: 2,
};

export interface MaturityDecision {
  status: MaturityStatus;
  cost_view: CostView;
  /** UTC date (YYYY-MM-DD) on which the period crosses the stabilization boundary. */
  became_cacheable_on: string;
  /** True while the period is younger than the invoice-close horizon. */
  late_adjustment_possible: boolean;
  /** Convenience flag: status is not 'not_mature'. */
  cacheable: boolean;
}

/**
 * The request parameters that, together with cost view and currency mode,
 * identify a single cached billing cell. Folded into a digest so the
 * on-disk filename stays short (see ./cache-key.ts).
 */
export interface CostRequestParams {
  granularity: Granularity;
  /** Scope kind the cost call was issued against (e.g. 'subscription'). */
  scope: string;
  /** Cost Management grouping dimensions requested (e.g. ['ServiceName']). */
  grouping?: readonly string[];
  /** Any additional filter applied to the underlying call. */
  filter?: unknown;
}

/**
 * Fully identifies one cached billing cell. The subscription, month, cost
 * view, and currency mode are explicit; granularity, scope, grouping, and
 * filter are collapsed into `parametersDigest`. See the design's "cache
 * cell identity" section.
 */
export interface CacheCellKey {
  subscriptionId: string;
  month: string; // YYYY-MM
  costView: CostView;
  currencyMode: CurrencyMode;
  /** 16-hex digest over the CostRequestParams (granularity, scope, grouping, filter). */
  parametersDigest: string;
}
