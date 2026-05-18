import { z } from 'zod';
import {
  AzureSubscriptionIdSchema,
  TimeWindowSchema,
  AnalysisTypeSchema,
} from './common.js';

// ---------- Scope (§5.1) ----------
// The validated, normalized analysis scope produced by the scope-intake
// component (§4.2). user_context is captured here but kept separate from
// retrieved evidence by the planner/reasoner boundary (§7.3).

export const ScopeSchema = z
  .object({
    subscription_ids: z.array(AzureSubscriptionIdSchema).min(1),
    resource_group_names: z.array(z.string().min(1)).optional(),
    time_window: TimeWindowSchema,
    // baseline_window is required for cost_surprise but not for
    // cost_summary (single-window cost dump, no anomaly comparison).
    // The refinement below keeps the requirement keyed off analysis_type.
    baseline_window: TimeWindowSchema.optional(),
    analysis_type: AnalysisTypeSchema,
    resource_type_filter: z.array(z.string().min(1)).optional(),
    user_context: z.string().optional(),
    effective_scope_summary: z.string().min(1),
  })
  .strict()
  .refine(
    (scope) => scope.analysis_type !== 'cost_surprise' || scope.baseline_window !== undefined,
    {
      message: 'cost_surprise analysis requires a baseline_window',
      path: ['baseline_window'],
    },
  );

export type Scope = z.infer<typeof ScopeSchema>;
