import { describe, it, expect } from 'vitest';
import {
  estimateWeeklyImpactRange,
  rollUpLaneTotal,
  type EstimateResult,
} from '../../src/pricing/impact.js';
import type { PricingRateSource, RateCardEntry } from '../../src/pricing/source.js';

function fakeSource(
  entries: RateCardEntry[],
  capturedAt = '2026-05-23',
): PricingRateSource {
  return {
    lookup({ sku, region }) {
      return (
        entries.find((e) => e.sku === sku && e.region === region) ??
        entries.find((e) => e.sku === sku && e.region === undefined)
      );
    },
    capturedAt: () => capturedAt,
  };
}

const ipEntry: RateCardEntry = {
  sku: 'PublicIPAddress_Standard_Static_IPv4',
  list_price_weekly_usd: 0.84,
  source_url: 'https://example.com/pricing/ip',
};

describe('estimateWeeklyImpactRange', () => {
  it('returns a ±10% range around count × list_price by default', () => {
    const source = fakeSource([ipEntry]);
    const result = estimateWeeklyImpactRange({
      count: 100,
      sku: ipEntry.sku,
      rateSource: source,
    });
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.point_usd).toBe(84.0);
    expect(result.low_usd).toBe(75.6);
    expect(result.high_usd).toBe(92.4);
  });

  it('honours a custom rangePercent', () => {
    const source = fakeSource([ipEntry]);
    const result = estimateWeeklyImpactRange({
      count: 10,
      sku: ipEntry.sku,
      rateSource: source,
      rangePercent: 0.25,
    });
    if (result.kind !== 'available') throw new Error('expected available');
    expect(result.point_usd).toBe(8.4);
    expect(result.low_usd).toBe(6.3);
    expect(result.high_usd).toBe(10.5);
  });

  it('propagates source_url and captured_at from the rate card', () => {
    const source = fakeSource([ipEntry], '2026-04-01');
    const result = estimateWeeklyImpactRange({
      count: 1,
      sku: ipEntry.sku,
      rateSource: source,
    });
    if (result.kind !== 'available') throw new Error('expected available');
    expect(result.source_url).toBe(ipEntry.source_url);
    expect(result.captured_at).toBe('2026-04-01');
  });

  it('returns unavailable when the SKU is not in the rate card', () => {
    const source = fakeSource([ipEntry]);
    const result = estimateWeeklyImpactRange({
      count: 5,
      sku: 'Unknown_SKU',
      rateSource: source,
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toBe('sku_not_in_rate_card');
    expect(result.count).toBe(5);
    expect(result.sku).toBe('Unknown_SKU');
  });

  it('handles count = 0 by returning a zero-width range', () => {
    const source = fakeSource([ipEntry]);
    const result = estimateWeeklyImpactRange({
      count: 0,
      sku: ipEntry.sku,
      rateSource: source,
    });
    if (result.kind !== 'available') throw new Error('expected available');
    expect(result.point_usd).toBe(0);
    expect(result.low_usd).toBe(0);
    expect(result.high_usd).toBe(0);
  });

  it('throws RangeError on negative count', () => {
    const source = fakeSource([ipEntry]);
    expect(() =>
      estimateWeeklyImpactRange({ count: -1, sku: ipEntry.sku, rateSource: source }),
    ).toThrow(RangeError);
  });

  it('forwards region into the lookup', () => {
    const regional: RateCardEntry = {
      sku: ipEntry.sku,
      region: 'westeurope',
      list_price_weekly_usd: 0.92,
      source_url: 'https://example.com/pricing/ip',
    };
    const source = fakeSource([ipEntry, regional]);
    const result = estimateWeeklyImpactRange({
      count: 10,
      sku: ipEntry.sku,
      region: 'westeurope',
      rateSource: source,
    });
    if (result.kind !== 'available') throw new Error('expected available');
    expect(result.point_usd).toBe(9.2);
    expect(result.region).toBe('westeurope');
  });
});

describe('rollUpLaneTotal', () => {
  it('sums only available estimates and counts unavailable ones', () => {
    const estimates: EstimateResult[] = [
      {
        kind: 'available',
        low_usd: 75.6,
        high_usd: 92.4,
        point_usd: 84,
        count: 100,
        sku: 'A',
        source_url: 'https://example.com',
        captured_at: '2026-05-23',
      },
      {
        kind: 'available',
        low_usd: 10,
        high_usd: 14,
        point_usd: 12,
        count: 2,
        sku: 'B',
        source_url: 'https://example.com',
        captured_at: '2026-05-23',
      },
      {
        kind: 'unavailable',
        reason: 'sku_not_in_rate_card',
        count: 3,
        sku: 'C',
      },
    ];
    const total = rollUpLaneTotal(estimates);
    expect(total.low_usd).toBe(85.6);
    expect(total.high_usd).toBe(106.4);
    expect(total.point_usd).toBe(96);
    expect(total.available_count).toBe(2);
    expect(total.unavailable_count).toBe(1);
    expect(total.unavailable_skus).toEqual([{ sku: 'C' }]);
  });

  it('de-duplicates unavailable SKUs by (sku, region) pair', () => {
    const estimates: EstimateResult[] = [
      { kind: 'unavailable', reason: 'sku_not_in_rate_card', count: 1, sku: 'C' },
      { kind: 'unavailable', reason: 'sku_not_in_rate_card', count: 1, sku: 'C' },
      { kind: 'unavailable', reason: 'sku_not_in_rate_card', count: 1, sku: 'C', region: 'eastus' },
    ];
    const total = rollUpLaneTotal(estimates);
    expect(total.unavailable_count).toBe(3);
    expect(total.unavailable_skus).toEqual([{ sku: 'C' }, { sku: 'C', region: 'eastus' }]);
  });

  it('handles an empty list', () => {
    const total = rollUpLaneTotal([]);
    expect(total.point_usd).toBe(0);
    expect(total.available_count).toBe(0);
    expect(total.unavailable_count).toBe(0);
    expect(total.unavailable_skus).toEqual([]);
  });
});
