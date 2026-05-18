import { z } from 'zod';

// ---------- ID types (§5) ----------
// These used to be Zod-branded strings for TS-level nominal typing, but
// OpenAI's vendored zod-to-json-schema emits self-referencing `$ref`
// definitions for branded types, which OpenAI strict-mode rejects as
// "Invalid schema for response_format". We accept the loss of nominal
// typing — call sites already use these names structurally, not nominally.

export const RunIdSchema = z.string().uuid();
export const EvidenceIdSchema = z.string().min(1);
export const FactIdSchema = z.string().min(1);
export const HypothesisIdSchema = z.string().min(1);
export const RecommendationIdSchema = z.string().min(1);
export const DqIdSchema = z.string().min(1);

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

// .nullable().optional() — same OpenAI strict-mode constraint as
// EvidenceRequestSchema.expected_role: optional fields surfaced via
// zodResponseFormat must also be nullable. ScopeSubset rides inside
// FactSchema and DataQualityFindingSchema, both of which the reasoner LLM
// emits, so this schema crosses the strict-mode boundary.
export const ScopeSubsetSchema = z
  .object({
    subscription_ids: z.array(AzureSubscriptionIdSchema).nullable().optional(),
    resource_group_names: z.array(z.string().min(1)).nullable().optional(),
    resource_ids: z.array(z.string().min(1)).nullable().optional(),
  })
  .strict();

export type ScopeSubset = z.infer<typeof ScopeSubsetSchema>;

// ---------- Analysis types (§5.1) ----------
// Phase 1 implements cost_surprise only; remaining names are reserved.

export const AnalysisTypeSchema = z.enum([
  'cost_surprise',
  'cost_summary',
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
