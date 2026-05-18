import type { AnalysisType } from '../schemas/index.js';

/**
 * Required vs. optional capability map per analysis type (closes the
 * Tier-1 gap flagged earlier: §7.2 step 3 "fail fast if required
 * capabilities missing" without specifying which are required).
 *
 * Required = absence is a hard failure (run cannot proceed).
 * Optional = absence is degradable to bounded analysis with a
 *            `missing_telemetry` or `unsupported_capability` data-quality
 *            finding (per the §11 missing-evidence table).
 *
 * Cost-surprise rationale:
 *   - cost_analysis is the central signal. No cost data → no analysis.
 *   - query_azure_subscriptions confirms the scope is reachable.
 *   - query_resource_graph supplies the inventory used to scope metric
 *     and activity-log calls.
 *   - query_resource_metric_definition gates which metrics we can ask
 *     for; without it, we can't safely request utilization data.
 *   - query_resource_metric: utilization deepens recommendations but
 *     cost-only recommendations can still be produced without it.
 *   - query_activity_log: deployment/scale events help explain shifts;
 *     absence produces lower-confidence hypotheses, not silence.
 *   - query_resource_health: availability transitions are corroborative.
 */
export interface RequiredCapabilityMap {
  required: readonly string[];
  optional: readonly string[];
}

export const REQUIRED_CAPABILITY_MAP: Partial<Record<AnalysisType, RequiredCapabilityMap>> = {
  cost_surprise: {
    required: [
      'amgmcp_query_azure_subscriptions',
      'amgmcp_cost_analysis',
      'amgmcp_query_resource_graph',
      'amgmcp_query_resource_metric_definition',
    ],
    optional: [
      'amgmcp_query_resource_metric',
      'amgmcp_query_activity_log',
      'amgmcp_query_resource_health',
    ],
  },
  // Phase 2+ analysis types are reserved in the enum but not yet mapped;
  // attempting to discover for one throws (see getRequiredCapabilities).
};

export function getRequiredCapabilities(analysisType: AnalysisType): RequiredCapabilityMap {
  const map = REQUIRED_CAPABILITY_MAP[analysisType];
  if (!map) {
    throw new Error(
      `No required-capability map for analysis type "${analysisType}". ` +
        `Phase 1 supports cost_surprise only.`,
    );
  }
  return map;
}
