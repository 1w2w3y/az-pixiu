import { z } from 'zod';
import {
  DqIdSchema,
  RecommendationIdSchema,
  ScopeSubsetSchema,
} from './common.js';

// ---------- DataQualityFinding (§5.6) ----------
// First-class output shape: gaps, blockers, and degraded signals are
// surfaced rather than silently elided (design §6 / §11).

export const DataQualityCategorySchema = z.enum([
  // §4.4 failure-classifier classes
  'auth',
  'authz_gap',
  'unsupported_capability',
  'invalid_scope',
  'timeout',
  'rate_limit',
  'schema_mismatch',
  'empty_result',
  // §5.6 analytical-quality classes
  'stale_data',
  'partial_coverage',
  'tagging_gap',
  'missing_telemetry',
]);

export type DataQualityCategory = z.infer<typeof DataQualityCategorySchema>;

export const DataQualityFindingSchema = z
  .object({
    dq_id: DqIdSchema,
    category: DataQualityCategorySchema,
    // .nullable().optional() — DataQualityFinding is part of the reasoner's
    // structured output, so optional fields must also be nullable to satisfy
    // OpenAI strict-mode (see EvidenceRequestSchema for the rationale).
    affected_capability: z.string().min(1).nullable().optional(),
    affected_scope_subset: ScopeSubsetSchema.nullable().optional(),
    consequence_for_analysis: z.string().min(1),
    impact_on_recommendations: z.array(RecommendationIdSchema),
    actionable_hint: z.string().min(1).nullable().optional(),
  })
  .strict();

export type DataQualityFinding = z.infer<typeof DataQualityFindingSchema>;
