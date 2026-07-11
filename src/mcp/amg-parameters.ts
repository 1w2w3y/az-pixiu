import type { TimeWindow } from '../schemas/index.js';

/**
 * Build parameters that match the discovered live AMG-MCP schemas.
 * Keep these helpers at the MCP boundary so deterministic playbooks do
 * not drift back to internal snake_case scope shapes that the server
 * silently rejects through ToolCallResult.isError.
 */
export function costAnalysisParameters(
  subscriptionId: string,
  timeWindow: TimeWindow,
): Record<string, unknown> {
  return {
    subscriptionId,
    startTime: timeWindow.start,
    endTime: timeWindow.end,
  };
}

export function activityLogParameters(
  subscriptionId: string,
  timeWindow: TimeWindow,
  resourceGroupName?: string,
): Record<string, unknown> {
  const scope = resourceGroupName
    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`
    : `/subscriptions/${subscriptionId}`;
  return {
    scope,
    startTime: timeWindow.start,
    endTime: timeWindow.end,
  };
}
