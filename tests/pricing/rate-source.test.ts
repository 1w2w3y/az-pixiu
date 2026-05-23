import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonFileRateSource } from '../../src/pricing/json-file-rate-source.js';

const validCard = {
  schema_version: '1',
  captured_at: '2026-05-23',
  currency: 'USD',
  entries: [
    {
      sku: 'PublicIPAddress_Standard_Static_IPv4',
      list_price_weekly_usd: 0.84,
      source_url: 'https://example.com/pricing/ip',
    },
    {
      sku: 'PublicIPAddress_Standard_Static_IPv4',
      region: 'westeurope',
      list_price_weekly_usd: 0.92,
      source_url: 'https://example.com/pricing/ip',
    },
    {
      sku: 'ManagedDisks_Premium_LRS_P10_128GB',
      list_price_weekly_usd: 4.41,
      source_url: 'https://example.com/pricing/disk',
    },
  ],
};

describe('JsonFileRateSource', () => {
  let tmp: string;
  let cardPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'azp-pricing-'));
    cardPath = join(tmp, 'rate-card.json');
    await writeFile(cardPath, JSON.stringify(validCard), 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loads and parses the rate card', async () => {
    const source = await JsonFileRateSource.load({ path: cardPath });
    expect(source.capturedAt()).toBe('2026-05-23');
  });

  it('looks up a region-omitted entry', async () => {
    const source = await JsonFileRateSource.load({ path: cardPath });
    const entry = source.lookup({ sku: 'ManagedDisks_Premium_LRS_P10_128GB' });
    expect(entry?.list_price_weekly_usd).toBe(4.41);
  });

  it('prefers an exact (sku, region) match over the region-omitted fallback', async () => {
    const source = await JsonFileRateSource.load({ path: cardPath });
    const eu = source.lookup({
      sku: 'PublicIPAddress_Standard_Static_IPv4',
      region: 'westeurope',
    });
    expect(eu?.list_price_weekly_usd).toBe(0.92);
  });

  it('falls back to the region-omitted entry when no region-specific entry exists', async () => {
    const source = await JsonFileRateSource.load({ path: cardPath });
    const us = source.lookup({
      sku: 'PublicIPAddress_Standard_Static_IPv4',
      region: 'eastus',
    });
    expect(us?.list_price_weekly_usd).toBe(0.84);
  });

  it('returns undefined for an unknown SKU', async () => {
    const source = await JsonFileRateSource.load({ path: cardPath });
    expect(source.lookup({ sku: 'NonExistent_SKU' })).toBeUndefined();
  });

  it('throws a useful error when the file is not valid JSON', async () => {
    await writeFile(cardPath, 'not json', 'utf8');
    await expect(JsonFileRateSource.load({ path: cardPath })).rejects.toThrow(/not valid JSON/);
  });

  it('throws a useful error when the schema fails to validate', async () => {
    await writeFile(cardPath, JSON.stringify({ schema_version: '1', entries: [] }), 'utf8');
    await expect(JsonFileRateSource.load({ path: cardPath })).rejects.toThrow(/schema validation/);
  });

  it('loads the in-repo seed card (pricing/azure-rate-card.json)', async () => {
    // Resolves relative to repo root (vitest cwd).
    const source = await JsonFileRateSource.load({ path: 'pricing/azure-rate-card.json' });
    expect(source.capturedAt()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Spot-check one entry that the design names explicitly.
    const ipEntry = source.lookup({ sku: 'PublicIPAddress_Standard_Static_IPv4' });
    expect(ipEntry).toBeDefined();
    expect(ipEntry?.source_url).toMatch(/^https:\/\//);
  });
});
