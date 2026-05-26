import type { WasteLane } from './types.js';
import { orphanPublicIpLane } from './orphan-public-ip.js';

/**
 * Waste-lane registry (Phase 3 — design/cost-summary-depth.md §Gap 1,
 * "extensible by configuration, not hardcoded").
 *
 * PR 1 ships the single orphan-public-IP lane. Subsequent PRs add new
 * lanes here, one entry per lane, gated on the AMG-MCP field-shape
 * spike documented in the consensus plan. Lanes admit by appending to
 * this list — no orchestrator change required.
 */
export const WASTE_LANES: readonly WasteLane[] = [orphanPublicIpLane];

export function getEnabledWasteLanes(): readonly WasteLane[] {
  return WASTE_LANES;
}
