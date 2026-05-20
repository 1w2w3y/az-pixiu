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
  })
  .strict();

export const AmgConfigSchema = z
  .object({
    endpoint: z.string().url(),
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
export type AmgConfig = z.infer<typeof AmgConfigSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type Config = z.infer<typeof ConfigSchema>;
