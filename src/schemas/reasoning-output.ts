import { z } from 'zod';
import { FactSchema, HypothesisSchema, RecommendationSchema } from './reasoning.js';
import { DataQualityFindingSchema } from './data-quality.js';

// ---------- ReasoningOutput (§7.2 step 7) ----------
// The structured object emitted by the reasoner LLM call and then
// post-processed deterministically per §7.5. Citation cross-checks
// (every cited ID resolves; supported_by_hypothesis_ids reference
// hypotheses that exist in this same payload) live in the reasoning
// component, not in the schema — schemas can't carry cross-array
// referential integrity.

export const ReasoningOutputSchema = z
  .object({
    facts: z.array(FactSchema),
    hypotheses: z.array(HypothesisSchema),
    recommendations: z.array(RecommendationSchema),
    data_quality: z.array(DataQualityFindingSchema),
  })
  .strict();

export type ReasoningOutput = z.infer<typeof ReasoningOutputSchema>;
