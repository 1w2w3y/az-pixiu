/**
 * On-disk shapes for the local billing cache: the per-cell record and the
 * rebuildable manifest index. Validated with zod so a corrupt or
 * unexpected file degrades to a cache miss plus a finding rather than
 * tearing a run (see the design's "corruption and version state machine").
 *
 * The record schema is intentionally non-strict: unknown object keys are
 * tolerated (not rejected) so an additive field written by a newer build
 * does not turn every older-shaped read into a re-warm storm. Note the
 * tolerated keys are *stripped* on parse, so a round-trip through an older
 * build drops them rather than preserving them; open `dimensions` record
 * keys survive, but unknown sub-fields of a known object do not. A
 * genuinely incompatible change bumps `schema_version`, which the store
 * checks before validation.
 */

import { z } from 'zod';

export const CACHE_SCHEMA_VERSION = 'billing-cache-v1';
export const MANIFEST_SCHEMA_VERSION = 'billing-cache-manifest-v1';

// Kept in lockstep with cache-key.ts: the digest must be exactly what the
// cell filename grammar can round-trip, and the subscription id becomes a
// path segment so it must be path-safe (no separators, no `..`). Without
// these the write path could persist an un-enumerable "ghost" cell or a
// path-escaping filename.
const DIGEST_RE = /^[0-9a-f]{16}$/;
const SAFE_SUBSCRIPTION_ID_RE = /^(?!.*\.\.)[A-Za-z0-9._-]+$/;

const CostViewSchema = z.enum(['actual', 'amortized']);
const CurrencyModeSchema = z.enum(['billing', 'normalized_usd']);
const GranularitySchema = z.literal('Daily');
const MaturityStatusSchema = z.enum(['not_mature', 'usage_stable', 'finalized']);
const BillingAccountTypeSchema = z.enum(['EA', 'MCA', 'MOSP', 'CSP', 'unknown']);

const DailyCostSchema = z.object({
  date: z.string(),
  cost: z.number(),
});

const MonthlyDimensionRowSchema = z.object({
  name: z.string(),
  cost: z.number(),
});

const DailyDimensionRowSchema = z.object({
  date: z.string(),
  name: z.string(),
  cost: z.number(),
});

const DimensionSchema = z.object({
  monthly: z.array(MonthlyDimensionRowSchema),
  daily: z.array(DailyDimensionRowSchema),
  /** e.g. 'not_available_in_source' when the source has no daily breakdown. */
  daily_status: z.string().optional(),
  /** e.g. 'not_supported_by_current_capability' for an absent dimension. */
  status: z.string().optional(),
});

export const BillingCacheRecordSchema = z.object({
  schema_version: z.literal(CACHE_SCHEMA_VERSION),
  subscription_id: z.string().regex(SAFE_SUBSCRIPTION_ID_RE),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  billing_period: z.object({
    start: z.string(),
    end: z.string(),
    granularity: GranularitySchema,
    billing_account_type: BillingAccountTypeSchema,
  }),
  maturity: z.object({
    status: MaturityStatusSchema,
    cost_view: CostViewSchema,
    stabilization_offset_days: z.number().int().min(0),
    became_cacheable_on: z.string(),
    late_adjustment_possible: z.boolean(),
    retrieved_at: z.string(),
  }),
  source: z.object({
    capability: z.string().min(1),
    capability_version: z.string().min(1),
    /** Endpoint hash the cell was warmed under (defense-in-depth on read). */
    amg_mcp_endpoint_hash: z.string().min(1),
    scope: z.string().min(1),
    parameters_digest: z.string().regex(DIGEST_RE),
    currency_mode: CurrencyModeSchema,
  }),
  totals: z.object({
    currency: z.string().min(1),
    exchange_rate_date: z.string().nullable().optional(),
    month_total: z.number(),
    /** Amortized residual (e.g. UnusedReservation) not attributable to a dimension. */
    unattributed: z.number(),
    daily: z.array(DailyCostSchema),
  }),
  dimensions: z.record(z.string(), DimensionSchema),
  coverage: z.object({
    complete: z.boolean(),
    /** Whether per-dimension sums reconcile to month_total (false under amortized). */
    dimensions_reconcile: z.boolean(),
    missing_dimensions: z.array(z.string()),
    included_charge_classes: z.array(z.string()),
    excluded_charge_classes: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  /**
   * The raw cost evidence that produced this cell, retained so the
   * cost-evidence provider can replay it through EvidenceNormalizer on a
   * cache hit (design "the CostEvidenceProvider seam" — cache at the
   * RawEvidence level, not pre-normalized records). Optional so a cell
   * warmed by a future summary-only path still validates; a hit without
   * it is treated as a miss for replay.
   */
  raw_evidence: z
    .object({
      capability: z.string().min(1),
      parameters: z.record(z.string(), z.unknown()),
      intent: z.string().min(1),
      capability_version: z.string().min(1),
      result: z.unknown(),
    })
    .optional(),
});

export type BillingCacheRecord = z.infer<typeof BillingCacheRecordSchema>;

export const ManifestEntrySchema = z.object({
  subscription_id: z.string().regex(SAFE_SUBSCRIPTION_ID_RE),
  month: z.string(),
  cost_view: CostViewSchema,
  currency_mode: CurrencyModeSchema,
  parameters_digest: z.string().regex(DIGEST_RE),
  /** Relative path under the partition root (posix-style). */
  file: z.string(),
  /** sha256 of the exact on-disk bytes — out-of-band integrity check. */
  checksum: z.string(),
  maturity_status: MaturityStatusSchema,
  retrieved_at: z.string(),
  written_at: z.string(),
});

export type BillingCacheManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
  /** `<endpoint-hash>::<identity>` — guards against a cross-partition manifest. */
  root_identity: z.string(),
  entries: z.record(z.string(), ManifestEntrySchema),
});

export type BillingCacheManifest = z.infer<typeof ManifestSchema>;
