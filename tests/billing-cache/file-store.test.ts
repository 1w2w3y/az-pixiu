import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBillingCacheStore } from '../../src/billing-cache/file-store.js';
import { buildCacheCellKey } from '../../src/billing-cache/cache-key.js';
import type { CacheCellKey, CostRequestParams } from '../../src/billing-cache/types.js';
import type { BillingCacheRecord } from '../../src/billing-cache/schema.js';

const endpoint = 'https://example.grafana.test';
const PARAMS: CostRequestParams = {
  granularity: 'Daily',
  scope: 'subscription',
  grouping: ['ServiceName'],
};

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'azp-billing-cache-'));
}

function keyFor(
  subscriptionId = 'sub-a',
  month = '2026-05',
  costView: 'actual' | 'amortized' = 'amortized',
  currencyMode: 'billing' | 'normalized_usd' = 'normalized_usd',
): CacheCellKey {
  return buildCacheCellKey({ subscriptionId, month, costView, currencyMode, params: PARAMS });
}

function recordFor(key: CacheCellKey, endpointHash: string, monthTotal = 1234.56): BillingCacheRecord {
  return {
    schema_version: 'billing-cache-v1',
    subscription_id: key.subscriptionId,
    month: key.month,
    billing_period: {
      start: `${key.month}-01T00:00:00.000Z`,
      end: '2026-06-01T00:00:00.000Z',
      granularity: 'Daily',
      billing_account_type: 'MCA',
    },
    maturity: {
      status: 'usage_stable',
      cost_view: key.costView,
      stabilization_offset_days: 5,
      became_cacheable_on: '2026-06-06',
      late_adjustment_possible: true,
      retrieved_at: '2026-06-06T18:22:41.000Z',
    },
    source: {
      capability: 'amgmcp_cost_analysis',
      capability_version: 'billing-cache-v1',
      amg_mcp_endpoint_hash: endpointHash,
      scope: PARAMS.scope,
      parameters_digest: key.parametersDigest,
      currency_mode: key.currencyMode,
    },
    totals: {
      currency: 'USD',
      exchange_rate_date: null,
      month_total: monthTotal,
      unattributed: 0,
      daily: [
        { date: '2026-05-01', cost: 39.12 },
        { date: '2026-05-02', cost: 41.07 },
      ],
    },
    dimensions: {
      service: {
        monthly: [{ name: 'Azure Database for PostgreSQL', cost: 500.12 }],
        daily: [{ date: '2026-05-01', name: 'Azure Database for PostgreSQL', cost: 16.42 }],
      },
      resource_group: {
        monthly: [],
        daily: [],
        status: 'not_supported_by_current_capability',
      },
    },
    coverage: {
      complete: true,
      dimensions_reconcile: true,
      missing_dimensions: ['resource_group'],
      included_charge_classes: ['first_party_usage'],
      excluded_charge_classes: ['marketplace', 'tax', 'credits'],
      warnings: [],
    },
  };
}

function newStore(root: string, overrides: Partial<{ endpoint: string; identityHint: string; enabled: boolean; onWarning: (m: string) => void }> = {}): FileBillingCacheStore {
  return new FileBillingCacheStore({
    root,
    endpoint: overrides.endpoint ?? endpoint,
    now: () => Date.parse('2026-06-06T18:22:41Z'),
    ...overrides,
  });
}

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await tempRoot();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('FileBillingCacheStore', () => {
  it('misses when the cell does not exist yet', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      expect((await store.get(keyFor())).status).toBe('miss');
    });
  });

  it('round-trips a record and returns it on hit', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      const record = recordFor(key, store.cacheIdentity().endpointHash);
      await store.set(record);

      const result = await store.get(key);
      expect(result.status).toBe('hit');
      expect(result.record).toEqual(record);
      // A fresh instance reads the same cell.
      expect((await newStore(root).getRecord(key))?.month).toBe('2026-05');
    });
  });

  it('treats a non-JSON file as corrupt (miss + warning), not fatal', async () => {
    await withTempRoot(async (root) => {
      const warnings: string[] = [];
      const store = newStore(root, { onWarning: (m) => warnings.push(m) });
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      await writeFile(store.filePathFor(key), '{ not valid json', 'utf8');

      const result = await store.get(key);
      expect(result.status).toBe('corrupt');
      expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
    });
  });

  it('reports schema_mismatch for an unrecognized schema_version', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      const record = recordFor(key, store.cacheIdentity().endpointHash);
      await store.set(record);
      const mutated = { ...record, schema_version: 'billing-cache-v2' };
      await writeFile(store.filePathFor(key), JSON.stringify(mutated, null, 2) + '\n', 'utf8');

      expect((await store.get(key)).status).toBe('schema_mismatch');
    });
  });

  it('detects tampering via the out-of-band manifest checksum', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      const record = recordFor(key, store.cacheIdentity().endpointHash);
      await store.set(record);

      // Hand-edit the cell file (changing the total) without touching the manifest.
      const tampered = { ...record, totals: { ...record.totals, month_total: 999999 } };
      await writeFile(store.filePathFor(key), JSON.stringify(tampered, null, 2) + '\n', 'utf8');

      expect((await store.get(key)).status).toBe('integrity_mismatch');
    });
  });

  it('rejects a cell warmed under a different endpoint (identity_mismatch)', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      // Stamp a bogus endpoint hash inside an otherwise valid record.
      const record = recordFor(key, 'deadbeefdeadbeef');
      await store.set(record);
      expect((await store.get(key)).status).toBe('identity_mismatch');
    });
  });

  it('partitions cells by endpoint so they do not bleed across stores', async () => {
    await withTempRoot(async (root) => {
      const a = newStore(root, { endpoint: 'https://a.example' });
      const b = newStore(root, { endpoint: 'https://b.example' });
      const key = keyFor();
      await a.set(recordFor(key, a.cacheIdentity().endpointHash));
      expect((await a.get(key)).status).toBe('hit');
      expect((await b.get(key)).status).toBe('miss');
    });
  });

  it('partitions by endpoint only by default — the credential mode is never in the path', async () => {
    await withTempRoot(async (root) => {
      const a = newStore(root); // no identityHint (mimics the CLI default)
      const b = newStore(root); // same endpoint, no identityHint
      // Same endpoint + no identity => the SAME partition (the cache is shared
      // regardless of which credential mode warmed it). The partition dir is
      // exactly the endpoint hash, with no identity/mode segment appended.
      const partition = a.cacheIdentity().partitionDir;
      expect(partition).toBe(b.cacheIdentity().partitionDir);
      expect(partition.endsWith(a.cacheIdentity().endpointHash)).toBe(true);
      const key = keyFor();
      await a.set(recordFor(key, a.cacheIdentity().endpointHash));
      expect((await b.get(key)).status).toBe('hit');
    });
  });

  it('scopes the partition by an explicit RESOLVED identity hint when one is provided', async () => {
    await withTempRoot(async (root) => {
      // The CLI never sets identityHint; this seam is for a caller that has a
      // genuinely resolved principal — NOT the auth credential mode.
      const alice = newStore(root, { identityHint: 'resolved-principal-alice' });
      const bob = newStore(root, { identityHint: 'resolved-principal-bob' });
      const key = keyFor();
      await alice.set(recordFor(key, alice.cacheIdentity().endpointHash));
      expect((await alice.get(key)).status).toBe('hit');
      expect((await bob.get(key)).status).toBe('miss');
    });
  });

  it('is a no-op when disabled (no file, reads miss)', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root, { enabled: false });
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      expect((await store.get(key)).status).toBe('miss');
      let existed = true;
      try {
        await readFile(store.filePathFor(key), 'utf8');
      } catch {
        existed = false;
      }
      expect(existed).toBe(false);
    });
  });

  it('throws when asked to cache an invalid record', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      const bad = recordFor(key, store.cacheIdentity().endpointHash);
      // @ts-expect-error deliberately violate the schema
      bad.totals.month_total = 'not-a-number';
      await expect(store.set(bad)).rejects.toThrow();
    });
  });

  it('leaves no temp files behind after a write', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      expect(await store.sweepStaleTempFiles()).toBe(0);
      // list() ignores anything that isn't a strict cell file.
      const refs = await store.list();
      expect(refs).toHaveLength(1);
      expect(refs[0]?.month).toBe('2026-05');
    });
  });

  it('still serves a cell after the manifest is lost, then rebuilds and re-enforces integrity', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      // Drop the manifest entirely.
      await rm(store.cacheIdentity().partitionDir + '/manifest.json', { force: true });
      // The cell file is the source of truth: still a hit (integrity skipped, no checksum).
      expect((await store.get(key)).status).toBe('hit');
      // Rebuild from disk, then a tamper is caught again.
      await store.rebuildManifest();
      const tampered = { ...recordFor(key, store.cacheIdentity().endpointHash), totals: { currency: 'USD', month_total: 1, unattributed: 0, daily: [] } };
      await writeFile(store.filePathFor(key), JSON.stringify(tampered, null, 2) + '\n', 'utf8');
      expect((await store.get(key)).status).toBe('integrity_mismatch');
    });
  });

  it('prunes cells strictly before a cutoff month', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      for (const month of ['2026-01', '2026-02', '2026-03']) {
        const key = keyFor('sub-a', month);
        await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      }
      const removed = await store.prune('2026-03');
      expect(removed).toBe(2);
      const months = (await store.list()).map((r) => r.month).sort();
      expect(months).toEqual(['2026-03']);
    });
  });

  it('keeps same-month cells distinct by cost_view and currency_mode (cache cell identity)', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const eh = store.cacheIdentity().endpointHash;
      const amortUsd = keyFor('sub-a', '2026-05', 'amortized', 'normalized_usd');
      const actualUsd = keyFor('sub-a', '2026-05', 'actual', 'normalized_usd');
      const amortBilling = keyFor('sub-a', '2026-05', 'amortized', 'billing');
      await store.set(recordFor(amortUsd, eh, 1000));
      await store.set(recordFor(actualUsd, eh, 2000));
      await store.set(recordFor(amortBilling, eh, 3000));

      expect((await store.getRecord(amortUsd))?.totals.month_total).toBe(1000);
      expect((await store.getRecord(actualUsd))?.totals.month_total).toBe(2000);
      expect((await store.getRecord(amortBilling))?.totals.month_total).toBe(3000);
      expect((await store.list()).length).toBe(3);
    });
  });

  it('returns miss for a key that differs only in parametersDigest (never a stale hit)', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      const otherParams = buildCacheCellKey({
        subscriptionId: 'sub-a',
        month: '2026-05',
        costView: 'amortized',
        currencyMode: 'normalized_usd',
        params: { granularity: 'Daily', scope: 'subscription', grouping: ['ResourceType'] },
      });
      expect(otherParams.parametersDigest).not.toBe(key.parametersDigest);
      expect((await store.get(otherParams)).status).toBe('miss');
    });
  });

  it('still serves a cell when the manifest is malformed JSON (manifest is non-authoritative)', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      await store.set(recordFor(key, store.cacheIdentity().endpointHash));
      await writeFile(join(store.cacheIdentity().partitionDir, 'manifest.json'), '{ broken json', 'utf8');
      expect((await store.get(key)).status).toBe('hit');
    });
  });

  it('filters list() by subscription id and isolates subscriptions', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const eh = store.cacheIdentity().endpointHash;
      await store.set(recordFor(keyFor('sub-a', '2026-05'), eh));
      await store.set(recordFor(keyFor('sub-b', '2026-05'), eh));
      expect((await store.list('sub-a')).map((r) => r.subscriptionId)).toEqual(['sub-a']);
      expect((await store.list('sub-b')).map((r) => r.subscriptionId)).toEqual(['sub-b']);
      expect((await store.list()).length).toBe(2);
    });
  });

  it('getRecord returns undefined on a non-hit status', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const key = keyFor();
      // Bogus endpoint hash inside the record => identity_mismatch on read.
      await store.set(recordFor(key, 'deadbeefdeadbeef'));
      expect((await store.get(key)).status).toBe('identity_mismatch');
      expect(await store.getRecord(key)).toBeUndefined();
    });
  });

  it('a disabled store suppresses reads of an existing cell, not just writes', async () => {
    await withTempRoot(async (root) => {
      const writer = newStore(root);
      const key = keyFor();
      await writer.set(recordFor(key, writer.cacheIdentity().endpointHash));
      const reader = newStore(root, { enabled: false });
      expect((await reader.get(key)).status).toBe('miss');
    });
  });

  it('gives distinct resolved identities distinct partitions (non-lossy digest, no collision)', async () => {
    await withTempRoot(async (root) => {
      const a = newStore(root, { identityHint: 'principal-a:tenant-1' });
      const b = newStore(root, { identityHint: 'principal-a_tenant-1' });
      expect(a.cacheIdentity().partitionDir).not.toBe(b.cacheIdentity().partitionDir);
      const key = keyFor();
      await a.set(recordFor(key, a.cacheIdentity().endpointHash));
      expect((await b.get(key)).status).toBe('miss');
    });
  });

  it('refuses to cache a record with a non-16-hex parameters_digest', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      const bad = recordFor(keyFor(), store.cacheIdentity().endpointHash);
      bad.source.parameters_digest = 'not-hex';
      await expect(store.set(bad)).rejects.toThrow();
    });
  });

  it('sweeps an orphaned manifest temp file at the partition root', async () => {
    await withTempRoot(async (root) => {
      const store = newStore(root);
      await store.set(recordFor(keyFor(), store.cacheIdentity().endpointHash));
      const orphan = join(store.cacheIdentity().partitionDir, 'manifest.json.tmp-123-456-0');
      await writeFile(orphan, 'x', 'utf8');
      expect(await store.sweepStaleTempFiles()).toBe(1);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'writes cell files mode 0600 under a 0700 directory',
    async () => {
      await withTempRoot(async (root) => {
        const store = newStore(root);
        const key = keyFor();
        await store.set(recordFor(key, store.cacheIdentity().endpointHash));
        const fileMode = (await stat(store.filePathFor(key))).mode & 0o777;
        const monthsDir = join(store.cacheIdentity().partitionDir, 'subscriptions', 'sub-a', 'months');
        const dirMode = (await stat(monthsDir)).mode & 0o777;
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      });
    },
  );
});
