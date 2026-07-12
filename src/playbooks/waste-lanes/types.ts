import type { EvidenceRequest, EvidenceRecord, Scope, ToolCallResult } from '../../schemas/index.js';
import type { LaneTotal } from '../../pricing/impact.js';
import type { EstimateResult } from '../../pricing/impact.js';
import type { PricingRateSource } from '../../pricing/source.js';

/**
 * Waste-detection lane types (Phase 3 — design/cost-summary-depth.md §Gap 1).
 *
 * Each lane is a small object that knows how to:
 *   1. Build an Azure Resource Graph (ARG) request whose `where` clause
 *      *is* the classification predicate the report will cite.
 *   2. Parse the ARG response rows into a list of {@link WasteCandidate}s,
 *      one row → one candidate. Lane code does not infer or interpret;
 *      classification is the ARG predicate itself, not a follow-up model
 *      call.
 *   3. Map each candidate to a SKU string that the
 *      {@link PricingRateSource} can resolve to a calibrated weekly
 *      impact, or to `undefined` when the row's SKU cannot be inferred.
 *
 * The lane interface is deliberately narrow so new lanes admit by
 * convention rather than by orchestrator changes. The
 * {@link WasteDetectionExecutor} fans the lanes out, attaches estimated
 * impact via {@link estimateWeeklyImpactRange}, and emits one
 * {@link EvidenceRecord} per candidate plus, for complete non-empty
 * enumerations, a non-candidate lane-summary record so the reasoner can
 * cite both individual classifications and exact aggregate totals when
 * forming recommendations.
 */

export interface WasteCandidate {
  /** Azure ARM resource id. The defining citation for the candidate. */
  resource_id: string;
  /** Short display name (last segment of the resource id). */
  name: string;
  subscription_id: string;
  resource_group: string;
  location: string;
  /**
   * SKU key the {@link PricingRateSource} is queried with. When the
   * lane cannot infer a SKU from the row (e.g. Basic/Dynamic IPs that
   * the rate card does not cover), this stays the literal string the
   * report renders inside `(rate unavailable for SKU X)` — never an
   * empty string.
   */
  sku: string;
  /**
   * Lane-specific extra fields that defend the classification (e.g.
   * `allocationMethod` for orphan public IPs). Surfaced in the report
   * so reviewers can verify the row against the predicate without
   * round-tripping through the raw payload.
   */
  fields: Record<string, string>;
}

export interface WasteLaneRunContext {
  scope: Scope;
  rateSource: PricingRateSource;
}

export interface WasteLane {
  /** Stable machine-readable lane name (e.g. 'orphan_public_ip'). */
  name: string;
  /** Exact ARM resource types this lane is permitted to admit. */
  resource_types: readonly string[];
  /** Human-readable label for the report section. */
  title: string;
  /**
   * The ARG `where`-clause text the lane uses to classify resources.
   * Cited verbatim in both the EvidenceRecord and the markdown report
   * so the predicate is the recommendation's defense, not free-form
   * narrative.
   */
  predicate_text: string;
  /**
   * Build the EvidenceRequest the executor will dispatch through the
   * existing MCPClient transport (gets retry/pacing/embedded-detection
   * via EvidenceExecutor). The lane controls the ARG query body; the
   * executor controls the capability call.
   */
  buildRequest(ctx: WasteLaneRunContext): EvidenceRequest;
  /**
   * Convert a successful ARG response into structured candidates.
   * Unparseable rows are skipped (and counted in
   * {@link WasteLaneResult.unparsed_row_count}) — a lane that crashes
   * on a single malformed row would silently drop the rest.
   */
  parseRows(result: ToolCallResult): {
    candidates: WasteCandidate[];
    unparsed_row_count: number;
  };
}

export interface WasteCandidateEvidence {
  candidate: WasteCandidate;
  estimated_weekly_impact: EstimateResult;
  evidence: EvidenceRecord;
}

export interface WasteLaneResult {
  /** Lane this result belongs to. */
  lane: string;
  /** Lane title used in the report. */
  title: string;
  /** Predicate text cited in evidence and the report. */
  predicate_text: string;
  /** Wire capability the lane reached for (always ARG today). */
  source_capability: string;
  /** Per-candidate enriched records. Empty for a clean scope. */
  candidates: WasteCandidateEvidence[];
  /** Rolled-up lane total, computed via rollUpLaneTotal(). */
  lane_total: LaneTotal;
  /**
   * Capture date of the rate card the impact estimates were computed
   * from. Surfaced as a per-lane trace attribute and as a footnote on
   * the lane's report section.
   */
  rate_source_captured_at: string;
  /**
   * Number of ARG rows the parser could not interpret. Surfaced in the
   * EvidenceRecord caveats so the operator sees that a row was dropped
   * rather than silently classified as "no candidate".
   */
  unparsed_row_count: number;
  /**
   * Parsed rows rejected because the returned subscription was outside
   * the effective scope or disagreed with the subscription encoded in the
   * ARM resource id. These rows never become evidence or impact estimates.
   */
  rejected_row_count: number;
  /**
   * True when the lane's ARG call exhausted retries or failed before
   * returning any data. The lane still appears in the report so the
   * operator sees the lane was attempted; impact is omitted.
   */
  failed: boolean;
}
