import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BillingProbeCache } from '../../src/run/billing-probe-cache.js';

const endpoint = 'https://example.grafana.test';

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'azp-probe-cache-'));
}

describe('BillingProbeCache', () => {
  it('returns undefined when the cache file does not exist yet', async () => {
    const dir = await tempDir();
    try {
      const cache = new BillingProbeCache({
        path: join(dir, 'cache.json'),
        endpoint,
      });
      expect(await cache.get('sub-a')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a pass entry and respects the 6h TTL', async () => {
    const dir = await tempDir();
    try {
      let now = Date.parse('2026-05-30T00:00:00Z');
      const cache = new BillingProbeCache({
        path: join(dir, 'cache.json'),
        endpoint,
        now: () => now,
      });
      await cache.set('sub-a', { outcome: 'pass' });
      // 5.5 hours later — still warm.
      now += 5.5 * 60 * 60 * 1000;
      const stillThere = await cache.get('sub-a');
      expect(stillThere?.outcome).toBe('pass');
      // 7 hours total — past 6h TTL.
      now = Date.parse('2026-05-30T07:01:00Z');
      expect(await cache.get('sub-a')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the 30-minute TTL for denied/transient/unknown', async () => {
    const dir = await tempDir();
    try {
      let now = Date.parse('2026-05-30T00:00:00Z');
      const cache = new BillingProbeCache({
        path: join(dir, 'cache.json'),
        endpoint,
        now: () => now,
      });
      await cache.set('sub-a', { outcome: 'denied', classification: 'rbac_access_denied' });
      // 20 minutes — still warm.
      now += 20 * 60 * 1000;
      expect((await cache.get('sub-a'))?.outcome).toBe('denied');
      // 31 minutes total — past 30-minute TTL.
      now = Date.parse('2026-05-30T00:31:00Z');
      expect(await cache.get('sub-a')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('partitions by endpoint hash so entries do not bleed across endpoints', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'cache.json');
      const a = new BillingProbeCache({ path, endpoint: 'https://a.example' });
      const b = new BillingProbeCache({ path, endpoint: 'https://b.example' });
      await a.set('sub-a', { outcome: 'pass' });
      expect(await b.get('sub-a')).toBeUndefined();
      expect((await a.get('sub-a'))?.outcome).toBe('pass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a corrupted cache file by treating it as empty', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'cache.json');
      await writeFile(path, '{not valid json', 'utf8');
      const cache = new BillingProbeCache({ path, endpoint });
      expect(await cache.get('sub-a')).toBeUndefined();
      // Writing should succeed and replace the corrupted file with a valid one.
      await cache.set('sub-a', { outcome: 'pass' });
      const reread = new BillingProbeCache({ path, endpoint });
      expect((await reread.get('sub-a'))?.outcome).toBe('pass');
      const onDisk = await readFile(path, 'utf8');
      const parsed = JSON.parse(onDisk);
      expect(parsed.version).toBe(1);
      expect(typeof parsed.entries).toBe('object');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when disabled (no file written, no entries returned)', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'cache.json');
      const cache = new BillingProbeCache({ path, endpoint, enabled: false });
      await cache.set('sub-a', { outcome: 'pass' });
      expect(await cache.get('sub-a')).toBeUndefined();
      let existed = true;
      try {
        await readFile(path, 'utf8');
      } catch {
        existed = false;
      }
      expect(existed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('partitions by identity hint', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'cache.json');
      const alice = new BillingProbeCache({ path, endpoint, identityHint: 'alice' });
      const bob = new BillingProbeCache({ path, endpoint, identityHint: 'bob' });
      await alice.set('sub-a', { outcome: 'pass' });
      expect((await alice.get('sub-a'))?.outcome).toBe('pass');
      expect(await bob.get('sub-a')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
