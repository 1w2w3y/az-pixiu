import { describe, it, expect } from 'vitest';
import {
  buildCacheCellKey,
  cellFileName,
  computeParametersDigest,
  isValidMonth,
  parseCellFileName,
} from '../../src/billing-cache/cache-key.js';
import type { CostRequestParams } from '../../src/billing-cache/types.js';

const baseParams: CostRequestParams = {
  granularity: 'Daily',
  scope: 'subscription',
  grouping: ['ServiceName'],
};

describe('isValidMonth', () => {
  it('accepts YYYY-MM and rejects everything else', () => {
    expect(isValidMonth('2026-05')).toBe(true);
    expect(isValidMonth('2026-12')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-5')).toBe(false);
    expect(isValidMonth('2026-05-01')).toBe(false);
  });
});

describe('computeParametersDigest', () => {
  it('is stable regardless of grouping order', () => {
    const a = computeParametersDigest({ ...baseParams, grouping: ['ServiceName', 'ResourceType'] });
    const b = computeParametersDigest({ ...baseParams, grouping: ['ResourceType', 'ServiceName'] });
    expect(a).toBe(b);
  });

  it('differs when scope, granularity, or filter differ', () => {
    const base = computeParametersDigest(baseParams);
    expect(computeParametersDigest({ ...baseParams, scope: 'invoice' })).not.toBe(base);
    expect(computeParametersDigest({ ...baseParams, filter: { tag: 'env:prod' } })).not.toBe(base);
  });

  it('produces a 16-char lowercase hex digest', () => {
    expect(computeParametersDigest(baseParams)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes undefined from absent (object) and from null (array) in filter', () => {
    const withUndef = computeParametersDigest({ ...baseParams, filter: { a: 1, b: undefined } });
    const withoutKey = computeParametersDigest({ ...baseParams, filter: { a: 1 } });
    expect(withUndef).not.toBe(withoutKey);

    const arrUndef = computeParametersDigest({ ...baseParams, filter: [1, undefined, 2] });
    const arrNull = computeParametersDigest({ ...baseParams, filter: [1, null, 2] });
    expect(arrUndef).not.toBe(arrNull);
  });
});

describe('buildCacheCellKey / cellFileName / parseCellFileName', () => {
  it('round-trips through the filename grammar', () => {
    const key = buildCacheCellKey({
      subscriptionId: 'sub-a',
      month: '2026-05',
      costView: 'amortized',
      currencyMode: 'normalized_usd',
      params: baseParams,
    });
    const name = cellFileName(key);
    expect(name).toBe(`2026-05.amortized-normalized_usd-${key.parametersDigest}.json`);

    const parsed = parseCellFileName(name);
    expect(parsed).toEqual({
      month: '2026-05',
      costView: 'amortized',
      currencyMode: 'normalized_usd',
      parametersDigest: key.parametersDigest,
    });
  });

  it('rejects an invalid month at key construction', () => {
    expect(() =>
      buildCacheCellKey({
        subscriptionId: 'sub-a',
        month: '2026-5',
        costView: 'actual',
        currencyMode: 'billing',
        params: baseParams,
      }),
    ).toThrow();
  });

  it('rejects a path-unsafe subscription id at key construction', () => {
    for (const subscriptionId of ['../../evil', '..', 'a/b', 'a\\b']) {
      expect(() =>
        buildCacheCellKey({
          subscriptionId,
          month: '2026-05',
          costView: 'amortized',
          currencyMode: 'normalized_usd',
          params: baseParams,
        }),
      ).toThrow();
    }
  });

  it('does not parse temp files or foreign filenames', () => {
    expect(parseCellFileName('2026-05.amortized-normalized_usd-0123456789abcdef.json.tmp-1-2-3')).toBeUndefined();
    expect(parseCellFileName('manifest.json')).toBeUndefined();
    expect(parseCellFileName('2026-05.json')).toBeUndefined();
    expect(parseCellFileName('2026-05.weird-usd-0123456789abcdef.json')).toBeUndefined();
  });
});
