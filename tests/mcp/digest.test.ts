import { describe, it, expect } from 'vitest';
import { canonicalize, parameterDigest, shortDigest } from '../../src/mcp/digest.js';

describe('canonicalize', () => {
  it('encodes primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('encodes non-finite numbers as null', () => {
    expect(canonicalize(NaN)).toBe('null');
    expect(canonicalize(Infinity)).toBe('null');
    expect(canonicalize(-Infinity)).toBe('null');
  });

  it('encodes bigint as decimal', () => {
    expect(canonicalize(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([3, 2, 1])).toBe('[3,2,1]');
  });

  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalize({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it('canonicalizes nested objects recursively', () => {
    expect(canonicalize({ outer: { b: 2, a: 1 }, x: [3, { d: 4, c: 3 }] })).toBe(
      '{"outer":{"a":1,"b":2},"x":[3,{"c":3,"d":4}]}',
    );
  });

  it('escapes string quotes correctly', () => {
    expect(canonicalize('she said "hi"')).toBe('"she said \\"hi\\""');
  });
});

describe('parameterDigest', () => {
  it('produces a 64-char hex string', () => {
    const d = parameterDigest({ a: 1 });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const params = { subscription_id: 'abc', granularity: 'Daily' };
    expect(parameterDigest(params)).toBe(parameterDigest(params));
  });

  it('ignores object key order', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, y: 2, x: 1 };
    expect(parameterDigest(a)).toBe(parameterDigest(b));
  });

  it('ignores nested object key order', () => {
    const a = { outer: { a: 1, b: 2 }, list: [{ c: 3, d: 4 }] };
    const b = { list: [{ d: 4, c: 3 }], outer: { b: 2, a: 1 } };
    expect(parameterDigest(a)).toBe(parameterDigest(b));
  });

  it('distinguishes different parameter sets', () => {
    expect(parameterDigest({ a: 1 })).not.toBe(parameterDigest({ a: 2 }));
  });

  it('treats array order as significant', () => {
    expect(parameterDigest({ tags: ['a', 'b'] })).not.toBe(parameterDigest({ tags: ['b', 'a'] }));
  });

  it('treats null and undefined as identical', () => {
    expect(parameterDigest({ x: null })).toBe(parameterDigest({ x: undefined }));
  });

  it('distinguishes empty object from object with null field', () => {
    expect(parameterDigest({})).not.toBe(parameterDigest({ x: null }));
  });
});

describe('shortDigest', () => {
  it('takes the first 8 hex chars', () => {
    expect(shortDigest('a1b2c3d4e5f6789012345678')).toBe('a1b2c3d4');
  });

  it('produces the same prefix for the same digest', () => {
    const d = parameterDigest({ z: 1 });
    expect(shortDigest(d)).toHaveLength(8);
    expect(shortDigest(d)).toBe(d.slice(0, 8));
  });
});
