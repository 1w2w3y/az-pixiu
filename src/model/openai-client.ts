import { AzureOpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getBearerTokenProvider, type TokenCredential } from '@azure/identity';
import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from './client.js';

/**
 * OpenAIModelClient — real Foundry-hosted GPT-5.x via Entra ID
 * (design §15.3, §15.9). Uses zodResponseFormat for strict-JSON-Schema
 * structured output. Wrapping with @langfuse/openai for OTEL spans is
 * deferred to step 10.
 *
 * Smoke-test status: written, not run live. Real calls require
 * `az login` (or another TokenCredential), a reachable Foundry endpoint,
 * and a valid deployment name. The MockModelClient covers the test
 * surface until step 11 wires live access.
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
    this.client = new AzureOpenAI({
      endpoint: options.endpoint,
      apiVersion: options.apiVersion ?? '2024-10-21',
      azureADTokenProvider: getBearerTokenProvider(options.credential, FOUNDRY_OPENAI_SCOPE),
    });
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    args: GenerateStructuredArgs<TSchema>,
  ): Promise<z.infer<TSchema>> {
    const response = await this.client.chat.completions.parse({
      model: this.deployment,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      response_format: zodResponseFormat(args.schema, args.schemaName),
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
