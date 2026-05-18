import { describe, it, expect } from 'vitest';
import { deriveConfidenceLevel } from '../src/confidence.js';
import type { ConfidenceDimensions } from '../src/schemas/index.js';

function dims(
  evidence_coverage: ConfidenceDimensions['evidence_coverage'],
  signal_quality: ConfidenceDimensions['signal_quality'],
  signal_agreement: ConfidenceDimensions['signal_agreement'],
): ConfidenceDimensions {
  return { evidence_coverage, signal_quality, signal_agreement };
}

describe('deriveConfidenceLevel (design §9)', () => {
  describe('high', () => {
    it('all three dimensions at the strongest tier → high', () => {
      expect(deriveConfidenceLevel(dims('strong', 'strong', 'aligned'))).toBe('high');
    });
  });

  describe('low', () => {
    it('partial coverage forces low regardless of other dimensions', () => {
      expect(deriveConfidenceLevel(dims('partial', 'strong', 'aligned'))).toBe('low');
    });

    it('weak signal_quality forces low regardless of other dimensions', () => {
      expect(deriveConfidenceLevel(dims('strong', 'weak', 'aligned'))).toBe('low');
    });

    it('conflicting signal_agreement forces low regardless of other dimensions', () => {
      expect(deriveConfidenceLevel(dims('strong', 'strong', 'conflicting'))).toBe('low');
    });

    it('multiple low-tier dimensions still resolve to low', () => {
      expect(deriveConfidenceLevel(dims('partial', 'weak', 'conflicting'))).toBe('low');
    });
  });

  describe('medium', () => {
    it('adequate + mixed + mixed → medium (no rule fires for high or low)', () => {
      expect(deriveConfidenceLevel(dims('adequate', 'mixed', 'mixed'))).toBe('medium');
    });

    it('adequate + strong + aligned → medium (coverage short of strong)', () => {
      expect(deriveConfidenceLevel(dims('adequate', 'strong', 'aligned'))).toBe('medium');
    });

    it('strong + mixed + aligned → medium (quality short of strong)', () => {
      expect(deriveConfidenceLevel(dims('strong', 'mixed', 'aligned'))).toBe('medium');
    });

    it('strong + strong + mixed → medium (agreement short of aligned)', () => {
      expect(deriveConfidenceLevel(dims('strong', 'strong', 'mixed'))).toBe('medium');
    });
  });

  describe('low takes precedence over high', () => {
    // If ever a dimension combination could trigger both rules
    // (it can't with current definitions, but the implementation
    // should remain robust), low should win to avoid over-confidence.
    it('partial + strong + aligned → low, not high', () => {
      expect(deriveConfidenceLevel(dims('partial', 'strong', 'aligned'))).toBe('low');
    });
  });

  describe('deterministic — same inputs always produce same output', () => {
    it('repeated calls with identical inputs produce identical outputs', () => {
      const d = dims('adequate', 'mixed', 'mixed');
      expect(deriveConfidenceLevel(d)).toBe(deriveConfidenceLevel(d));
      expect(deriveConfidenceLevel(d)).toBe('medium');
    });
  });
});
