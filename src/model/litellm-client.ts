import { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { observeOpenAI } from '@langfuse/openai';
import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from './client.js';

/**
 * LiteLLMModelClient — OpenAI-compatible client pointed at a LiteLLM
 * gateway (design §15.3). LiteLLM exposes the OpenAI chat-completions
 * surface at `<endpoint>/v1`, so the same `zodResponseFormat`-based
 * structured-output flow that the Foundry client uses works unchanged.
 *
 * The endpoint is treated as a base URL; we append `/v1` ourselves so
 * operators configure just the host. Auth is optional — LiteLLM
 * deployments in dev/test environments commonly run without an API key,
 * and the OpenAI SDK accepts `apiKey: null` for that case.
 *
 * Like the Foundry client, the underlying SDK is wrapped with
 * `observeOpenAI` so every call becomes a Langfuse `generation` under
 * the active span. The wrapper is a no-op when no Langfuse processor is
 * installed (i.e., `--observability noop|memory`).
 */

export interface LiteLLMModelClientOptions {
  /** LiteLLM gateway base URL. `/v1` is appended automatically. */
  endpoint: string;
  /** Model name as registered in LiteLLM's `/v1/models` (e.g. "gpt-5.4"). */
  model: string;
  /** Optional API key. Omit for no-auth deployments. */
  apiKey?: string;
}

export class LiteLLMModelClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: LiteLLMModelClientOptions) {
    this.model = options.model;
    const baseURL = options.endpoint.replace(/\/+$/, '') + '/v1';
    const rawClient = new OpenAI({
      baseURL,
      apiKey: options.apiKey ?? 'no-auth',
    });
    this.client = observeOpenAI(rawClient);
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    args: GenerateStructuredArgs<TSchema>,
  ): Promise<z.infer<TSchema>> {
    const responseFormat = zodResponseFormat(args.schema, args.schemaName);
    if (process.env.PIXIU_DEBUG_SCHEMA === '1') {
      process.stderr.write(
        `[debug] ${args.schemaName} JSON schema: ${JSON.stringify(responseFormat, null, 2)}\n`,
      );
    }
    const response = await this.client.chat.completions.parse({
      model: this.model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      response_format: responseFormat,
      temperature: args.temperature ?? 0,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.maxOutputTokens !== undefined ? { max_completion_tokens: args.maxOutputTokens } : {}),
    });

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error(
        `LiteLLM model "${this.model}" returned no parsed structured output. Refusal: ${response.choices[0]?.message.refusal ?? 'none'}`,
      );
    }
    return parsed as z.infer<TSchema>;
  }
}
