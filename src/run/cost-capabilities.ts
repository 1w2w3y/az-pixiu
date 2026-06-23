/**
 * The single source of truth for "which capabilities produce cost rows".
 *
 * This set was previously duplicated verbatim in three places — the report
 * coverage helper (`src/report/coverage.ts`), the freshness check
 * (`src/run/freshness.ts`), and the run-outcome classifier
 * (`src/run/orchestrator.ts`) — each carrying a comment that the others
 * had to agree with it. Extracting it here removes the drift risk (the
 * design's sequencing step 1 seam for the local billing cache).
 *
 * `COST_WIRE_CAPABILITIES` is the wire-level set: capabilities whose
 * evidence came from a live AMG-MCP cost call. Freshness uses exactly this
 * set, because only live cost rows are subject to the cost-API's posting
 * lag — a cached, usage-stable month must NOT be re-flagged as fresh.
 *
 * When the local billing cache's cost-evidence provider lands (sequencing
 * step 6), the coverage and run-outcome surfaces will additionally count
 * `az_pixiu_billing_cache` (so a cache-only run still classifies as
 * covered/success), while freshness deliberately keeps using the
 * wire-only set above. That asymmetry is the reason this module exposes
 * the wire set explicitly rather than one blended constant.
 */
import { BILLING_CACHE_SOURCE_CAPABILITY } from '../billing-cache/types.js';

export const COST_WIRE_CAPABILITIES: ReadonlySet<string> = new Set([
  'amgmcp_cost_analysis',
  'cost_analysis',
]);

/**
 * Wire capabilities plus the synthetic local-billing-cache source. This is
 * the set the **coverage** and **run-outcome** surfaces use, so a run that
 * answered its cost question from cache (`az_pixiu_billing_cache` evidence,
 * and a cache-served transport entry) still counts as covered / SUCCESS
 * rather than collapsing to FAILED or not_applicable. Freshness
 * deliberately does NOT use this set — a usage-stable cached month must
 * not be re-flagged as subject to the cost-API's posting lag.
 */
export const COST_EVIDENCE_CAPABILITIES: ReadonlySet<string> = new Set([
  ...COST_WIRE_CAPABILITIES,
  BILLING_CACHE_SOURCE_CAPABILITY,
]);
