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

/**
 * Auto-discovery funnel record (Phase 3 — billing-access probe). When a
 * run auto-discovers subscriptions instead of taking explicit `--subscription`
 * arguments, the discovery has up to four stages:
 *   1. ARG ranks every visible subscription by resource count.
 *   2. The top `probed` are probed against `amgmcp_cost_analysis` to
 *      verify Cost Management read access.
 *   3. The `passed` count is the subset whose probe succeeded.
 *   4. The `selected` count is the slice that ultimately fed the analysis.
 * `cache_hits` / `cache_misses` reveal how much of the probe latency the
 * file-backed cache absorbed. Absent for explicit-pick runs.
 */
export const DiscoveryFunnelSchema = z
  .object({
    arg_ranked: z.number().int().nonnegative(),
    probed: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    cache_hits: z.number().int().nonnegative(),
    cache_misses: z.number().int().nonnegative(),
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
    // Foundry-only — describes where prompts/responses are processed for
    // the data-residency record (§5.7). LiteLLM and other OpenAI-
    // compatible gateways do not expose this concept, so it is optional.
    model_deployment_sku: ModelDeploymentSkuSchema.optional(),
    credential_source: CredentialSourceSchema,
    experiment_variant: z.string().min(1).optional(),
    // Which OTel instrumentation flavor was active for this run.
    // Process-wide choice — see observability/setup.ts.
    instrumentation_flavor: z.enum(['langfuse', 'openinference']).optional(),
    amg_mcp_endpoint: z.string().url(),
    capability_versions: z.record(z.string().min(1), z.string().min(1)),
    fixture_id: z.string().min(1).optional(),
    discovery_funnel: DiscoveryFunnelSchema.optional(),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).optional(),
    status: RunStatusSchema,
  })
  .strict();

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ModelDeploymentSku = z.infer<typeof ModelDeploymentSkuSchema>;
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;
export type DiscoveryFunnel = z.infer<typeof DiscoveryFunnelSchema>;
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
