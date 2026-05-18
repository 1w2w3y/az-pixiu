import { z } from 'zod';
import { RunIdSchema } from './common.js';

// ---------- RunMetadata (§5.7) ----------
// The run-level header attached to run.json and the trace root span.

export const RunStatusSchema = z.enum([
  'success',
  'partial',
  'failed_config',
  'failed_analysis',
]);

export const ModelDeploymentSkuSchema = z.enum([
  'GlobalStandard',
  'DataZoneStandard',
  'regional',
]);

export const PromptVersionsSchema = z
  .object({
    planner: z.string().min(1),
    reasoner: z.string().min(1),
  })
  .strict();

export const CredentialSourceSchema = z
  .object({
    implementation: z.string().min(1),
    identity: z.string().min(1),
  })
  .strict();

export const RunMetadataSchema = z
  .object({
    run_id: RunIdSchema,
    trace_id: z.string().min(1),
    prompt_versions: PromptVersionsSchema,
    model_provider: z.string().min(1),
    model_name: z.string().min(1),
    model_config_hash: z.string().min(1),
    model_deployment_sku: ModelDeploymentSkuSchema,
    credential_source: CredentialSourceSchema,
    experiment_variant: z.string().min(1).optional(),
    amg_mcp_endpoint: z.string().url(),
    capability_versions: z.record(z.string().min(1), z.string().min(1)),
    fixture_id: z.string().min(1).optional(),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).optional(),
    status: RunStatusSchema,
  })
  .strict();

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ModelDeploymentSku = z.infer<typeof ModelDeploymentSkuSchema>;
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
