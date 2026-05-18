import type { ConfidenceDimensions, ConfidenceLevel } from './schemas/index.js';

/**
 * Deterministic derivation of the confidence headline from structured
 * dimensions. Per design §9 / §7.5, this runs after the LLM emits a
 * Confidence object and overrides the LLM-provided level. The LLM
 * cannot claim a higher confidence than its own dimensions justify.
 *
 * Rules:
 *   - high   ⟺ coverage = strong AND quality = strong AND agreement = aligned
 *   - low    ⟺ any of (coverage = partial, quality = weak, agreement = conflicting)
 *   - medium otherwise
 */
export function deriveConfidenceLevel(dimensions: ConfidenceDimensions): ConfidenceLevel {
  const { evidence_coverage, signal_quality, signal_agreement } = dimensions;

  if (
    evidence_coverage === 'partial' ||
    signal_quality === 'weak' ||
    signal_agreement === 'conflicting'
  ) {
    return 'low';
  }

  if (
    evidence_coverage === 'strong' &&
    signal_quality === 'strong' &&
    signal_agreement === 'aligned'
  ) {
    return 'high';
  }

  return 'medium';
}
