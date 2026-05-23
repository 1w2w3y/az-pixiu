import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  isEmptyResult,
  FAILURE_CATEGORIES,
} from '../../src/failure/taxonomy.js';
import {
  CapabilityNotAllowedError,
  DiscoveryNotPerformedError,
} from '../../src/mcp/client.js';
import { FixtureError, FixtureNotFoundError } from '../../src/mcp/fixture.js';

const ctx = { capability: 'cost_analysis' };

describe('classifyFailure — specific error classes', () => {
  it('CapabilityNotAllowedError → unsupported_capability', () => {
    const err = new CapabilityNotAllowedError('cost_analysis', 'reason');
    const f = classifyFailure(err, ctx);
    expect(f.category).toBe('unsupported_capability');
    expect(f.capability).toBe('cost_analysis');
    expect(f.cause).toBe(err);
  });

  it('FixtureNotFoundError → unsupported_capability with parameter-digest in message', () => {
    const err = new FixtureNotFoundError('cost_analysis', '0'.repeat(64), '/tmp/fixture');
    const f = classifyFailure(err, ctx);
    expect(f.category).toBe('unsupported_capability');
    expect(f.message).toMatch(/0{16}/);
  });

  it('FixtureError → schema_mismatch', () => {
    const err = new FixtureError('payload missing');
    const f = classifyFailure(err, ctx);
    expect(f.category).toBe('schema_mismatch');
  });

  it('DiscoveryNotPerformedError is re-thrown (programming error, not a DQ finding)', () => {
    const err = new DiscoveryNotPerformedError();
    expect(() => classifyFailure(err, ctx)).toThrow(DiscoveryNotPerformedError);
  });
});

describe('classifyFailure — HTTP status codes', () => {
  const cases: Array<[number, string]> = [
    [401, 'auth'],
    [403, 'authz_gap'],
    [404, 'unsupported_capability'],
    [408, 'timeout'],
    // 502 (Bad Gateway) and 503 (Service Unavailable) are treated as
    // timeout-class on the read-only Azure surface — both are transient
    // upstream conditions retriable with the same backoff strategy.
    // Asserted explicitly so a future refactor cannot silently demote
    // them to schema_mismatch / other (which is_RetriableCategory does
    // not cover).
    [502, 'timeout'],
    [503, 'timeout'],
    [504, 'timeout'],
    [429, 'rate_limit'],
    [400, 'invalid_scope'],
    [422, 'invalid_scope'],
  ];

  it.each(cases)('HTTP %i → %s', (status, category) => {
    const err = Object.assign(new Error(`status ${status}`), { status });
    expect(classifyFailure(err, ctx).category).toBe(category);
  });

  it('reads statusCode property as a synonym for status', () => {
    const err = Object.assign(new Error('rate-limited'), { statusCode: 429 });
    expect(classifyFailure(err, ctx).category).toBe('rate_limit');
  });

  it('reads response.status (axios/fetch-style)', () => {
    const err = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    expect(classifyFailure(err, ctx).category).toBe('authz_gap');
  });
});

describe('classifyFailure — message substring fallback', () => {
  it.each([
    ['Request timed out after 30s', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['Operation was aborted', 'timeout'],
    ['Rate limit exceeded', 'rate_limit'],
    ['Throttled by upstream', 'rate_limit'],
    ['Unauthorized: missing bearer', 'auth'],
    ['Forbidden — insufficient permissions', 'authz_gap'],
    ['Tool not found', 'unsupported_capability'],
    ['Empty result for query', 'empty_result'],
  ])('message %j → %s', (msg, category) => {
    expect(classifyFailure(new Error(msg), ctx).category).toBe(category);
  });
});

describe('classifyFailure — default', () => {
  it('unrecognized error → schema_mismatch with maintainer hint', () => {
    const f = classifyFailure(new Error('something strange happened'), ctx);
    expect(f.category).toBe('schema_mismatch');
    expect(f.actionable_hint).toMatch(/capability version drift/i);
  });

  it('non-Error inputs are stringified safely', () => {
    expect(classifyFailure({ weird: 'shape' }, ctx).category).toBe('schema_mismatch');
    expect(classifyFailure('plain string', ctx).category).toBe('schema_mismatch');
    expect(classifyFailure(42, ctx).category).toBe('schema_mismatch');
    expect(classifyFailure(null, ctx).category).toBe('schema_mismatch');
  });
});

describe('classifyFailure + isRetriableCategory — 502/503 are retriable transient-upstream errors', () => {
  it('502/503/504 all map to retriable categories', async () => {
    const { isRetriableCategory } = await import('../../src/evidence/retry-policy.js');
    for (const status of [502, 503, 504]) {
      const err = Object.assign(new Error(`status ${status}`), { status });
      const classified = classifyFailure(err, ctx);
      expect(classified.category).toBe('timeout');
      expect(isRetriableCategory(classified.category)).toBe(true);
    }
  });
});

describe('FAILURE_CATEGORIES enumeration', () => {
  it('matches exactly the eight design-specified classes', () => {
    expect([...FAILURE_CATEGORIES].sort()).toEqual([
      'auth',
      'authz_gap',
      'empty_result',
      'invalid_scope',
      'rate_limit',
      'schema_mismatch',
      'timeout',
      'unsupported_capability',
    ]);
  });
});

describe('isEmptyResult', () => {
  it.each([
    [null, true],
    [undefined, true],
    ['', true],
    [[], true],
    [{}, true],
    [{ rows: [] }, true],
    [{ data: [] }, true],
    [{ entries: [] }, true],
    [{ count: 0 }, true],
  ])('treats %j as empty', (input, expected) => {
    expect(isEmptyResult(input)).toBe(expected);
  });

  it.each([
    'has content',
    [1, 2, 3],
    { rows: [['a', 1]] },
    { count: 5 },
    { data: [{ id: 'a' }] },
  ])('treats %j as non-empty', (input) => {
    expect(isEmptyResult(input)).toBe(false);
  });
});
