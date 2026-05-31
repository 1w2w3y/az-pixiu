import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Filesystem-backed cache for billing-access probe outcomes.
 *
 * The probe issues a tiny `amgmcp_cost_analysis` call against each
 * candidate subscription to verify it has Cost Management read access
 * before discovery selects it. That call is cheap but not free, and the
 * outcome is stable for hours at a time — caching it avoids re-paying
 * the probe latency on every run while keeping the freshness story
 * honest:
 *
 *   - `pass` entries live for 6 hours. The subscription has billing
 *     read access today; that's unlikely to evaporate in the next few
 *     hours.
 *   - `denied` / `transient` / `unknown` entries live for 30 minutes.
 *     If an operator just granted Cost Management Reader, the next run
 *     should surface it quickly rather than waiting out the long TTL.
 *
 * The cache key bundles the AMG-MCP endpoint hash and a coarse
 * identity hint so a single shared cache file is safe to use across
 * multiple endpoints and credential modes — entries do not bleed
 * across boundaries. The identity hint is deliberately coarse (env
 * var or `'default'`); the cache is not a security boundary.
 *
 * All filesystem failures are non-fatal: a cache that cannot be read
 * or written degrades to "no cache for this run" rather than failing
 * discovery. The probe still runs; the operator just pays the probe
 * latency.
 */

export type ProbeOutcome = 'pass' | 'denied' | 'transient' | 'unknown';

export interface CacheEntry {
  outcome: ProbeOutcome;
  classification?: string;
  message?: string;
  cachedAt: string;
  expiresAt: string;
}

export interface BillingProbeCacheOptions {
  /** Custom cache file path. Defaults to ~/.az-pixiu/billing-probe-cache.json. */
  path?: string;
  /** AMG-MCP endpoint — hashed into the cache key so entries do not cross endpoints. */
  endpoint: string;
  /** Coarse identity hint. Falls back to `'default'` when omitted. */
  identityHint?: string;
  /** Disable the cache entirely (read-through is empty; writes are no-ops). */
  enabled?: boolean;
  /** Override the clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const PASS_TTL_MS = 6 * 60 * 60 * 1000;
const NONPASS_TTL_MS = 30 * 60 * 1000;

export function defaultCachePath(): string {
  return join(homedir(), '.az-pixiu', 'billing-probe-cache.json');
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/**
 * Atomic filesystem cache. Read-load-merge-write-rename so a concurrent
 * pixiu run cannot tear the file. Atomicity is best-effort — the only
 * cross-process invariant we rely on is `rename(tmp, real)` being
 * atomic per POSIX. Multiple concurrent writes still race for the last
 * rename, but neither corrupts the file.
 */
export class BillingProbeCache {
  private readonly path: string;
  private readonly partition: string;
  private readonly enabled: boolean;
  private readonly clock: () => number;

  constructor(options: BillingProbeCacheOptions) {
    this.path = options.path ?? defaultCachePath();
    const endpointHash = hashEndpoint(options.endpoint);
    const identity = options.identityHint ?? 'default';
    this.partition = `${endpointHash}::${identity}`;
    this.enabled = options.enabled ?? true;
    this.clock = options.now ?? Date.now;
  }

  /**
   * Look up a non-expired entry for `subscriptionId`. Returns
   * `undefined` when the cache is disabled, the file is missing, the
   * entry is absent, or the entry has expired.
   */
  async get(subscriptionId: string): Promise<CacheEntry | undefined> {
    if (!this.enabled) return undefined;
    const file = await this.readFile();
    if (!file) return undefined;
    const key = `${this.partition}::${subscriptionId}`;
    const entry = file.entries[key];
    if (!entry) return undefined;
    if (Date.parse(entry.expiresAt) <= this.clock()) return undefined;
    return entry;
  }

  /**
   * Persist an outcome. Splits the TTL by outcome (see file docstring).
   * Failures are swallowed and emitted via `onWarning` if supplied.
   */
  async set(
    subscriptionId: string,
    payload: { outcome: ProbeOutcome; classification?: string; message?: string },
    onWarning?: (msg: string) => void,
  ): Promise<void> {
    if (!this.enabled) return;
    const now = this.clock();
    const ttl = payload.outcome === 'pass' ? PASS_TTL_MS : NONPASS_TTL_MS;
    const entry: CacheEntry = {
      outcome: payload.outcome,
      ...(payload.classification ? { classification: payload.classification } : {}),
      ...(payload.message ? { message: payload.message.slice(0, 500) } : {}),
      cachedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    const key = `${this.partition}::${subscriptionId}`;
    try {
      const existing = (await this.readFile()) ?? { version: 1 as const, entries: {} };
      existing.entries[key] = entry;
      pruneExpired(existing, now);
      await this.writeAtomic(existing);
    } catch (err) {
      onWarning?.(`billing-probe-cache write failed: ${describe(err)}`);
    }
  }

  /** Path the cache reads/writes (useful for diagnostics and tests). */
  filePath(): string {
    return this.path;
  }

  private async readFile(): Promise<CacheFile | undefined> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { entries?: unknown }).entries === 'object'
      ) {
        return parsed as CacheFile;
      }
      return undefined;
    } catch (err) {
      // ENOENT (no cache yet) and parse errors (corruption) both degrade
      // to "no cached entries"; the next set() rewrites a clean file.
      if (isNotFound(err)) return undefined;
      return undefined;
    }
  }

  private async writeAtomic(file: CacheFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const serialized = JSON.stringify(file, null, 2) + '\n';
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, serialized, { encoding: 'utf8', flag: 'w' });
    await rename(tmp, this.path);
  }
}

function pruneExpired(file: CacheFile, now: number): void {
  for (const [key, entry] of Object.entries(file.entries)) {
    if (Date.parse(entry.expiresAt) <= now) delete file.entries[key];
  }
}

function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
