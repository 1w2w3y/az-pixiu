import { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { observeOpenAI } from '@langfuse/openai';
import { getPropagatedAttributesFromContext } from '@langfuse/core';
import { context, trace } from '@opentelemetry/api';
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
    // Cross-tier trace correlation. The LiteLLM proxy runs its own
    // Langfuse integration server-side, and by default it emits each
    // chat call as a brand-new top-level trace named "litellm-acompletion".
    // LiteLLM's Langfuse integration honors `metadata.trace_id`,
    // `metadata.parent_observation_id`, and `metadata.trace_name` from
    // the request body, so by injecting the active OTel span's ids and
    // the orchestrator-propagated trace attributes we make the proxy-side
    // observation land on the same Langfuse trace as the agent run,
    // alongside our own client-side `observeOpenAI` generation. When no
    // span is active (e.g. unit tests), we send no metadata.
    const correlationMetadata = buildLitellmCorrelationMetadata();
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
      // `metadata` is not part of the OpenAI ChatCompletionCreateParams
      // type, but the OpenAI SDK passes unknown body fields through to
      // the wire request. LiteLLM picks it up server-side.
      ...(correlationMetadata ? ({ metadata: correlationMetadata } as Record<string, unknown>) : {}),
      // Tell the LiteLLM proxy to silently drop request params that the
      // selected provider/model rejects, instead of returning 400. The
      // concrete case that motivated this: gpt-5 / gpt-5-pro / gpt-5-nano
      // reject `temperature=0` and only accept `temperature=1`, while
      // every other model in the catalog accepts our deterministic
      // default. Without `drop_params`, picking one of those models in
      // config.json hard-fails the run on a config-shape mismatch the
      // operator didn't choose. With it, the proxy drops the offending
      // field and returns whatever the provider's default is.
      drop_params: true,
    } as Parameters<typeof this.client.chat.completions.parse>[0]);

    const parsed = response.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error(
        `LiteLLM model "${this.model}" returned no parsed structured output. Refusal: ${response.choices[0]?.message.refusal ?? 'none'}`,
      );
    }
    return parsed as z.infer<TSchema>;
  }
}

/**
 * Build the LiteLLM-side correlation metadata payload from the active
 * OTel span and the Langfuse-propagated attributes set by the
 * orchestrator's `propagateAttributes` call. Returns undefined when no
 * span is active or the span has an invalid context — in that case we
 * silently skip the metadata so the proxy emits its usual standalone
 * trace.
 *
 * `propagateAttributes` stashes traceName / userId / sessionId / tags
 * into OTel context keys (symbols) by default rather than baggage, so
 * the only way to recover them downstream is through @langfuse/core's
 * `getPropagatedAttributesFromContext` helper. That keeps this client
 * agnostic to the orchestrator's analysis-type / scope / credential
 * plumbing.
 */
function buildLitellmCorrelationMetadata(): Record<string, unknown> | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === '0'.repeat(32)) return undefined;

  const propagated = getPropagatedAttributesFromContext(context.active());
  const traceName = stringAttr(propagated['langfuse.trace.name']);
  const sessionId = stringAttr(propagated['session.id']);
  const userId = stringAttr(propagated['user.id']);
  const propagatedTags = arrayAttr(propagated['langfuse.trace.tags']);

  return {
    trace_id: ctx.traceId,
    parent_observation_id: ctx.spanId,
    ...(traceName ? { trace_name: traceName } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(userId ? { trace_user_id: userId } : {}),
    // 'az-pixiu' is the always-on origin tag; merging preserves the
    // orchestrator's tags (e.g. 'analysis:cost_surprise', 'fixture').
    tags: Array.from(new Set(['az-pixiu', ...propagatedTags])),
  };
}

function stringAttr(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function arrayAttr(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}
