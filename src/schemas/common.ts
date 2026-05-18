import { z } from 'zod';

// ---------- Branded ID types (§5) ----------
// Branded strings prevent passing a FactId where an EvidenceId is expected.

export const RunIdSchema = z.string().uuid().brand<'RunId'>();
export const EvidenceIdSchema = z.string().min(1).brand<'EvidenceId'>();
export const FactIdSchema = z.string().min(1).brand<'FactId'>();
export const HypothesisIdSchema = z.string().min(1).brand<'HypothesisId'>();
export const RecommendationIdSchema = z.string().min(1).brand<'RecommendationId'>();
export const DqIdSchema = z.string().min(1).brand<'DqId'>();

export type RunId = z.infer<typeof RunIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type FactId = z.infer<typeof FactIdSchema>;
export type HypothesisId = z.infer<typeof HypothesisIdSchema>;
export type RecommendationId = z.infer<typeof RecommendationIdSchema>;
export type DqId = z.infer<typeof DqIdSchema>;

// ---------- Azure scope primitives ----------

export const AzureSubscriptionIdSchema = z.string().uuid();
export type AzureSubscriptionId = z.infer<typeof AzureSubscriptionIdSchema>;

// ---------- TimeWindow ----------
// Refinement enforces end > start so a misordered window can't slip through.

export const TimeWindowSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((tw) => new Date(tw.end).getTime() > new Date(tw.start).getTime(), {
    message: 'time_window.end must be strictly after time_window.start',
    path: ['end'],
  });

export type TimeWindow = z.infer<typeof TimeWindowSchema>;

// ---------- ScopeSubset (§5.2, §5.6) ----------
// A loose sub-scope referenced by EvidenceRecord and DataQualityFinding to
// describe which slice was covered or blocked.

export const ScopeSubsetSchema = z
  .object({
    subscription_ids: z.array(AzureSubscriptionIdSchema).optional(),
    resource_group_names: z.array(z.string().min(1)).optional(),
    resource_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ScopeSubset = z.infer<typeof ScopeSubsetSchema>;

// ---------- Analysis types (§5.1) ----------
// Phase 1 implements cost_surprise only; remaining names are reserved.

export const AnalysisTypeSchema = z.enum([
  'cost_surprise',
  'idle_underused',
  'quarterly_review',
  'cost_telemetry_correlation',
  'tagging_hygiene',
]);
export type AnalysisType = z.infer<typeof AnalysisTypeSchema>;

// ---------- Query intent (§5.2) ----------

export const QueryIntentSchema = z.enum([
  'cost_breakdown',
  'inventory',
  'utilization',
  'activity',
  'health',
  'metric_definition',
]);
export type QueryIntent = z.infer<typeof QueryIntentSchema>;
