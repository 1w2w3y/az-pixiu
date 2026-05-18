import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ConfigSchema } from './schemas/index.js';
import type { Config } from './schemas/index.js';

export class ConfigError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
    this.cause = cause;
  }
}

export const DEFAULT_CONFIG_PATH = 'config.json';

export interface LoadConfigOptions {
  path?: string;
  cwd?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const path = options.path ?? DEFAULT_CONFIG_PATH;
  const cwd = options.cwd ?? process.cwd();
  const absolute = resolve(cwd, path);

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Could not read config file at ${absolute}. ` +
        `Copy config.sample.json to config.json and fill in your endpoints.`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file at ${absolute} is not valid JSON: ${(err as Error).message}`, err);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file at ${absolute} did not match the expected schema:\n${formatZodError(result.error)}`,
      result.error,
    );
  }

  return result.data;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}
