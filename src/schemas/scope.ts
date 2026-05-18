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
    // baseline_window is required for cost_surprise (Phase 1's only
    // analysis type). When future analysis types relax this, the
    // requirement moves into the scope-intake component, keyed off
    // analysis_type, rather than weakening the schema globally.
    baseline_window: TimeWindowSchema,
    analysis_type: AnalysisTypeSchema,
    resource_type_filter: z.array(z.string().min(1)).optional(),
    user_context: z.string().optional(),
    effective_scope_summary: z.string().min(1),
  })
  .strict();

export type Scope = z.infer<typeof ScopeSchema>;
