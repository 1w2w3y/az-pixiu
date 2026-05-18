import type { z } from 'zod';

/**
 * ModelClient interface (design §13, §15.3). Owns the LLM-call boundary.
 *
 * Implementations:
 *   - OpenAIModelClient — talks to Foundry-hosted GPT-5.x via the
 *     openai SDK's AzureOpenAI client with Entra ID auth.
 *   - MockModelClient — returns canned structured responses for tests.
 *
 * The interface is intentionally narrow: structured-output only.
 * Phase 1 has two LLM calls (planner + reasoner) and both consume a
 * Zod schema; freeform text-out is not on the path.
 */
export interface ModelClient {
  generateStructured<TSchema extends z.ZodTypeAny>(
    args: GenerateStructuredArgs<TSchema>,
  ): Promise<z.infer<TSchema>>;
}

export interface GenerateStructuredArgs<TSchema extends z.ZodTypeAny> {
  systemPrompt: string;
  userPrompt: string;
  schema: TSchema;
  /** Strict-JSON-Schema response name shown to the provider. */
  schemaName: string;
  /** Deterministic temperature. Default 0 — see §17 reproducibility. */
  temperature?: number;
  /** Optional deterministic seed (provider-dependent). */
  seed?: number;
  /** Optional per-call max tokens cap. */
  maxOutputTokens?: number;
}

/**
 * Hash the model-call configuration into a short string that goes into
 * RunMetadata.model_config_hash (§5.7). Same inputs → same hash, so two
 * runs are comparable by reading this single field.
 */
export function modelConfigHash(args: {
  provider: string;
  name: string;
  temperature: number;
  seed?: number;
  maxOutputTokens?: number;
}): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
  );
  // Tiny FNV-1a — we don't need crypto strength here, just stability.
  let h = 0x811c9dc5;
  for (const ch of canonical) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
