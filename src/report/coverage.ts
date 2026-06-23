import type {
  EvidenceRecord,
  Scope,
  TransportSummaryEntry,
} from '../schemas/index.js';
import { COST_EVIDENCE_CAPABILITIES, COST_WIRE_CAPABILITIES } from '../run/cost-capabilities.js';

/**
 * Cost-scope coverage helper (Phase 3 — cron-comparison-improvements §S2/§S3).
 *
 * Computes a deterministic answer to "did we get cost evidence for every
 * intended subscription?" from the request scope + retrieved evidence +
 * transport_summary failures. The result drives both the Executive
 * Summary coverage disclosure (renderer-owned, never delegated to the
 * model) and the Run Quality quantified baseline.
 *
 * Denominator: `scope.subscription_ids`. When the scope carries no
 * subscription ids the coverage is considered non-derivable and the
 * renderer falls back to generic language — the helper does not invent
 * counts.
 *
 * Covered: subscriptions that contributed at least one successful cost
 * evidence record (`amgmcp_cost_analysis` / `cost_analysis`). Membership
 * is read from `EvidenceRecord.scope_subset.subscription_ids`.
 *
 * Unavailable: subscriptions whose cost-evidence retrieval ended in a
 * non-success transport outcome, read from `TransportSummaryEntry`s on
 * cost capabilities whose `scope_subset.subscription_ids` identify them
 * precisely.
 */

export interface CostCoverage {
  /**
   * Whether coverage could be derived from the inputs at all. False when
   * the scope carries no subscription ids — the renderer should not
   * fabricate a denominator.
   */
  derivable: boolean;
  /** Subscription ids in scope. Empty when {@link derivable} is false. */
  expected_ids: string[];
  /** Subscription ids that produced at least one cost evidence record. */
  covered_ids: string[];
  /**
   * Subscription ids whose cost retrieval ended in a non-success
   * transport outcome (rate_limit, timeout, etc.) and never produced
   * evidence. May overlap with {@link covered_ids} if a sub was both
   * retried-and-recovered and emitted evidence — those are NOT counted
   * as unavailable.
   */
  unavailable_ids: string[];
  /**
   * Failure-category breakdown across {@link unavailable_ids}. The
   * categories are the failure taxonomy's names ('rate_limit', etc.).
   */
  unavailable_by_category: Record<string, string[]>;
  /**
   * Subscription ids in scope that neither produced evidence nor were
   * recorded as a transport failure with scope context. Renderer
   * surfaces these as "coverage unknown" so the report stays honest
   * when context is missing.
   */
  unknown_ids: string[];
}

export interface ComputeCoverageInput {
  scope: Scope;
  evidence: readonly EvidenceRecord[];
  transportSummary?: readonly TransportSummaryEntry[];
}

export function computeCostCoverage(input: ComputeCoverageInput): CostCoverage {
  const expected = input.scope.subscription_ids;
  if (!expected || expected.length === 0) {
    return {
      derivable: false,
      expected_ids: [],
      covered_ids: [],
      unavailable_ids: [],
      unavailable_by_category: {},
      unknown_ids: [],
    };
  }

  const expectedSet = new Set(expected);
  const covered = new Set<string>();
  for (const record of input.evidence) {
    // Cached cost evidence (az_pixiu_billing_cache) counts toward coverage.
    if (!COST_EVIDENCE_CAPABILITIES.has(record.source_capability)) continue;
    const subs = record.scope_subset.subscription_ids;
    if (!subs) continue;
    for (const id of subs) {
      if (expectedSet.has(id)) covered.add(id);
    }
  }

  const unavailable_by_category: Record<string, string[]> = {};
  const unavailable = new Set<string>();
  for (const entry of input.transportSummary ?? []) {
    if (!COST_WIRE_CAPABILITIES.has(entry.capability)) continue;
    if (entry.final_outcome === 'success') continue;
    const subs = entry.scope_subset?.subscription_ids;
    if (!subs) continue;
    const category = entry.failure_category ?? entry.final_outcome;
    for (const id of subs) {
      if (!expectedSet.has(id)) continue;
      if (covered.has(id)) continue;
      unavailable.add(id);
      const bucket = unavailable_by_category[category] ?? [];
      if (!bucket.includes(id)) bucket.push(id);
      unavailable_by_category[category] = bucket;
    }
  }

  const unknown: string[] = [];
  for (const id of expected) {
    if (!covered.has(id) && !unavailable.has(id)) unknown.push(id);
  }

  return {
    derivable: true,
    expected_ids: [...expected],
    covered_ids: [...covered].sort(),
    unavailable_ids: [...unavailable].sort(),
    unavailable_by_category,
    unknown_ids: unknown.sort(),
  };
}

export function isFullCoverage(c: CostCoverage): boolean {
  return c.derivable && c.covered_ids.length === c.expected_ids.length;
}

export function hasIncompleteCoverage(c: CostCoverage): boolean {
  return c.derivable && c.covered_ids.length < c.expected_ids.length;
}
