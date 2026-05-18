import { createHash } from 'node:crypto';

/**
 * Canonicalize a JSON-serializable value into a deterministic string with
 * sorted object keys. Used as the input to the SHA-256 parameter digest
 * so {a:1, b:2} and {b:2, a:1} produce the same fixture key.
 *
 * Encoding rules:
 *  - null, undefined → "null"
 *  - non-finite numbers (NaN, ±Infinity) → "null"
 *  - bigint → decimal digits
 *  - strings → JSON.stringify (handles escaping)
 *  - arrays → preserve order (semantic for parameters)
 *  - objects → sort keys lexicographically
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return 'null';
}

/** Full 64-char hex SHA-256 of the canonicalized parameters. */
export function parameterDigest(parameters: unknown): string {
  return createHash('sha256').update(canonicalize(parameters)).digest('hex');
}

/** First 8 hex chars of a digest, used in fixture filenames for readability. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 8);
}
