import { describe, it, expect } from 'vitest';
import {
  evaluateMaturity,
  monthBillingPeriod,
} from '../../src/billing-cache/maturity.js';
import { DEFAULT_MATURITY_POLICY } from '../../src/billing-cache/types.js';

describe('monthBillingPeriod', () => {
  it('returns the calendar month as a UTC half-open interval', () => {
    expect(monthBillingPeriod('2026-05')).toEqual({
      start: '2026-05-01T00:00:00.000Z',
      end: '2026-06-01T00:00:00.000Z',
    });
  });

  it('rolls the year over at December', () => {
    expect(monthBillingPeriod('2026-12')).toEqual({
      start: '2026-12-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    });
  });

  it('rejects a malformed month', () => {
    expect(() => monthBillingPeriod('2026-13')).toThrow();
    expect(() => monthBillingPeriod('2026-5')).toThrow();
    expect(() => monthBillingPeriod('not-a-month')).toThrow();
  });
});

describe('evaluateMaturity', () => {
  // May 2026 ends 2026-06-01T00:00:00Z; +5 days => boundary 2026-06-06T00:00:00Z.
  const boundaryMs = Date.parse('2026-06-06T00:00:00Z');

  it('is not_mature one minute before the UTC stabilization boundary', () => {
    const d = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      now: () => boundaryMs - 60_000,
    });
    expect(d.status).toBe('not_mature');
    expect(d.cacheable).toBe(false);
    expect(d.became_cacheable_on).toBe('2026-06-06');
  });

  it('is usage_stable exactly at the boundary', () => {
    const d = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      now: () => boundaryMs,
    });
    expect(d.status).toBe('usage_stable');
    expect(d.cacheable).toBe(true);
  });

  it('is usage_stable one minute after the boundary', () => {
    const d = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      now: () => boundaryMs + 60_000,
    });
    expect(d.status).toBe('usage_stable');
    expect(d.cacheable).toBe(true);
  });

  it('reproduces "the 5th of the following month" for the calendar case', () => {
    // June 2026 becomes cacheable 2026-07-06.
    const before = evaluateMaturity({
      month: '2026-06',
      costView: 'actual',
      now: () => Date.parse('2026-07-05T23:59:00Z'),
    });
    const after = evaluateMaturity({
      month: '2026-06',
      costView: 'actual',
      now: () => Date.parse('2026-07-06T00:00:00Z'),
    });
    expect(before.status).toBe('not_mature');
    expect(after.status).toBe('usage_stable');
    expect(after.became_cacheable_on).toBe('2026-07-06');
  });

  it('flags late_adjustment_possible until the invoice-close horizon passes', () => {
    // horizon = period end (2026-06-01) + 2 months = 2026-08-01.
    const inside = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      now: () => Date.parse('2026-07-31T00:00:00Z'),
    });
    const outside = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      now: () => Date.parse('2026-08-01T00:00:00Z'),
    });
    expect(inside.late_adjustment_possible).toBe(true);
    expect(outside.late_adjustment_possible).toBe(false);
  });

  it('honors a custom stabilization offset', () => {
    const policy = { ...DEFAULT_MATURITY_POLICY, stabilizationOffsetDays: 10 };
    const d = evaluateMaturity({
      month: '2026-05',
      costView: 'amortized',
      policy,
      now: () => Date.parse('2026-06-08T00:00:00Z'),
    });
    expect(d.status).toBe('not_mature');
    expect(d.became_cacheable_on).toBe('2026-06-11');
  });

  it('carries the requested cost view through to the decision', () => {
    const actual = evaluateMaturity({
      month: '2026-05',
      costView: 'actual',
      now: () => boundaryMs,
    });
    expect(actual.cost_view).toBe('actual');
  });

  it('rolls the invoice-close horizon across a year boundary for December', () => {
    // Dec 2026 ends 2027-01-01; +5 days => became_cacheable_on 2027-01-06;
    // horizon = period end + 2 months => 2027-03-01.
    const inside = evaluateMaturity({
      month: '2026-12',
      costView: 'amortized',
      now: () => Date.parse('2027-02-28T23:59:00Z'),
    });
    const outside = evaluateMaturity({
      month: '2026-12',
      costView: 'amortized',
      now: () => Date.parse('2027-03-01T00:00:00Z'),
    });
    expect(inside.became_cacheable_on).toBe('2027-01-06');
    expect(inside.late_adjustment_possible).toBe(true);
    expect(outside.late_adjustment_possible).toBe(false);
  });

  it('rejects sub-1000 years that Date.UTC would silently alias', () => {
    expect(() => evaluateMaturity({ month: '0050-06', costView: 'amortized', now: () => 0 })).toThrow();
    expect(() => monthBillingPeriod('0050-06')).toThrow();
  });
});
