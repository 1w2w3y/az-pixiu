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
//
// All fields are required-and-nullable (not `.optional()`). Two reasons:
//   1. OpenAI strict-mode structured outputs require every property to
//      appear in `required` anyway — `.optional()` is dead weight on
//      LLM-output schemas. ScopeSubset rides inside FactSchema and
//      DataQualityFindingSchema, both of which the reasoner LLM emits.
//   2. When the same schema is referenced from multiple places (Fact +
//      DataQualityFinding here), the vendored zod-to-json-schema extracts
//      it to `definitions`. The combination of extraction + `.optional()`
//      produces a broken self-referential `anyOf: [{not: {}}, {$ref: self}]`
//      cycle that OpenAI's strict-schema validator rejects with 400
//      "Invalid schema for response_format". `.nullable()` alone avoids it.
//
// TypeScript callers must pass explicit `null` for missing slices —
// see `emptyScopeSubset()` for a convenience constructor.
export const ScopeSubsetSchema = z
  .object({
    subscription_ids: z.array(AzureSubscriptionIdSchema).nullable(),
    resource_group_names: z.array(z.string().min(1)).nullable(),
    resource_ids: z.array(z.string().min(1)).nullable(),
  })
  .strict();

export type ScopeSubset = z.infer<typeof ScopeSubsetSchema>;

/** Convenience: a fully-null ScopeSubset, optionally overridden. */
export function emptyScopeSubset(overrides: Partial<ScopeSubset> = {}): ScopeSubset {
  return {
    subscription_ids: null,
    resource_group_names: null,
    resource_ids: null,
    ...overrides,
  };
}

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
