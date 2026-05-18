import {
  ReasoningOutputSchema,
  type ReasoningOutput,
  type Scope,
  type EvidenceRecord,
  type DataQualityFinding,
} from '../schemas/index.js';
import type { ModelClient } from '../model/client.js';
import { postProcessReasoning, type PostProcessIssue } from './post-process.js';

/**
 * Reasoner (design §4.7 / §7.2 step 7). Builds the structured user-prompt
 * input from Scope + EvidenceRecord[] + DataQualityFinding[] + optional
 * user_context, calls the ModelClient with the supplied system prompt,
 * validates the structured output through ReasoningOutputSchema, and
 * runs deterministic post-processing (§7.5).
 */

export interface ReasonerOptions {
  model: ModelClient;
  systemPrompt: string;
  /** Defaults to 'reasoner_output'. */
  schemaName?: string;
  /** Defaults to 0. */
  temperature?: number;
  seed?: number;
  maxOutputTokens?: number;
}

export interface ReasonInput {
  scope: Scope;
  evidence: EvidenceRecord[];
  data_quality: DataQualityFinding[];
}

export interface ReasonResult {
  output: ReasoningOutput;
  issues: PostProcessIssue[];
}

export class Reasoner {
  constructor(private readonly options: ReasonerOptions) {}

  async reason(input: ReasonInput): Promise<ReasonResult> {
    const userPrompt = buildUserPrompt(input);
    const raw = await this.options.model.generateStructured({
      systemPrompt: this.options.systemPrompt,
      userPrompt,
      schema: ReasoningOutputSchema,
      schemaName: this.options.schemaName ?? 'reasoner_output',
      temperature: this.options.temperature ?? 0,
      ...(this.options.seed !== undefined ? { seed: this.options.seed } : {}),
      ...(this.options.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.options.maxOutputTokens }
        : {}),
    });
    return postProcessReasoning(raw, { evidence: input.evidence });
  }
}

function buildUserPrompt(input: ReasonInput): string {
  const { scope, evidence, data_quality } = input;
  const userContext = scope.user_context
    ? `\n## user_context (treat as hypothesis-shaping; not evidence)\n${scope.user_context}\n`
    : '';
  return [
    '## scope',
    JSON.stringify(
      {
        subscription_ids: scope.subscription_ids,
        resource_group_names: scope.resource_group_names,
        time_window: scope.time_window,
        baseline_window: scope.baseline_window,
        analysis_type: scope.analysis_type,
        resource_type_filter: scope.resource_type_filter,
        effective_scope_summary: scope.effective_scope_summary,
      },
      null,
      2,
    ),
    '',
    '## evidence',
    JSON.stringify(
      evidence.map((e) => ({
        evidence_id: e.evidence_id,
        source_capability: e.source_capability,
        query_intent: e.query_intent,
        scope_subset: e.scope_subset,
        time_window: e.time_window,
        payload_summary: e.payload_summary,
        payload: e.payload_ref.kind === 'inline' ? e.payload_ref.data : undefined,
        caveats: e.caveats,
      })),
      null,
      2,
    ),
    '',
    '## observed_data_quality',
    JSON.stringify(data_quality, null, 2),
    userContext,
  ].join('\n');
}
