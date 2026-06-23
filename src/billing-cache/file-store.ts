/**
 * Filesystem-backed store for the local billing cache.
 *
 * Mirrors {@link ../run/billing-probe-cache.ts} for everything that
 * already works there — `~/.az-pixiu` root, atomic temp-file-then-rename
 * writes, endpoint-plus-identity partitioning, degrade-to-miss on any
 * filesystem failure — and diverges only where billing data demands more:
 *
 *   - a file tree (one cell per file) instead of one flat map;
 *   - a manifest index that is a *rebuildable, non-authoritative* derived
 *     view, never a transaction log — the per-cell files are the source of
 *     truth, so a torn manifest costs at most a re-query, never a wrong
 *     answer;
 *   - restrictive 0700/0600 permissions, because the probe cache sets no
 *     mode and there is nothing secure to inherit;
 *   - a non-silent read-path state machine (corrupt / schema_mismatch /
 *     identity_mismatch / integrity_mismatch) so a bad file becomes a miss
 *     plus a finding rather than a silent drop.
 *
 * See docs/design/local-billing-cache.md.
 */

import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BillingCacheRecordSchema,
  CACHE_SCHEMA_VERSION,
  ManifestSchema,
  MANIFEST_SCHEMA_VERSION,
} from './schema.js';
import type {
  BillingCacheManifest,
  BillingCacheManifestEntry,
  BillingCacheRecord,
} from './schema.js';
import type { CacheCellKey, CostView, CurrencyMode } from './types.js';
import { cellFileName, digest16, parseCellFileName } from './cache-key.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Default cache root: ~/.az-pixiu/billing-cache/v1 */
export function defaultBillingCacheRoot(): string {
  return join(homedir(), '.az-pixiu', 'billing-cache', 'v1');
}

/**
 * Outcome of a single cache read. `digest_mismatch` is reserved for the
 * cost-evidence provider's key-equality check; a path-based lookup here
 * surfaces a differently-parameterized cell as a plain `miss` (different
 * filename), so the file store never emits it.
 */
export type CacheReadStatus =
  | 'hit'
  | 'miss'
  | 'corrupt'
  | 'schema_mismatch'
  | 'identity_mismatch'
  | 'digest_mismatch'
  | 'integrity_mismatch';

export interface CacheReadResult {
  status: CacheReadStatus;
  record?: BillingCacheRecord;
  warning?: string;
}

export interface CachedCellRef {
  subscriptionId: string;
  month: string;
  costView: CostView;
  currencyMode: CurrencyMode;
  parametersDigest: string;
  /** Relative path under the partition root (posix-style). */
  file: string;
}

export interface FileBillingCacheStoreOptions {
  /** Cache root. Defaults to {@link defaultBillingCacheRoot}. */
  root?: string;
  /** AMG-MCP endpoint — the partition discriminator; cells never cross endpoints. */
  endpoint: string;
  /**
   * Optional *resolved* principal identity to scope the partition by, for
   * callers that genuinely know who is authenticated. NEVER the auth
   * credential mode (azure-cli / mock) — a mode is not an identity. When
   * omitted (the CLI default) the cache partitions by endpoint alone.
   */
  identityHint?: string;
  /** Disable the cache (reads miss, writes are no-ops). */
  enabled?: boolean;
  /** Injected clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Sink for non-fatal warnings (corruption, manifest drift, fs failures). */
  onWarning?: (msg: string) => void;
}

export class BillingCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingCacheError';
  }
}

export class FileBillingCacheStore {
  private readonly partitionDir: string;
  private readonly manifestPath: string;
  private readonly endpointHashValue: string;
  private readonly rootIdentity: string;
  private readonly enabled: boolean;
  private readonly clock: () => number;
  private readonly onWarning?: (msg: string) => void;
  private tmpCounter = 0;

  constructor(options: FileBillingCacheStoreOptions) {
    const root = options.root ?? defaultBillingCacheRoot();
    this.endpointHashValue = hashEndpoint(options.endpoint);
    // Partition by AMG-MCP endpoint only. A cell's data is a property of the
    // endpoint + subscription + month, not of the operator's credential, so
    // the cache is NOT partitioned by the auth credential mode: that mode
    // (azure-cli / mock) is not an identity — two operators share a mode and
    // one mode can carry different identities. A caller that has a *resolved*
    // identity may pass `identityHint` to scope the partition further; it is
    // folded in only as a non-lossy digest (never the readable mode).
    this.partitionDir = join(
      root,
      options.identityHint
        ? `${this.endpointHashValue}__${digest16(options.identityHint)}`
        : this.endpointHashValue,
    );
    this.rootIdentity = options.identityHint
      ? `${this.endpointHashValue}::${options.identityHint}`
      : this.endpointHashValue;
    this.manifestPath = join(this.partitionDir, 'manifest.json');
    this.enabled = options.enabled ?? true;
    this.clock = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  /** The identity this store reads/writes under — needed when stamping records. */
  cacheIdentity(): {
    endpointHash: string;
    rootIdentity: string;
    partitionDir: string;
  } {
    return {
      endpointHash: this.endpointHashValue,
      rootIdentity: this.rootIdentity,
      partitionDir: this.partitionDir,
    };
  }

  filePathFor(key: CacheCellKey): string {
    return join(
      this.partitionDir,
      'subscriptions',
      key.subscriptionId,
      'months',
      cellFileName(key),
    );
  }

  /** Read a cell, resolving it to exactly one {@link CacheReadStatus}. */
  async get(key: CacheCellKey): Promise<CacheReadResult> {
    if (!this.enabled) return { status: 'miss' };
    const path = this.filePathFor(key);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return { status: 'miss' };
      return this.warned({
        status: 'miss',
        warning: `billing cache read failed (${path}): ${describe(err)}`,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.warned({
        status: 'corrupt',
        warning: `billing cache file is not valid JSON: ${path}`,
      });
    }

    const version = (parsed as { schema_version?: unknown } | null)?.schema_version;
    if (version !== CACHE_SCHEMA_VERSION) {
      return this.warned({
        status: 'schema_mismatch',
        warning:
          `billing cache file has unrecognized schema_version ` +
          `${JSON.stringify(version)} (expected ${CACHE_SCHEMA_VERSION}); ` +
          `re-warm with 'cache billing refresh': ${path}`,
      });
    }

    const result = BillingCacheRecordSchema.safeParse(parsed);
    if (!result.success) {
      return this.warned({
        status: 'corrupt',
        warning: `billing cache file failed validation: ${path}`,
      });
    }
    const record = result.data;

    if (record.source.amg_mcp_endpoint_hash !== this.endpointHashValue) {
      return this.warned({
        status: 'identity_mismatch',
        warning: `billing cache file was warmed under a different endpoint: ${path}`,
      });
    }

    // Integrity: compare against the out-of-band checksum recorded in the
    // manifest, when present. This catches accidental corruption and
    // partial writes. It is not a tamper-proof boundary on its own — a
    // manifest rebuild recomputes checksums from disk — so the cache is
    // ultimately trusted to the level of OS file permissions plus disk
    // encryption (see design "privacy and storage").
    const manifest = await this.readManifest();
    const relPath = this.relPath(key.subscriptionId, cellFileName(key));
    const entry = manifest?.entries[relPath];
    if (entry?.checksum) {
      if (sha256(text) !== entry.checksum) {
        return this.warned({
          status: 'integrity_mismatch',
          warning: `billing cache file checksum mismatch (corruption or tampering): ${path}`,
        });
      }
    }

    return { status: 'hit', record };
  }

  /** Convenience: returns the record only on a hit, else undefined. */
  async getRecord(key: CacheCellKey): Promise<BillingCacheRecord | undefined> {
    const result = await this.get(key);
    return result.status === 'hit' ? result.record : undefined;
  }

  /** Persist a validated record. The per-cell file is written first; the manifest is best-effort. */
  async set(record: BillingCacheRecord): Promise<void> {
    if (!this.enabled) return;

    const valid = BillingCacheRecordSchema.safeParse(record);
    if (!valid.success) {
      throw new BillingCacheError(
        `refusing to cache an invalid billing record: ${valid.error.message}`,
      );
    }
    const clean = valid.data;

    const key: CacheCellKey = {
      subscriptionId: clean.subscription_id,
      month: clean.month,
      costView: clean.maturity.cost_view,
      currencyMode: clean.source.currency_mode,
      parametersDigest: clean.source.parameters_digest,
    };
    const fileName = cellFileName(key);
    const path = this.filePathFor(key);
    const serialized = JSON.stringify(clean, null, 2) + '\n';
    const checksum = sha256(serialized);

    try {
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await this.writeAtomic(path, serialized);
    } catch (err) {
      this.onWarning?.(`billing cache write failed (${path}): ${describe(err)}`);
      return;
    }

    // Best-effort manifest update; the per-cell file is the source of truth.
    try {
      const relPath = this.relPath(key.subscriptionId, fileName);
      await this.updateManifest((m) => {
        m.entries[relPath] = {
          subscription_id: clean.subscription_id,
          month: clean.month,
          cost_view: key.costView,
          currency_mode: key.currencyMode,
          parameters_digest: key.parametersDigest,
          file: relPath,
          checksum,
          maturity_status: clean.maturity.status,
          retrieved_at: clean.maturity.retrieved_at,
          written_at: new Date(this.clock()).toISOString(),
        };
      });
    } catch (err) {
      this.onWarning?.(`billing cache manifest update failed (non-fatal): ${describe(err)}`);
    }
  }

  /** Enumerate cached cells by scanning the tree (does not trust the manifest). */
  async list(subscriptionId?: string): Promise<CachedCellRef[]> {
    const subsDir = join(this.partitionDir, 'subscriptions');
    const subIds = subscriptionId ? [subscriptionId] : await safeReaddir(subsDir);
    const refs: CachedCellRef[] = [];
    for (const subId of subIds) {
      const monthsDir = join(subsDir, subId, 'months');
      for (const file of await safeReaddir(monthsDir)) {
        const parsed = parseCellFileName(file);
        if (!parsed) continue;
        refs.push({
          subscriptionId: subId,
          month: parsed.month,
          costView: parsed.costView,
          currencyMode: parsed.currencyMode,
          parametersDigest: parsed.parametersDigest,
          file: this.relPath(subId, file),
        });
      }
    }
    return refs;
  }

  /** Regenerate the manifest from the cell files on disk. */
  async rebuildManifest(): Promise<void> {
    const entries: Record<string, BillingCacheManifestEntry> = {};
    for (const ref of await this.list()) {
      const path = this.absFromRel(ref.file);
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.onWarning?.(`skipping unparseable cache file during rebuild: ${ref.file}`);
        continue;
      }
      if ((parsed as { schema_version?: unknown } | null)?.schema_version !== CACHE_SCHEMA_VERSION) {
        this.onWarning?.(`skipping unrecognized schema_version during rebuild: ${ref.file}`);
        continue;
      }
      const result = BillingCacheRecordSchema.safeParse(parsed);
      if (!result.success) {
        this.onWarning?.(`skipping invalid cache file during rebuild: ${ref.file}`);
        continue;
      }
      const record = result.data;
      entries[ref.file] = {
        subscription_id: record.subscription_id,
        month: record.month,
        cost_view: record.maturity.cost_view,
        currency_mode: record.source.currency_mode,
        parameters_digest: record.source.parameters_digest,
        file: ref.file,
        checksum: sha256(text),
        maturity_status: record.maturity.status,
        retrieved_at: record.maturity.retrieved_at,
        written_at: new Date(this.clock()).toISOString(),
      };
    }
    const manifest: BillingCacheManifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      root_identity: this.rootIdentity,
      entries,
    };
    await mkdir(this.partitionDir, { recursive: true, mode: DIR_MODE });
    await this.writeAtomic(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  /** Remove cells whose month is strictly before `beforeMonth` (YYYY-MM). Returns the count removed. */
  async prune(beforeMonth: string): Promise<number> {
    let removed = 0;
    for (const ref of await this.list()) {
      if (ref.month >= beforeMonth) continue;
      try {
        await unlink(this.absFromRel(ref.file));
        removed += 1;
      } catch (err) {
        this.onWarning?.(`billing cache prune failed (${ref.file}): ${describe(err)}`);
      }
    }
    if (removed > 0) await this.rebuildManifest();
    return removed;
  }

  /** Sweep orphan `*.tmp-*` files left by an interrupted write. Returns the count removed. */
  async sweepStaleTempFiles(): Promise<number> {
    let removed = 0;
    // Cell writes leave temps under <sub>/months; manifest writes leave
    // `manifest.json.tmp-*` directly under the partition root. Sweep both.
    for (const file of await safeReaddir(this.partitionDir)) {
      if (!file.includes('.tmp-')) continue;
      try {
        await unlink(join(this.partitionDir, file));
        removed += 1;
      } catch {
        // best-effort
      }
    }
    const subsDir = join(this.partitionDir, 'subscriptions');
    for (const subId of await safeReaddir(subsDir)) {
      const monthsDir = join(subsDir, subId, 'months');
      for (const file of await safeReaddir(monthsDir)) {
        if (!file.includes('.tmp-')) continue;
        try {
          await unlink(join(monthsDir, file));
          removed += 1;
        } catch {
          // best-effort
        }
      }
    }
    return removed;
  }

  private relPath(subscriptionId: string, fileName: string): string {
    return `subscriptions/${subscriptionId}/months/${fileName}`;
  }

  private absFromRel(rel: string): string {
    return join(this.partitionDir, ...rel.split('/'));
  }

  private async readManifest(): Promise<BillingCacheManifest | undefined> {
    try {
      const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(this.manifestPath, 'utf8')));
      if (!parsed.success) return undefined;
      if (parsed.data.root_identity !== this.rootIdentity) return undefined;
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  private async updateManifest(mutate: (m: BillingCacheManifest) => void): Promise<void> {
    const existing: BillingCacheManifest = (await this.readManifest()) ?? {
      schema_version: MANIFEST_SCHEMA_VERSION,
      root_identity: this.rootIdentity,
      entries: {},
    };
    mutate(existing);
    await mkdir(this.partitionDir, { recursive: true, mode: DIR_MODE });
    await this.writeAtomic(this.manifestPath, JSON.stringify(existing, null, 2) + '\n');
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${this.clock()}-${this.tmpCounter++}`;
    await writeFile(tmp, data, { encoding: 'utf8', mode: FILE_MODE, flag: 'w' });
    await rename(tmp, path);
  }

  private warned(result: CacheReadResult): CacheReadResult {
    if (result.warning) this.onWarning?.(result.warning);
    return result;
  }
}

function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
