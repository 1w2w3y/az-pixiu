import { ScopeSchema, type AnalysisType, type Scope } from '../schemas/index.js';

/**
 * Convert CLI arguments to a validated Scope (design §4.2). All time
 * inputs are normalized to ISO UTC with offset. Defaults:
 *   - time_window: last 7 days (now − 7d ... now)
 *   - baseline_window: 7 days before time_window (cost_surprise only;
 *     cost_summary doesn't use a baseline so it stays undefined)
 *
 * The analysis_type input drives the baseline-window behavior:
 *   - cost_surprise: baseline_window required (defaults computed if absent)
 *   - cost_summary: baseline_window ignored even if supplied
 */

export interface ScopeIntakeInput {
  /** One or more Azure subscription UUIDs to analyze. */
  subscription_ids: string[];
  /** Which analysis to perform. Defaults to cost_surprise for backward compat. */
  analysis_type?: AnalysisType;
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

  const analysisType: AnalysisType = input.analysis_type ?? 'cost_surprise';

  const now = input.now ?? new Date();
  const day = 86_400_000;

  const endIso = input.time_window_end ?? now.toISOString();
  const analysisEnd = new Date(endIso);

  const startIso =
    input.time_window_start ?? new Date(analysisEnd.getTime() - 7 * day).toISOString();
  const analysisStart = new Date(startIso);

  if (analysisEnd.getTime() <= analysisStart.getTime()) {
    throw new Error(`time_window.end (${endIso}) must be after time_window.start (${startIso}).`);
  }

  let baselineWindow: { start: string; end: string } | undefined;
  if (analysisType === 'cost_surprise') {
    const baselineEndIso = input.baseline_window_end ?? startIso;
    const baselineEnd = new Date(baselineEndIso);
    const baselineStartIso =
      input.baseline_window_start ?? new Date(baselineEnd.getTime() - 7 * day).toISOString();
    if (baselineEnd.getTime() <= new Date(baselineStartIso).getTime()) {
      throw new Error(
        `baseline_window.end (${baselineEndIso}) must be after baseline_window.start (${baselineStartIso}).`,
      );
    }
    baselineWindow = { start: baselineStartIso, end: baselineEndIso };
  }

  const subPart =
    input.subscription_ids.length === 1
      ? `subscription ${input.subscription_ids[0]}`
      : `${input.subscription_ids.length} subscriptions: ${input.subscription_ids.join(', ')}`;

  const rgPart =
    input.resource_group_names && input.resource_group_names.length > 0
      ? `${input.resource_group_names.length} resource group(s): ${input.resource_group_names.join(', ')}`
      : 'no resource-group filter';

  const baselinePart = baselineWindow
    ? `baseline ${baselineWindow.start} → ${baselineWindow.end}, `
    : '';

  const summary =
    `${subPart}, ${rgPart}, ` +
    `analysis ${startIso} → ${endIso}, ${baselinePart}` +
    `analysis_type=${analysisType}`;

  return ScopeSchema.parse({
    subscription_ids: input.subscription_ids,
    resource_group_names: input.resource_group_names,
    time_window: { start: startIso, end: endIso },
    ...(baselineWindow ? { baseline_window: baselineWindow } : {}),
    analysis_type: analysisType,
    resource_type_filter: input.resource_type_filter,
    user_context: input.user_context,
    effective_scope_summary: summary,
  });
}
