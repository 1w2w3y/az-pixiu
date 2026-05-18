import { ScopeSchema, type Scope } from '../schemas/index.js';

/**
 * Convert CLI arguments to a validated Scope (design §4.2). All time
 * inputs are normalized to ISO UTC with offset. Sensible defaults:
 *   - time_window: last 7 days (now − 7d ... now)
 *   - baseline_window: 7 days before time_window
 */

export interface ScopeIntakeInput {
  /** One or more Azure subscription UUIDs to analyze. */
  subscription_ids: string[];
  resource_group_names?: string[];
  time_window_start?: string;
  time_window_end?: string;
  baseline_window_start?: string;
  baseline_window_end?: string;
  resource_type_filter?: string[];
  user_context?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export function intakeScope(input: ScopeIntakeInput): Scope {
  if (input.subscription_ids.length === 0) {
    throw new Error('intakeScope: subscription_ids must contain at least one subscription.');
  }

  const now = input.now ?? new Date();
  const day = 86_400_000;

  const endIso = input.time_window_end ?? now.toISOString();
  const analysisEnd = new Date(endIso);

  const startIso =
    input.time_window_start ?? new Date(analysisEnd.getTime() - 7 * day).toISOString();
  const analysisStart = new Date(startIso);

  const baselineEndIso = input.baseline_window_end ?? startIso;
  const baselineEnd = new Date(baselineEndIso);

  const baselineStartIso =
    input.baseline_window_start ?? new Date(baselineEnd.getTime() - 7 * day).toISOString();

  if (analysisEnd.getTime() <= analysisStart.getTime()) {
    throw new Error(`time_window.end (${endIso}) must be after time_window.start (${startIso}).`);
  }
  if (baselineEnd.getTime() <= new Date(baselineStartIso).getTime()) {
    throw new Error(
      `baseline_window.end (${baselineEndIso}) must be after baseline_window.start (${baselineStartIso}).`,
    );
  }

  const subPart =
    input.subscription_ids.length === 1
      ? `subscription ${input.subscription_ids[0]}`
      : `${input.subscription_ids.length} subscriptions: ${input.subscription_ids.join(', ')}`;

  const rgPart =
    input.resource_group_names && input.resource_group_names.length > 0
      ? `${input.resource_group_names.length} resource group(s): ${input.resource_group_names.join(', ')}`
      : 'no resource-group filter';

  const summary =
    `${subPart}, ${rgPart}, ` +
    `analysis ${startIso} → ${endIso}, baseline ${baselineStartIso} → ${baselineEndIso}, ` +
    `analysis_type=cost_surprise`;

  return ScopeSchema.parse({
    subscription_ids: input.subscription_ids,
    resource_group_names: input.resource_group_names,
    time_window: { start: startIso, end: endIso },
    baseline_window: { start: baselineStartIso, end: baselineEndIso },
    analysis_type: 'cost_surprise',
    resource_type_filter: input.resource_type_filter,
    user_context: input.user_context,
    effective_scope_summary: summary,
  });
}
