import { z } from 'zod';
import {
  EvidenceIdSchema,
  FactIdSchema,
  HypothesisIdSchema,
  RecommendationIdSchema,
  DqIdSchema,
  ScopeSubsetSchema,
} from './common.js';

// ---------- Confidence (§9) ----------
// Hybrid: structured dimensions for machine comparison; categorical level
// as the human-facing headline. The level is derived deterministically
// from the dimensions in src/confidence.ts so the LLM cannot label
// something high when its own dimensions disagree.

export const ConfidenceLevelSchema = z.enum(['low', 'medium', 'high']);
export const EvidenceCoverageSchema = z.enum(['partial', 'adequate', 'strong']);
export const SignalQualitySchema = z.enum(['weak', 'mixed', 'strong']);
export const SignalAgreementSchema = z.enum(['conflicting', 'mixed', 'aligned']);

export const ConfidenceDimensionsSchema = z
  .object({
    evidence_coverage: EvidenceCoverageSchema,
    signal_quality: SignalQualitySchema,
    signal_agreement: SignalAgreementSchema,
  })
  .strict();

export const ConfidenceSchema = z
  .object({
    level: ConfidenceLevelSchema,
    rationale: z.string().min(1),
    dimensions: ConfidenceDimensionsSchema,
  })
  .strict();

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;
export type EvidenceCoverage = z.infer<typeof EvidenceCoverageSchema>;
export type SignalQuality = z.infer<typeof SignalQualitySchema>;
export type SignalAgreement = z.infer<typeof SignalAgreementSchema>;
export type ConfidenceDimensions = z.infer<typeof ConfidenceDimensionsSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;

// ---------- Fact (§5.3) ----------
// evidence_ids non-empty: every fact must trace to at least one record.

export const FactSchema = z
  .object({
    fact_id: FactIdSchema,
    statement: z.string().min(1),
    evidence_ids: z.array(EvidenceIdSchema).min(1),
    scope_subset: ScopeSubsetSchema,
  })
  .strict();

export type Fact = z.infer<typeof FactSchema>;

// ---------- Hypothesis (§5.4) ----------

export const HypothesisSchema = z
  .object({
    hypothesis_id: HypothesisIdSchema,
    statement: z.string().min(1),
    confidence: ConfidenceSchema,
    supported_by_fact_ids: z.array(FactIdSchema),
    counter_evidence_fact_ids: z.array(FactIdSchema),
    missing_evidence_to_decide: z.array(DqIdSchema),
  })
  .strict();

export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ---------- Recommendation (§5.5) ----------
// Citation completeness — at least one supporting fact OR hypothesis —
// is enforced as a schema-level refinement so an LLM cannot emit an
// uncited recommendation past structured-output validation.

export const PrioritySchema = z.enum(['high', 'medium', 'low']);
export const ImpactSchema = z.enum(['material', 'moderate', 'minor', 'unknown']);
export const SuggestedAudienceSchema = z.enum([
  'finops_engineer',
  'platform_engineer',
  'sre',
  'engineering_manager',
  'governance',
]);

export const RecommendationSchema = z
  .object({
    recommendation_id: RecommendationIdSchema,
    priority: PrioritySchema,
    confidence: ConfidenceSchema,
    impact: ImpactSchema,
    statement: z.string().min(1),
    supported_by_hypothesis_ids: z.array(HypothesisIdSchema),
    supported_by_fact_ids: z.array(FactIdSchema),
    assumptions: z.array(z.string().min(1)),
    validation_steps: z.array(z.string().min(1)),
    false_positive_considerations: z.array(z.string().min(1)),
    suggested_audience: SuggestedAudienceSchema,
    suggested_human_actions: z.array(z.string().min(1)).min(1),
    // Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md §Gap 5).
    // A stable, deterministic slug that survives LLM rewrites of `statement`
    // so the same recommendation can be recognised across runs against the
    // same scope. Phase 2.5 only requires the field to exist; the
    // reasoner.v1 prompt asks for a short kebab-case slug summarising the
    // recommendation's subject. Phase 3's reasoner.v2 will replace that with
    // a deterministic computation from lane + cluster prefix + dominant SKU.
    recommendation_signature: z.string().min(1),
  })
  .strict()
  .refine(
    (rec) => rec.supported_by_hypothesis_ids.length + rec.supported_by_fact_ids.length > 0,
    {
      message:
        'recommendation must cite at least one fact or hypothesis (design §7.5 citation completeness)',
      path: ['supported_by_fact_ids'],
    },
  );

export type Priority = z.infer<typeof PrioritySchema>;
export type Impact = z.infer<typeof ImpactSchema>;
export type SuggestedAudience = z.infer<typeof SuggestedAudienceSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
