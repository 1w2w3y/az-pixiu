import { AzureOpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getBearerTokenProvider, type TokenCredential } from '@azure/identity';
import { observeOpenAI } from '@langfuse/openai';
import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from './client.js';
import { currentInstrumentationFlavor } from '../observability/setup.js';

/**
 * OpenAIModelClient — real Foundry-hosted GPT-5.x via Entra ID
 * (design §15.3, §15.9). Uses zodResponseFormat for strict-JSON-Schema
 * structured output. Instrumentation flavor is process-wide
 * (see observability/setup.ts):
 *
 *   - 'langfuse'      → wrap the SDK with `observeOpenAI` so every call
 *                       becomes a Langfuse `generation` (gen_ai.* attrs).
 *                       No-op when the global tracer provider has no
 *                       Langfuse processor installed.
 *   - 'openinference' → leave the SDK unwrapped; the
 *                       OpenAIInstrumentation registered in setup.ts has
 *                       already patched the openai module prototype to
 *                       emit OpenInference input.value / output.value /
 *                       llm.* attributes. Wrapping with observeOpenAI on
 *                       top would double-instrument every call.
 */

const FOUNDRY_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

export interface OpenAIModelClientOptions {
  endpoint: string;
  deployment: string;
  credential: TokenCredential;
  /** Foundry API version. Defaults to a recent GA release. */
  apiVersion?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export class OpenAIModelClient implements ModelClient {
  private readonly client: AzureOpenAI;
  private readonly deployment: string;

  constructor(options: OpenAIModelClientOptions) {
    this.deployment = options.deployment;
    const rawClient = new AzureOpenAI({
      endpoint: options.endpoint,
      apiVersion: options.apiVersion ?? '2024-10-21',
      azureADTokenProvider: getBearerTokenProvider(options.credential, FOUNDRY_OPENAI_SCOPE),
      timeout: options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    });
    // observeOpenAI returns a Proxy with the same type, so the parse()
    // call below is unchanged. Only apply it under the langfuse flavor —
    // see the class-level doc comment for why.
    this.client =
      currentInstrumentationFlavor() === 'langfuse' ? observeOpenAI(rawClient) : rawClient;
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
    const request = {
      model: this.deployment,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      response_format: responseFormat,
      temperature: args.temperature ?? 0,
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.maxOutputTokens !== undefined ? { max_completion_tokens: args.maxOutputTokens } : {}),
    } satisfies Parameters<typeof this.client.chat.completions.parse>[0];

    let response: Awaited<ReturnType<typeof this.client.chat.completions.parse>>;
    try {
      response = await this.client.chat.completions.parse(request);
    } catch (err) {
      if (!isUnsupportedTemperatureError(err)) throw err;
      const { temperature: _temperature, ...withoutTemperature } = request;
      response = await this.client.chat.completions.parse(withoutTemperature);
    }

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error(
        `Model "${this.deployment}" returned no parsed structured output. Refusal: ${response.choices[0]?.message.refusal ?? 'none'}`,
      );
    }
    return parsed as z.infer<TSchema>;
  }
}

export function isUnsupportedTemperatureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unsupported value: 'temperature'|temperature.+does not support|unsupported.+temperature/i.test(
    message,
  );
}
