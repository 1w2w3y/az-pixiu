import { z } from 'zod';

export const FoundryConfigSchema = z
  .object({
    endpoint: z.string().url(),
    deployment: z.string().min(1),
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
