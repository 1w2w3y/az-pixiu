import { readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ScopeSchema } from '../schemas/index.js';

/**
 * Phase 1 dataset envelope. Each item points at a fixture and pins the
 * scope used for the run, plus optional expectations the scoring layer
 * can verify (minimum recommendations, expected DQ categories, etc.).
 *
 * Stored as JSON files under eval/. Phase 2 will move dataset management
 * to Langfuse (per the evaluation-framework PRD); this format is what
 * the migration starts from.
 */

export const DatasetItemSchema = z
  .object({
    id: z.string().min(1),
    fixture_id: z.string().min(1),
    description: z.string().optional(),
    scope: ScopeSchema,
    expectations: z
      .object({
        min_recommendations: z.number().int().nonnegative().optional(),
        expected_dq_categories: z.array(z.string().min(1)).optional(),
        expected_capabilities_invoked: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DatasetSchema = z
  .object({
    schema_version: z.literal('1'),
    items: z.array(DatasetItemSchema).min(1),
  })
  .strict();

export type DatasetItem = z.infer<typeof DatasetItemSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;

export async function loadDataset(path: string, cwd: string = process.cwd()): Promise<Dataset> {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const raw = await readFile(abs, 'utf8');
  return DatasetSchema.parse(JSON.parse(raw));
}

export function fixturePathFor(item: DatasetItem, fixturesRoot: string = 'fixtures'): string {
  return join(fixturesRoot, item.fixture_id);
}
