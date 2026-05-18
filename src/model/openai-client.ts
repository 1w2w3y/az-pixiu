import { AzureOpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getBearerTokenProvider, type TokenCredential } from '@azure/identity';
import { observeOpenAI } from '@langfuse/openai';
import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from './client.js';

/**
 * OpenAIModelClient — real Foundry-hosted GPT-5.x via Entra ID
 * (design §15.3, §15.9). Uses zodResponseFormat for strict-JSON-Schema
 * structured output, and wraps the SDK with `observeOpenAI` from
 * @langfuse/openai so every call is captured as a Langfuse `generation`
 * with model name, prompt/completion bodies, token usage, latency, and
 * errors — no manual instrumentation needed. The wrapper is a no-op when
 * the global tracer provider has no Langfuse processor installed (i.e.,
 * for `--observability noop|memory`).
 */

const FOUNDRY_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

export interface OpenAIModelClientOptions {
  endpoint: string;
  deployment: string;
  credential: TokenCredential;
  /** Foundry API version. Defaults to a recent GA release. */
  apiVersion?: string;
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
    });
    // observeOpenAI returns a Proxy with the same type, so the parse()
    // call below is unchanged. The wrapper captures every chat/completions
    // request as a Langfuse generation under whatever span is active.
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
      model: this.deployment,
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
        `Model "${this.deployment}" returned no parsed structured output. Refusal: ${response.choices[0]?.message.refusal ?? 'none'}`,
      );
    }
    return parsed as z.infer<TSchema>;
  }
}
