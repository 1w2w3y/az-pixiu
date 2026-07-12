import type { EvidenceRecord, ReasoningOutput } from '../schemas/index.js';
import { ReasoningOutputSchema } from '../schemas/index.js';
import { deriveConfidenceLevel } from '../confidence.js';
import { detectImperativeRemediation } from '../lint/imperative.js';

/**
 * Phase 1 minimal scoring rubric (design §22 step 12, §17 verification),
 * extended in Phase 3 with two waste-lane rubrics.
 * Each rubric is one independent check; aggregator returns the conjunction.
 *
 * The first four rubrics deliberately mirror §17's verification list:
 *   - structural correctness (passes ReasoningOutputSchema)
 *   - evidence-citation completeness (every rec cites surviving facts/hyps;
 *     every fact cites at least one evidence_id, which the schema enforces)
 *   - confidence-derivation consistency (level matches dimensions)
 *   - read-only language adherence (no bare imperative remediation)
 *
 * Phase 3 added two waste-lane rubrics:
 *   - estimated_impact_calibrated (waste recs ship a defensible impact estimate)
 *   - waste_classification_grounding (waste recs cite a waste-lane evidence record)
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

/**
 * Phase 3 — design/cost-summary-depth.md §"Evaluation surface" /
 * "Reasoner prompt changes" / §Gap 1.
 *
 * Every fact that mentions a waste-candidate resource id must cite the
 * waste-candidate EvidenceRecord that classified it. Without this rule
 * the reasoner could surface a resource id from memory or fabrication;
 * with it, the cited evidence record is the predicate's defense and a
 * future audit can trace the candidate back to the lane that produced
 * it.
 *
 * Loose-but-honest detection: we look for substring matches of any
 * waste-candidate resource id inside fact statements. False negatives
 * (an evasive paraphrase) are accepted; the rubric is structural, not
 * a model-grader. False positives are not possible since resource ids
 * are globally unique strings.
 */
export function scoreWasteClassificationGrounding(
  output: ReasoningOutput,
  evidence: readonly EvidenceRecord[],
): ScoringResult {
  const candidateRecords = evidence.flatMap((record) => {
    if (record.query_intent !== 'waste_candidate' || record.payload_ref.kind !== 'inline') {
      return [];
    }
    const payload = asRecord(record.payload_ref.data);
    if (!payload) return [];
    // A lane_summary shares the intent/source so the reasoner can cite its
    // aggregate values, but it is never itself a review candidate.
    if (payload.record_kind === 'lane_summary') return [];
    const resourceId = asRecord(payload.candidate)?.resource_id;
    return typeof resourceId === 'string' && resourceId.length > 0
      ? [{ record, resourceId }]
      : [];
  });
  if (candidateRecords.length === 0) {
    // No waste candidates in scope — rubric is vacuously satisfied. The
    // eval framework still emits the score so a v2 run against a non-
    // waste fixture stays comparable.
    return { rubric: 'waste_classification_grounding', passed: true };
  }
  const evidenceIdByResource = new Map<string, string>();
  for (const { record, resourceId } of candidateRecords) {
    evidenceIdByResource.set(resourceId, record.evidence_id);
  }
  const failures: string[] = [];
  for (const fact of output.facts) {
    const cited = new Set(fact.evidence_ids);
    for (const [resourceId, expectedEvidenceId] of evidenceIdByResource) {
      if (!fact.statement.includes(resourceId)) continue;
      if (!cited.has(expectedEvidenceId)) {
        failures.push(
          `fact ${fact.fact_id} mentions waste-candidate ${resourceId} but does not cite its lane evidence ${expectedEvidenceId}`,
        );
      }
    }
  }
  return failures.length === 0
    ? { rubric: 'waste_classification_grounding', passed: true }
    : { rubric: 'waste_classification_grounding', passed: false, details: failures.join('; ') };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Phase 3 — design/cost-summary-depth.md §Gap 3 / §"Evaluation surface".
 *
 * Estimated weekly impact must be rendered as a *range* with a cited
 * rate source — never a single dollar figure. The check is local to
 * recommendation text (statement + actions + validation steps + caveats):
 * an *estimated impact* dollar amount that is not part of a numeric range
 * (`$X–$Y` or `$X-$Y`) flags as a calibration violation, and any text
 * carrying estimated dollars must also reference a provenance keyword
 * (list-price, rate card, estimate, captured) so reviewers can find the
 * rate source. Point amounts explicitly labelled as observed/billed Cost
 * Analysis values are not estimates and are therefore left to the
 * reconciliation expectation rather than rejected here.
 *
 * Vacuously satisfied when no recommendation mentions a dollar amount.
 */
export function scoreEstimatedImpactCalibrated(output: ReasoningOutput): ScoringResult {
  const failures: string[] = [];
  for (const rec of output.recommendations) {
    const texts = [
      rec.statement,
      ...rec.suggested_human_actions,
      ...rec.validation_steps,
      ...rec.assumptions,
      ...rec.false_positive_considerations,
    ];
    let dollarSeen = false;
    for (const text of texts) {
      const estimateText = stripObservedCostAmounts(text);
      const point = detectPointDollar(estimateText);
      if (point) {
        failures.push(
          `recommendation ${rec.recommendation_id} renders point dollar "${point}" instead of a range`,
        );
        dollarSeen = true;
        break;
      }
      if (hasDollarAmount(estimateText)) dollarSeen = true;
    }
    if (dollarSeen) {
      const joined = texts.join(' ').toLowerCase();
      if (!CALIBRATION_PROVENANCE_RE.test(joined)) {
        failures.push(
          `recommendation ${rec.recommendation_id} carries a dollar amount without citing a rate source (list-price, rate card, estimate, captured)`,
        );
      }
    }
  }
  return failures.length === 0
    ? { rubric: 'estimated_impact_calibrated', passed: true }
    : { rubric: 'estimated_impact_calibrated', passed: false, details: failures.join('; ') };
}

// A calibrated range may use a dash or "to", may repeat the '$', and may
// render the currency as a trailing USD label. Thousands separators are
// accepted so portfolio-scale estimates do not become point-value false
// positives merely because of formatting.
const MONEY_NUMBER_SOURCE = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const MONEY_RANGE_RE = new RegExp(
  String.raw`(?:~?\$\s*${MONEY_NUMBER_SOURCE}\s*(?:[–—-]|\bto\b)\s*\$?\s*${MONEY_NUMBER_SOURCE}|~?\bUSD\s*${MONEY_NUMBER_SOURCE}\s*(?:[–—-]|\bto\b)\s*(?:USD\s*)?${MONEY_NUMBER_SOURCE}|~?\b${MONEY_NUMBER_SOURCE}\s*USD\s*(?:[–—-]|\bto\b)\s*${MONEY_NUMBER_SOURCE}\s*USD\b|~?\b${MONEY_NUMBER_SOURCE}\s*(?:[–—-]|\bto\b)\s*${MONEY_NUMBER_SOURCE}\s*USD\b)`,
  'gi',
);
const MONEY_AMOUNT_RE = new RegExp(
  String.raw`(?:\$\s*${MONEY_NUMBER_SOURCE}|\bUSD\s*${MONEY_NUMBER_SOURCE}|\b${MONEY_NUMBER_SOURCE}\s*USD\b)`,
  'i',
);
const MONEY_AMOUNT_GLOBAL_RE = new RegExp(MONEY_AMOUNT_RE.source, 'gi');
const CALIBRATION_PROVENANCE_RE = /(list-?price|rate\s*card|estimate|captured)/;
const OBSERVED_COST_CONTEXT_RE = /\b(?:observed|billed|billing|cost\s+analysis)\b/i;
const ESTIMATED_COST_CONTEXT_SOURCE = String.raw`estimate(?:d|s|ing|ion)?|project(?:ed|ing|ion|ions)|expect(?:ed|s|ing|ation|ations)?|forecast(?:ed|s|ing)?|list-?price|rate\s*card|exposure|savings?|save|recoverable|yield(?:s|ed|ing)?|avoid(?:able|ed|ance|ing)?|benefit|impact|potential|opportunit(?:y|ies)`;
const ESTIMATED_COST_CONTEXT_RE = new RegExp(
  String.raw`\b(?:${ESTIMATED_COST_CONTEXT_SOURCE})\b`,
  'i',
);
const OBSERVED_COST_SPAN_RE = new RegExp(
  String.raw`\b(?:observed|billed|billing|cost\s+analysis|(?:analy[sz]ed|selected|same)[- ]window\s+(?:shows?|reported|recorded|billed))\b(?:(?![;!?]|\.(?=\s|$)|\b(?:while|whereas|but|${ESTIMATED_COST_CONTEXT_SOURCE})\b)[\s\S]){0,240}`,
  'gi',
);

function detectPointDollar(text: string): string | undefined {
  // Strip every range first; any remaining monetary amount is a point.
  const stripped = text.replace(MONEY_RANGE_RE, '');
  const m = stripped.match(MONEY_AMOUNT_RE);
  return m ? m[0] : undefined;
}

function hasDollarAmount(text: string): boolean {
  return MONEY_AMOUNT_RE.test(text);
}

function stripObservedCostAmounts(text: string): string {
  const withoutPrefixedObserved = text.replace(
    new RegExp(OBSERVED_COST_SPAN_RE.source, OBSERVED_COST_SPAN_RE.flags),
    (span) => span.replace(MONEY_AMOUNT_GLOBAL_RE, ''),
  );
  return withoutPrefixedObserved.replace(
    MONEY_AMOUNT_GLOBAL_RE,
    (amount, offset: number) =>
      hasPostfixedObservedContext(withoutPrefixedObserved, offset) ? '' : amount,
  );
}

function hasPostfixedObservedContext(text: string, amountOffset: number): boolean {
  const sentenceStart = findSentenceStart(text, amountOffset);
  const sentenceEnd = findSentenceEnd(text, amountOffset);
  const sentence = text.slice(sentenceStart, sentenceEnd);
  const relativeOffset = amountOffset - sentenceStart;
  const before = sentence.slice(0, relativeOffset);
  const after = sentence.slice(relativeOffset);
  if (OBSERVED_COST_CONTEXT_RE.test(before) || ESTIMATED_COST_CONTEXT_RE.test(before)) return false;
  const nextObserved = firstMatchIndex(after, OBSERVED_COST_CONTEXT_RE);
  const nextEstimated = firstMatchIndex(after, ESTIMATED_COST_CONTEXT_RE);
  return nextObserved >= 0 && (nextEstimated < 0 || nextObserved < nextEstimated);
}

function findSentenceStart(text: string, offset: number): number {
  let start = 0;
  for (const match of text.slice(0, offset).matchAll(/[.!;](?=\s|$)/g)) {
    start = (match.index ?? 0) + 1;
  }
  return start;
}

function findSentenceEnd(text: string, offset: number): number {
  const match = /[.!;](?=\s|$)/.exec(text.slice(offset));
  return match?.index === undefined ? text.length : offset + match.index;
}

function firstMatchIndex(text: string, pattern: RegExp): number {
  return new RegExp(pattern.source, pattern.flags).exec(text)?.index ?? -1;
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

export interface ScoreAllOptions {
  /**
   * Evidence records the reasoner saw, used by Phase 3 rubrics that
   * cross-check reasoner output against grounding evidence. Optional
   * — when omitted, waste-classification grounding is skipped (it
   * would have nothing to assert against). The calibrated-impact
   * rubric does not need evidence and always runs.
   */
  evidence?: readonly EvidenceRecord[];
}

export function scoreAll(output: ReasoningOutput, options: ScoreAllOptions = {}): AggregateScore {
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
  const results: ScoringResult[] = [
    structural,
    scoreCitationCompleteness(output),
    scoreConfidenceConsistency(output),
    scoreReadOnlyAdherence(output),
    scoreEstimatedImpactCalibrated(output),
  ];
  // Phase 3 — design §Gap 1. The waste-classification grounding rubric
  // needs the evidence list to identify waste-candidate records. When
  // the caller did not pass evidence, the rubric is skipped rather
  // than scored vacuously, so the aggregate's rubric count does not
  // depend on whether the caller had the records handy.
  if (options.evidence) {
    results.push(scoreWasteClassificationGrounding(output, options.evidence));
  }
  const pass_count = results.filter((r) => r.passed).length;
  return {
    results,
    passed_all: pass_count === results.length,
    pass_count,
    fail_count: results.length - pass_count,
  };
}
