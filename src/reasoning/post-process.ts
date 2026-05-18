import type {
  ReasoningOutput,
  Fact,
  Hypothesis,
  Recommendation,
  DataQualityFinding,
  EvidenceRecord,
} from '../schemas/index.js';
import { deriveConfidenceLevel } from '../confidence.js';

/**
 * Deterministic post-LLM enforcement (design §7.5). Runs after the
 * reasoner returns a structurally-valid ReasoningOutput; applies a
 * sequence of checks/transformations that the LLM cannot be relied on
 * to perform consistently:
 *
 *   1. Citation validity — every cited ID must resolve to a fact /
 *      hypothesis / DQ in this same output (and evidence_ids must
 *      resolve to records in the supplied evidence set).
 *   2. No fabricated numbers — every numeric figure in a fact's
 *      statement must appear in the cited evidence payloads.
 *   3. Read-only lint — recommendation prose is scanned for imperative
 *      remediation language ("delete X", "run Y") with no
 *      consider/review/investigate framing.
 *   4. Confidence derivation — the level on every confidence object is
 *      replaced by deriveConfidenceLevel(dimensions) so the LLM cannot
 *      claim higher confidence than its own dimensions support.
 *
 * Each check produces issues. If any "fatal" issue fires, the offending
 * item is dropped and a DataQualityFinding is synthesized so the gap is
 * visible in the report rather than silently elided.
 */

export interface PostProcessIssue {
  kind:
    | 'dangling_citation'
    | 'fabricated_number'
    | 'imperative_language'
    | 'confidence_downgraded';
  target: 'fact' | 'hypothesis' | 'recommendation' | 'data_quality';
  target_id: string;
  detail: string;
}

export interface PostProcessResult {
  output: ReasoningOutput;
  issues: PostProcessIssue[];
}

export interface PostProcessContext {
  evidence: EvidenceRecord[];
}

const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  /\b(delete|drop|terminate|kill|destroy)\b/i,
  /\b(scale (?:down|up)|resize)\s+\w/i,
  /\b(restart|stop|reboot)\b/i,
  /\b(run|execute|invoke|apply)\s+(?:kubectl|az|terraform|the\s+command)/i,
];

const SOFTENING_TERMS = ['consider', 'review', 'investigate', 'examine', 'evaluate', 'assess', 'compare'];

export function postProcessReasoning(
  output: ReasoningOutput,
  context: PostProcessContext,
): PostProcessResult {
  const issues: PostProcessIssue[] = [];
  const evidenceIds = new Set(context.evidence.map((r) => r.evidence_id));
  const factIds = new Set(output.facts.map((f) => f.fact_id));
  const hypothesisIds = new Set(output.hypotheses.map((h) => h.hypothesis_id));
  const dqIds = new Set(output.data_quality.map((d) => d.dq_id));

  // 1. Citation validity + 2. fabricated numbers on facts
  const validFacts: Fact[] = [];
  let synthDqCounter = output.data_quality.length;
  const syntheticDqs: DataQualityFinding[] = [];

  for (const fact of output.facts) {
    const dangling = fact.evidence_ids.filter((id) => !evidenceIds.has(id));
    if (dangling.length > 0) {
      issues.push({
        kind: 'dangling_citation',
        target: 'fact',
        target_id: fact.fact_id,
        detail: `evidence_ids not in supplied evidence: ${dangling.join(', ')}`,
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Fact ${fact.fact_id} cited evidence_ids that do not exist.`));
      continue;
    }
    const fabricated = findFabricatedNumbers(fact, context.evidence);
    if (fabricated.length > 0) {
      issues.push({
        kind: 'fabricated_number',
        target: 'fact',
        target_id: fact.fact_id,
        detail: `numbers in statement not found in cited evidence: ${fabricated.join(', ')}`,
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Fact ${fact.fact_id} introduced numbers absent from cited evidence; fact dropped.`));
      continue;
    }
    validFacts.push(fact);
  }
  const validFactIds = new Set(validFacts.map((f) => f.fact_id));

  // 1. Citation validity on hypotheses
  const validHypotheses: Hypothesis[] = [];
  for (const hyp of output.hypotheses) {
    const danglingSupport = hyp.supported_by_fact_ids.filter((id) => !validFactIds.has(id));
    const danglingCounter = hyp.counter_evidence_fact_ids.filter((id) => !validFactIds.has(id));
    const danglingDq = hyp.missing_evidence_to_decide.filter((id) => !dqIds.has(id));
    if (danglingSupport.length + danglingCounter.length + danglingDq.length > 0) {
      issues.push({
        kind: 'dangling_citation',
        target: 'hypothesis',
        target_id: hyp.hypothesis_id,
        detail: `dangling refs: ${[...danglingSupport, ...danglingCounter, ...danglingDq].join(', ')}`,
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Hypothesis ${hyp.hypothesis_id} cited identifiers not present in the output; hypothesis dropped.`));
      continue;
    }
    // 4. Confidence derivation
    const derived = deriveConfidenceLevel(hyp.confidence.dimensions);
    if (derived !== hyp.confidence.level) {
      issues.push({
        kind: 'confidence_downgraded',
        target: 'hypothesis',
        target_id: hyp.hypothesis_id,
        detail: `LLM said "${hyp.confidence.level}", dimensions derive "${derived}"`,
      });
    }
    validHypotheses.push({
      ...hyp,
      confidence: { ...hyp.confidence, level: derived },
    });
  }
  const validHypIds = new Set(validHypotheses.map((h) => h.hypothesis_id));

  // 1. Citation completeness + 3. read-only lint on recommendations
  const validRecs: Recommendation[] = [];
  for (const rec of output.recommendations) {
    const danglingHyp = rec.supported_by_hypothesis_ids.filter((id) => !validHypIds.has(id));
    const danglingFact = rec.supported_by_fact_ids.filter((id) => !validFactIds.has(id));
    if (danglingHyp.length + danglingFact.length > 0) {
      issues.push({
        kind: 'dangling_citation',
        target: 'recommendation',
        target_id: rec.recommendation_id,
        detail: `dangling refs: ${[...danglingHyp, ...danglingFact].join(', ')}`,
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Recommendation ${rec.recommendation_id} cited identifiers not present in the output; recommendation dropped.`));
      continue;
    }
    // A recommendation must cite at least one surviving fact or hypothesis.
    const survivingSupport =
      rec.supported_by_hypothesis_ids.filter((id) => validHypIds.has(id)).length +
      rec.supported_by_fact_ids.filter((id) => validFactIds.has(id)).length;
    if (survivingSupport === 0) {
      issues.push({
        kind: 'dangling_citation',
        target: 'recommendation',
        target_id: rec.recommendation_id,
        detail: 'all supporting citations were dropped',
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Recommendation ${rec.recommendation_id} lost all supporting citations after upstream drops; recommendation dropped.`));
      continue;
    }
    if (hasImperativeRemediation(rec.statement) || rec.suggested_human_actions.some(hasImperativeRemediation)) {
      issues.push({
        kind: 'imperative_language',
        target: 'recommendation',
        target_id: rec.recommendation_id,
        detail: 'statement or actions contain imperative remediation phrasing',
      });
      syntheticDqs.push(syntheticDq(++synthDqCounter, 'schema_mismatch', `Recommendation ${rec.recommendation_id} used imperative remediation language; recommendation dropped.`));
      continue;
    }
    // 4. Confidence derivation
    const derived = deriveConfidenceLevel(rec.confidence.dimensions);
    if (derived !== rec.confidence.level) {
      issues.push({
        kind: 'confidence_downgraded',
        target: 'recommendation',
        target_id: rec.recommendation_id,
        detail: `LLM said "${rec.confidence.level}", dimensions derive "${derived}"`,
      });
    }
    validRecs.push({
      ...rec,
      confidence: { ...rec.confidence, level: derived },
    });
  }

  return {
    output: {
      facts: validFacts,
      hypotheses: validHypotheses,
      recommendations: validRecs,
      data_quality: [...output.data_quality, ...syntheticDqs],
    },
    issues,
  };
}

// --- helpers ---

function syntheticDq(counter: number, category: DataQualityFinding['category'], consequence: string): DataQualityFinding {
  return {
    dq_id: `dq-synth-${counter}` as DataQualityFinding['dq_id'],
    category,
    consequence_for_analysis: consequence,
    impact_on_recommendations: [],
  };
}

const NUMBER_REGEX = /-?\d+(?:\.\d+)?(?:%|x)?/g;

function findFabricatedNumbers(fact: Fact, evidence: EvidenceRecord[]): string[] {
  const numbersInStatement = fact.statement.match(NUMBER_REGEX) ?? [];
  if (numbersInStatement.length === 0) return [];

  const cited = evidence.filter((e) => fact.evidence_ids.includes(e.evidence_id));
  const numericContext = cited.flatMap((e) => extractNumbers(e.payload_ref.kind === 'inline' ? e.payload_ref.data : null));
  const numericSet = new Set(numericContext.map((n) => round(n)));

  const fabricated: string[] = [];
  for (const raw of numbersInStatement) {
    const numeric = parseFloat(raw.replace('%', '').replace('x', ''));
    if (Number.isNaN(numeric)) continue;
    if (numericSet.has(round(numeric))) continue;
    // Numbers ≤ 100 may be percentages computed from cited figures —
    // verify presence at one decimal of tolerance.
    let matched = false;
    for (const candidate of numericContext) {
      if (Math.abs(candidate - numeric) < 0.5) {
        matched = true;
        break;
      }
    }
    if (!matched) fabricated.push(raw);
  }
  return fabricated;
}

function extractNumbers(value: unknown): number[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (typeof value === 'string') {
    const matches = value.match(NUMBER_REGEX) ?? [];
    return matches.map((m) => parseFloat(m)).filter((n) => !Number.isNaN(n));
  }
  if (Array.isArray(value)) return value.flatMap(extractNumbers);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(extractNumbers);
  }
  return [];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function hasImperativeRemediation(text: string): boolean {
  // Pattern match for imperative-mode remediation verbs, but skip if the
  // surrounding text uses softening framing ("consider...", "investigate
  // whether...", "review the").
  for (const pattern of IMPERATIVE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const idx = match.index ?? 0;
    const before = text.slice(Math.max(0, idx - 40), idx).toLowerCase();
    if (SOFTENING_TERMS.some((term) => before.includes(term))) continue;
    return true;
  }
  return false;
}
