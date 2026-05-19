import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from '../model/client.js';
import { MockModelClient } from '../model/mock-client.js';

/**
 * "Smart" mock model client for the eval CLI's --mock-model flag. The
 * runner replays many fixtures with different evidence ids, so a single
 * constant canned response can't cite a valid evidence_id everywhere.
 * Instead, this mock parses the first evidence_id out of the reasoner's
 * user prompt and synthesizes a minimal-but-valid ReasoningOutput around
 * it.
 *
 * Constraints honored:
 *   - Cited evidence_id must resolve in postProcessReasoning (§7.5 step 1).
 *   - Fact statement must contain no numbers not present in cited
 *     evidence — the synthesized statement has none.
 *   - Recommendation prose must avoid imperative remediation (read-only
 *     lint, §7.5 step 3).
 *   - Confidence dimensions and level must agree after derivation (§7.5
 *     step 4); we emit 'medium' with mixed dimensions.
 *
 * The planner schema is deliberately unsupported — eval --mock-model
 * pairs with --use-playbook so the planner LLM never fires.
 */

export function buildCannedReasoningResponder(): (
  args: GenerateStructuredArgs<z.ZodTypeAny>,
) => unknown {
  return (args) => {
    if (args.schemaName === 'reasoner_output') {
      const evidenceId = firstEvidenceIdInPrompt(args.userPrompt) ?? 'ev-unknown';
      return buildCannedReasoningOutput(evidenceId);
    }
    if (args.schemaName === 'planner_output') {
      throw new Error(
        'eval --mock-model: planner LLM is not mocked. Combine with --use-playbook to bypass the planner.',
      );
    }
    throw new Error(`eval --mock-model: unknown schemaName "${args.schemaName}"`);
  };
}

export function buildCannedMockModelClient(): ModelClient {
  return new MockModelClient({ responses: buildCannedReasoningResponder() });
}

function firstEvidenceIdInPrompt(prompt: string): string | undefined {
  // Reasoner.buildUserPrompt embeds the evidence as JSON. The first
  // "evidence_id": "<value>" hit is the first record passed in.
  const match = /"evidence_id":\s*"([^"]+)"/.exec(prompt);
  return match?.[1];
}

function buildCannedReasoningOutput(evidenceId: string): unknown {
  const mixedDims = {
    evidence_coverage: 'adequate' as const,
    signal_quality: 'mixed' as const,
    signal_agreement: 'mixed' as const,
  };
  return {
    facts: [
      {
        fact_id: 'fact-mock-1',
        statement: 'mocked smoke fact: evidence was retrieved without errors',
        evidence_ids: [evidenceId],
        scope_subset: { subscription_ids: null, resource_group_names: null, resource_ids: null },
      },
    ],
    hypotheses: [
      {
        hypothesis_id: 'hyp-mock-1',
        statement: 'mocked smoke hypothesis derived from the retrieved evidence',
        confidence: { level: 'medium', rationale: 'mocked', dimensions: mixedDims },
        supported_by_fact_ids: ['fact-mock-1'],
        counter_evidence_fact_ids: [],
        missing_evidence_to_decide: [],
      },
    ],
    recommendations: [
      {
        recommendation_id: 'rec-mock-1',
        priority: 'medium',
        confidence: { level: 'medium', rationale: 'mocked', dimensions: mixedDims },
        impact: 'unknown',
        statement: 'consider reviewing the recorded evidence to validate the synthesized signal',
        supported_by_hypothesis_ids: ['hyp-mock-1'],
        supported_by_fact_ids: ['fact-mock-1'],
        assumptions: ['mocked reasoning output — not a real recommendation'],
        validation_steps: ['inspect the run.json artefact for the underlying payload'],
        false_positive_considerations: ['this is a mock; treat as a wiring smoke test only'],
        suggested_audience: 'platform_engineer',
        suggested_human_actions: ['review the recorded evidence before relying on this output'],
      },
    ],
    data_quality: [],
  };
}
