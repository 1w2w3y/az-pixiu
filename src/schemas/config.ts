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

export const AmgConfigSchema = z
  .object({
    endpoint: z.string().url(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    foundry: FoundryConfigSchema,
    amg: AmgConfigSchema,
  })
  .strict();

export type FoundryConfig = z.infer<typeof FoundryConfigSchema>;
export type AmgConfig = z.infer<typeof AmgConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
