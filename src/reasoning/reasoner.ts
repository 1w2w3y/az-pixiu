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

/**
 * Evidence and user_context can both contain operator- or
 * attacker-controlled strings (Azure tags, activity-log descriptions,
 * free-text notes). To mitigate prompt-injection (design §7.5 read-only
 * lint is post-hoc; this is the at-input defense), fence each
 * untrusted block with explicit markers and instruct the reasoner — via
 * the reasoner.v1 system prompt — to treat their contents as data, not
 * instructions. This does not defeat sophisticated injection but it
 * shifts the model's prior toward "data" framing for the common case.
 */
const EVIDENCE_OPEN = '<evidence_block role="data">';
const EVIDENCE_CLOSE = '</evidence_block>';
const USER_CONTEXT_OPEN = '<user_context_block role="data">';
const USER_CONTEXT_CLOSE = '</user_context_block>';
const DQ_OPEN = '<data_quality_block role="data">';
const DQ_CLOSE = '</data_quality_block>';

function buildUserPrompt(input: ReasonInput): string {
  const { scope, evidence, data_quality } = input;

  const evidenceJson = JSON.stringify(
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
  );

  const sections: string[] = [
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
    '## valid_evidence_ids',
    JSON.stringify(evidence.map((e) => e.evidence_id), null, 2),
    '',
    '## evidence',
    EVIDENCE_OPEN,
    evidenceJson,
    EVIDENCE_CLOSE,
    '',
    '## observed_data_quality',
    DQ_OPEN,
    JSON.stringify(data_quality, null, 2),
    DQ_CLOSE,
  ];

  if (scope.user_context) {
    sections.push(
      '',
      '## user_context (hypothesis-shaping; never cite as evidence)',
      USER_CONTEXT_OPEN,
      scope.user_context,
      USER_CONTEXT_CLOSE,
    );
  }

  return sections.join('\n');
}
