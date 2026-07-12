import { z } from 'zod';

// ---------- Config (operator-local config.json, design §15.8) ----------

export const FoundryConfigSchema = z
  .object({
    endpoint: z.string().url(),
    deployment: z.string().min(1),
    deployment_sku: z
      .enum(['GlobalStandard', 'DataZoneStandard', 'regional'])
      .optional()
      .default('GlobalStandard'),
    api_version: z.string().min(1).optional().default('2024-10-21'),
  })
  .strict();

// LiteLLM gateway (OpenAI-compatible). Endpoint is the base URL — the
// client appends `/v1` for chat completions. `api_key` is optional so
// the no-auth deployments used in dev/test environments can be configured
// without a placeholder secret.
export const LiteLLMConfigSchema = z
  .object({
    endpoint: z.string().url(),
    model: z.string().min(1),
    api_key: z.string().min(1).optional(),
    // Local models can need substantially longer than the 120-second
    // client default for large structured prompts. Keep the override
    // operator-controlled and bounded to avoid accidental unbounded runs.
    timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
  })
  .strict();

export const AmgAuthConfigSchema = z
  .union([
    z.object({ mode: z.literal('entra') }).strict(),
    z
      .object({
        mode: z.literal('service_account_token'),
        token: z.string().min(1).optional(),
        token_env: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .superRefine((auth, ctx) => {
    if (auth.mode === 'service_account_token' && !auth.token && !auth.token_env) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'service_account_token auth requires either "token" or "token_env".',
      });
    }
  });

export const AmgConfigSchema = z
  .object({
    endpoint: z.string().url(),
    auth: AmgAuthConfigSchema.optional().default({ mode: 'entra' }),
  })
  .strict();

export const ObservabilityConfigSchema = z
  .object({
    application_insights_connection_string: z.string().min(1).optional(),
  })
  .strict();

// Local billing cache (docs/design/local-billing-cache.md). Opt-in and
// disabled by default. `stabilization_offset_days` and
// `invoice_close_horizon_months` are computed relative to the billing-
// period end in UTC, not a civil day of the month. `cost_view` defaults to
// amortized (effective per-resource cost) for optimization framing.
export const BillingCacheConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    stabilization_offset_days: z.number().int().min(0).max(28).optional().default(5),
    invoice_close_horizon_months: z.number().int().min(0).max(6).optional().default(2),
    cost_view: z.enum(['actual', 'amortized']).optional().default('amortized'),
    root: z.string().min(1).optional(),
  })
  .strict();

export const ModelProviderSchema = z.enum(['foundry', 'litellm']);

// The selector lives at the top level so existing `config.json` files
// that predate LiteLLM keep working — `provider` defaults to `'foundry'`,
// and the existing `foundry` block satisfies the superRefine check below.
export const ConfigSchema = z
  .object({
    provider: ModelProviderSchema.optional().default('foundry'),
    foundry: FoundryConfigSchema.optional(),
    litellm: LiteLLMConfigSchema.optional(),
    amg: AmgConfigSchema,
    observability: ObservabilityConfigSchema.optional(),
    billing_cache: BillingCacheConfigSchema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.provider === 'foundry' && !cfg.foundry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['foundry'],
        message: 'provider="foundry" requires a "foundry" block.',
      });
    }
    if (cfg.provider === 'litellm' && !cfg.litellm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['litellm'],
        message: 'provider="litellm" requires a "litellm" block.',
      });
    }
  });

export type FoundryConfig = z.infer<typeof FoundryConfigSchema>;
export type LiteLLMConfig = z.infer<typeof LiteLLMConfigSchema>;
export type AmgAuthConfig = z.infer<typeof AmgAuthConfigSchema>;
export type AmgConfig = z.infer<typeof AmgConfigSchema>;
export type AzPixiuObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type BillingCacheConfig = z.infer<typeof BillingCacheConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type Config = z.infer<typeof ConfigSchema>;
