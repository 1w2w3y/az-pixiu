import { describe, it, expect } from 'vitest';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  isRetriableCategory,
} from '../../src/evidence/retry-policy.js';

describe('isRetriableCategory', () => {
  it('retries rate_limit and timeout', () => {
    expect(isRetriableCategory('rate_limit')).toBe(true);
    expect(isRetriableCategory('timeout')).toBe(true);
  });

  it('does not retry auth, authz_gap, invalid_scope, schema_mismatch, empty_result, unsupported_capability', () => {
    expect(isRetriableCategory('auth')).toBe(false);
    expect(isRetriableCategory('authz_gap')).toBe(false);
    expect(isRetriableCategory('invalid_scope')).toBe(false);
    expect(isRetriableCategory('schema_mismatch')).toBe(false);
    expect(isRetriableCategory('empty_result')).toBe(false);
    expect(isRetriableCategory('unsupported_capability')).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('doubles exponentially with retry index, zero-jitter case', () => {
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, 0)).toBe(30_000);
    expect(computeBackoffMs(1, DEFAULT_RETRY_POLICY, 0)).toBe(60_000);
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 0)).toBe(120_000);
  });

  it('caps the full exponential+jitter delay at maxDelayMs', () => {
    // retryIndex 3 → 30s * 2^3 = 240s, capped at 180s even before jitter.
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, 0)).toBe(180_000);
    expect(computeBackoffMs(10, DEFAULT_RETRY_POLICY, 0)).toBe(180_000);
    // retryIndex 2 → exp 120s + 30s jitter = 150s, under the cap.
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, 30_000)).toBe(150_000);
    // retryIndex 2 with the maximum allowed jitter still fits under cap.
    // retryIndex 3 (240s exp) + any jitter is clamped to the cap, not
    // 180s + jitter (the previous contract, which the PR body got wrong).
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, 30_000)).toBe(180_000);
  });

  it('clamps a negative jitter to 0 and an over-large jitter to jitterMs', () => {
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, -1000)).toBe(30_000);
    // Over-large jitter is clamped to jitterMs (30s), so retryIndex 0
    // returns 30s exp + 30s clamped jitter = 60s (still under 180s cap).
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, 999_999)).toBe(60_000);
  });

  it('adds the jitter on top of the exponential portion when both fit under the cap', () => {
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, 5_000)).toBe(35_000);
  });
});
