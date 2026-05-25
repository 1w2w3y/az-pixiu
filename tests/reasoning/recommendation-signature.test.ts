import { describe, it, expect } from 'vitest';
import { computeRecommendationSignature } from '../../src/reasoning/recommendation-signature.js';

describe('computeRecommendationSignature', () => {
  describe('structured parts (Phase 3 lane path)', () => {
    it('joins lane + cluster_prefix + dominant_sku with `--`', () => {
      expect(
        computeRecommendationSignature({
          lane: 'orphan-ip-cleanup',
          cluster_prefix: 'liftrtools',
          dominant_sku: 'standard',
        }),
      ).toBe('orphan-ip-cleanup--liftrtools--standard');
    });

    it('fills missing structured parts with `none` rather than collapsing the slot', () => {
      expect(
        computeRecommendationSignature({
          lane: 'restored-pg-cleanup',
          dominant_sku: 'standard-d4ds-v5',
        }),
      ).toBe('restored-pg-cleanup--none--standard-d4ds-v5');
    });

    it('produces the same signature for the same structured inputs (determinism)', () => {
      const a = computeRecommendationSignature({
        lane: 'orphan-ip-cleanup',
        cluster_prefix: 'devrp',
        dominant_sku: 'standard',
      });
      const b = computeRecommendationSignature({
        lane: 'orphan-ip-cleanup',
        cluster_prefix: 'devrp',
        dominant_sku: 'standard',
      });
      expect(a).toBe(b);
    });

    it('normalises case and separators (uppercase, spaces, underscores, mixed punctuation)', () => {
      expect(
        computeRecommendationSignature({
          lane: 'Orphan IP Cleanup',
          cluster_prefix: 'LiftrTools_RG',
          dominant_sku: 'Standard.v2',
        }),
      ).toBe('orphan-ip-cleanup--liftrtools-rg--standard-v2');
    });
  });

  describe('fallback_slug (v1 LLM path)', () => {
    it('returns the slug normalised', () => {
      expect(computeRecommendationSignature({ fallback_slug: 'restored-pg-cleanup-eus2' })).toBe(
        'restored-pg-cleanup-eus2',
      );
    });

    it('normalises an LLM-emitted slug with awkward casing or punctuation', () => {
      expect(
        computeRecommendationSignature({ fallback_slug: 'Restored_PG Cleanup -- EUS2' }),
      ).toBe('restored-pg-cleanup-eus2');
    });

    it('throws when the fallback normalises to an empty string', () => {
      expect(() => computeRecommendationSignature({ fallback_slug: '---' })).toThrow(
        /empty signature/,
      );
    });
  });

  describe('error cases', () => {
    it('throws when no inputs are supplied', () => {
      expect(() => computeRecommendationSignature({})).toThrow(/must be supplied/);
    });
  });
});
