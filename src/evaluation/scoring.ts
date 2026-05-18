import type { ReasoningOutput } from '../schemas/index.js';
import { ReasoningOutputSchema } from '../schemas/index.js';
import { deriveConfidenceLevel } from '../confidence.js';
import { detectImperativeRemediation } from '../lint/imperative.js';

/**
 * Phase 1 minimal scoring rubric (design §22 step 12, §17 verification).
 * Each rubric is one independent check; aggregator returns the conjunction.
 *
 * The four rubrics deliberately mirror §17's verification list:
 *   - structural correctness (passes ReasoningOutputSchema)
 *   - evidence-citation completeness (every rec cites surviving facts/hyps;
 *     every fact cites at least one evidence_id, which the schema enforces)
 *   - confidence-derivation consistency (level matches dimensions)
 *   - read-only language adherence (no bare imperative remediation)
 *
 * Phase 2 will add: rubric.relevance, rubric.calibration vs ground truth,
 * rubric.completeness vs expected hypotheses, etc.
 */

export interface ScoringResult {
  rubric: string;
  passed: boolean;
  details?: string;
}

export interface AggregateScore {
  results: ScoringResult[];
  passed_all: boolean;
  pass_count: number;
  fail_count: number;
}

export function scoreStructuralCorrectness(output: unknown): ScoringResult {
  const result = ReasoningOutputSchema.safeParse(output);
  return result.success
    ? { rubric: 'structural_correctness', passed: true }
    : {
        rubric: 'structural_correctness',
        passed: false,
        details: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}

export function scoreCitationCompleteness(output: ReasoningOutput): ScoringResult {
  const factIds = new Set(output.facts.map((f) => f.fact_id));
  const hypIds = new Set(output.hypotheses.map((h) => h.hypothesis_id));
  const failures: string[] = [];

  for (const rec of output.recommendations) {
    const validRefs =
      rec.supported_by_hypothesis_ids.filter((id) => hypIds.has(id)).length +
      rec.supported_by_fact_ids.filter((id) => factIds.has(id)).length;
    if (validRefs === 0) {
      failures.push(`recommendation ${rec.recommendation_id} has no resolving citations`);
    }
  }

  for (const hyp of output.hypotheses) {
    const dangling = hyp.supported_by_fact_ids.filter((id) => !factIds.has(id));
    if (dangling.length > 0) {
      failures.push(`hypothesis ${hyp.hypothesis_id} dangling fact refs: ${dangling.join(', ')}`);
    }
  }

  return failures.length === 0
    ? { rubric: 'citation_completeness', passed: true }
    : { rubric: 'citation_completeness', passed: false, details: failures.join('; ') };
}

export function scoreConfidenceConsistency(output: ReasoningOutput): ScoringResult {
  const failures: string[] = [];
  for (const h of output.hypotheses) {
    const derived = deriveConfidenceLevel(h.confidence.dimensions);
    if (derived !== h.confidence.level) {
      failures.push(`hypothesis ${h.hypothesis_id} level "${h.confidence.level}" disagrees with derived "${derived}"`);
    }
  }
  for (const r of output.recommendations) {
    const derived = deriveConfidenceLevel(r.confidence.dimensions);
    if (derived !== r.confidence.level) {
      failures.push(`recommendation ${r.recommendation_id} level "${r.confidence.level}" disagrees with derived "${derived}"`);
    }
  }
  return failures.length === 0
    ? { rubric: 'confidence_consistency', passed: true }
    : { rubric: 'confidence_consistency', passed: false, details: failures.join('; ') };
}

export function scoreReadOnlyAdherence(output: ReasoningOutput): ScoringResult {
  const failures: string[] = [];
  for (const rec of output.recommendations) {
    const texts = [rec.statement, ...rec.suggested_human_actions, ...rec.validation_steps];
    for (const text of texts) {
      const result = detectImperativeRemediation(text);
      if (!result.matched) continue;
      failures.push(`recommendation ${rec.recommendation_id} contains imperative phrase: "${result.phrase}"`);
      break;
    }
  }
  return failures.length === 0
    ? { rubric: 'read_only_adherence', passed: true }
    : { rubric: 'read_only_adherence', passed: false, details: failures.join('; ') };
}

export function scoreAll(output: ReasoningOutput): AggregateScore {
  const structural = scoreStructuralCorrectness(output);
  // If structural fails, downstream rubrics are not meaningful — return early.
  if (!structural.passed) {
    return {
      results: [structural],
      passed_all: false,
      pass_count: 0,
      fail_count: 1,
    };
  }
  const results = [
    structural,
    scoreCitationCompleteness(output),
    scoreConfidenceConsistency(output),
    scoreReadOnlyAdherence(output),
  ];
  const pass_count = results.filter((r) => r.passed).length;
  return {
    results,
    passed_all: pass_count === results.length,
    pass_count,
    fail_count: results.length - pass_count,
  };
}
