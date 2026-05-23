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
  // Phase 3 §Gap 4 (freshness): cost-API posting lag. partial_window is
  // emitted when the analysis time_window ends within the API's known
  // late-posting threshold (default 48h) and the totals are therefore
  // expected to revise upward. uniform_drop is reserved for the
  // cross-subscription artefact heuristic that lands with the broader
  // Phase 3 work.
  'freshness_partial_window',
  'freshness_uniform_drop',
]);

export type DataQualityCategory = z.infer<typeof DataQualityCategorySchema>;

export const DataQualityFindingSchema = z
  .object({
    dq_id: DqIdSchema,
    category: DataQualityCategorySchema,
    // Required-and-nullable, not `.optional()` — OpenAI strict-mode
    // structured outputs require all properties in `required`, and
    // `.optional()` on a schema shared across the reasoner output (via
    // ScopeSubsetSchema) triggers a broken self-ref cycle in
    // zod-to-json-schema's definition extraction. See common.ts for the
    // full explanation.
    affected_capability: z.string().min(1).nullable(),
    affected_scope_subset: ScopeSubsetSchema.nullable(),
    consequence_for_analysis: z.string().min(1),
    impact_on_recommendations: z.array(RecommendationIdSchema),
    actionable_hint: z.string().min(1).nullable(),
  })
  .strict();

export type DataQualityFinding = z.infer<typeof DataQualityFindingSchema>;
