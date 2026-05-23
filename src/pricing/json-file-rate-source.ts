import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

import {
  RateCardSchema,
  type PricingRateLookupOptions,
  type PricingRateSource,
  type RateCard,
  type RateCardEntry,
} from './source.js';

/**
 * Default {@link PricingRateSource} implementation: loads a versioned
 * JSON rate card from disk (the seed at `pricing/azure-rate-card.json`).
 * The card is parsed once at construction time so subsequent lookups
 * are pure in-memory map reads.
 *
 * The class is constructed via {@link JsonFileRateSource.load} so the
 * async file-read and schema validation can be awaited up front; once
 * loaded, lookups are synchronous (the {@link PricingRateSource} contract).
 */
export class JsonFileRateSource implements PricingRateSource {
  private readonly card: RateCard;
  /**
   * Index keyed by `${sku}|${region ?? ''}` so the synchronous lookup
   * is a single map read. A region-omitted entry is stored under the
   * empty-region key and used as fallback when no exact-region entry
   * exists for the SKU.
   */
  private readonly byKey: Map<string, RateCardEntry>;

  private constructor(card: RateCard) {
    this.card = card;
    this.byKey = new Map();
    for (const entry of card.entries) {
      this.byKey.set(toKey(entry.sku, entry.region), entry);
    }
  }

  static async load(options: { path: string }): Promise<JsonFileRateSource> {
    const absPath = isAbsolute(options.path) ? options.path : resolve(process.cwd(), options.path);
    const raw = await readFile(absPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`pricing rate card at ${absPath} is not valid JSON: ${(err as Error).message}`);
    }
    const result = RateCardSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `pricing rate card at ${absPath} failed schema validation: ${result.error.message}`,
      );
    }
    return new JsonFileRateSource(result.data);
  }

  lookup(options: PricingRateLookupOptions): RateCardEntry | undefined {
    // Exact (sku, region) match preferred.
    if (options.region !== undefined) {
      const exact = this.byKey.get(toKey(options.sku, options.region));
      if (exact) return exact;
    }
    // Fallback: region-omitted entry for the same SKU.
    return this.byKey.get(toKey(options.sku, undefined));
  }

  capturedAt(): string {
    return this.card.captured_at;
  }
}

function toKey(sku: string, region: string | undefined): string {
  return `${sku}|${region ?? ''}`;
}
