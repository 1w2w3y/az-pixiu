/**
 * Shared imperative-remediation detector for read-only enforcement
 * (design §12 layer 5; §17 verification "read-only adherence").
 *
 * Used by both the reasoner post-processor (which drops violating
 * recommendations and synthesizes a data-quality finding) and the
 * evaluation scoring rubric. Centralizing the patterns and softening
 * logic in one place prevents the two callers from drifting apart.
 */

export const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  /\b(delete|drop|terminate|kill|destroy)\b/i,
  /\b(scale (?:down|up)|resize)\s+\w/i,
  /\b(restart|stop|reboot)\b/i,
  /\b(run|execute|invoke|apply)\s+(?:kubectl|az|terraform|the\s+command)/i,
];

export const SOFTENING_TERMS: readonly string[] = [
  'consider',
  'review',
  'investigate',
  'examine',
  'evaluate',
  'assess',
  'compare',
  'whether',
];

export interface ImperativeMatch {
  matched: true;
  phrase: string;
}

export interface ImperativeNoMatch {
  matched: false;
}

export type ImperativeResult = ImperativeMatch | ImperativeNoMatch;

/**
 * Detect bare imperative-remediation phrasing in a sentence.
 *
 * "Bare" means: an imperative verb appears AND no softening framing
 * appears anywhere in the same sentence. So:
 *   - "delete the orphaned snapshot" → matched
 *   - "consider whether to delete the orphaned snapshot" → not matched
 *
 * The check is sentence-wide rather than fixed-width lookback because
 * the softening word can come anywhere — "to delete X, consider Y" is
 * still framed as a question, not a command.
 */
export function detectImperativeRemediation(text: string): ImperativeResult {
  const lower = text.toLowerCase();
  for (const pattern of IMPERATIVE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (SOFTENING_TERMS.some((term) => lower.includes(term))) continue;
    return { matched: true, phrase: match[0] };
  }
  return { matched: false };
}
