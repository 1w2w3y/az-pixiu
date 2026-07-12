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
        /** Exact deterministic waste-lane recall contract for fixture items. */
        expected_waste_lane: z.string().min(1).optional(),
        expected_candidate_ids: z.array(z.string().min(1)).optional(),
        excluded_candidate_ids: z.array(z.string().min(1)).optional(),
        expected_candidate_count: z.number().int().nonnegative().optional(),
        max_unparsed_rows: z.number().int().nonnegative().optional(),
        max_rejected_rows: z.number().int().nonnegative().optional(),
        /** Exact deterministic aggregate for the selected waste lane. */
        expected_lane_total: z
          .object({
            low_usd: z.number().nonnegative(),
            high_usd: z.number().nonnegative(),
            point_usd: z.number().nonnegative(),
            available_count: z.number().int().nonnegative(),
            unavailable_count: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        /** Reject assertive optimization claims unless their citation closure reaches raw utilization metrics. */
        require_utilization_evidence_for_optimization_claims: z.boolean().optional(),
        /** Require a completed waste lane to be reconciled against same-window billed resource-type cost. */
        require_waste_cost_reconciliation: z
          .object({
            lane: z.string().min(1),
            resource_type: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        const hasLaneContract =
          value.expected_candidate_ids !== undefined ||
          value.excluded_candidate_ids !== undefined ||
          value.expected_candidate_count !== undefined ||
          value.max_unparsed_rows !== undefined ||
          value.max_rejected_rows !== undefined ||
          value.expected_lane_total !== undefined;
        if (hasLaneContract && value.expected_waste_lane === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['expected_waste_lane'],
            message: 'expected_waste_lane is required for waste-candidate expectations',
          });
        }
        if (value.require_waste_cost_reconciliation !== undefined) {
          if (value.expected_waste_lane === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['expected_waste_lane'],
              message: 'expected_waste_lane is required for waste-cost reconciliation',
            });
          } else if (value.expected_waste_lane !== value.require_waste_cost_reconciliation.lane) {
            ctx.addIssue({
              code: 'custom',
              path: ['require_waste_cost_reconciliation', 'lane'],
              message: 'reconciliation lane must match expected_waste_lane',
            });
          }
        }
      })
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
