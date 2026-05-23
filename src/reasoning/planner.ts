import { z } from 'zod';
import {
  EvidencePlanSchema,
  QueryIntentSchema,
  type EvidencePlan,
  type EvidenceRequest,
  type Scope,
  type CapabilityCatalog,
} from '../schemas/index.js';
import type { DiscoveredCatalog } from '../mcp/client.js';
import type { ModelClient } from '../model/client.js';
import { isAllowedCapability } from '../mcp/allowlist.js';

/**
 * Wire schema the planner LLM emits. Differs from EvidencePlanSchema in
 * two ways forced by OpenAI strict-mode structured outputs:
 *   - `parameters` is a JSON-encoded string instead of an open record,
 *     because strict mode rejects `additionalProperties` without a `type`
 *     (and per-capability param shapes vary).
 *   - `expected_role` is `.nullable().optional()`.
 * After the LLM call we JSON.parse `parameters` and hand the result to
 * EvidencePlanSchema for normal validation.
 */
const PlannerLLMRequestSchema = z
  .object({
    capability: z.string().min(1),
    parameters: z
      .string()
      .describe('A JSON-encoded object of parameters matching the capability inputSchema.'),
    intent: QueryIntentSchema,
    expected_role: z.string().min(1).nullable().optional(),
  })
  .strict();

const PlannerLLMOutputSchema = z
  .object({
    requests: z.array(PlannerLLMRequestSchema).min(1),
  })
  .strict();

/**
 * Planner (design §4.7 / §7.2 step 4). Emits an EvidencePlan from the
 * Scope and the discovered capability catalog. The planner **does not**
 * see scope.user_context — that field reaches the reasoner only (§7.3).
 *
 * Validation happens deterministically after the LLM call:
 *   - every requested capability must exist in the supplied catalog
 *   - every requested capability must be in the static read-only allowlist
 *   - duplicate (capability, parameters) requests are deduped
 * One repair pass is attempted on validation failure; a second failure
 * raises PlannerValidationError so the run fails hard.
 */

export class PlannerValidationError extends Error {
  constructor(
    public readonly violations: readonly string[],
    public readonly lastPlan: unknown,
  ) {
    super(`Planner output failed validation after one repair pass: ${violations.join('; ')}`);
    this.name = 'PlannerValidationError';
  }
}

export interface PlannerOptions {
  model: ModelClient;
  systemPrompt: string;
  schemaName?: string;
  temperature?: number;
  seed?: number;
  maxOutputTokens?: number;
}

export class Planner {
  constructor(private readonly options: PlannerOptions) {}

  async plan(scope: Scope, catalog: DiscoveredCatalog): Promise<EvidencePlan> {
    const userPrompt = buildUserPrompt(scope, catalog.raw);
    let plan: EvidencePlan;
    try {
      plan = await this.callModel(userPrompt);
    } catch (err) {
      throw err;
    }

    const violations = validatePlan(plan, catalog);
    if (violations.length === 0) return plan;

    // One repair pass — re-prompt with the violations attached.
    const repairPrompt = `${userPrompt}\n\n## prior_attempt_validation_errors\nThe previous plan failed validation with these errors:\n${violations.map((v) => `- ${v}`).join('\n')}\n\nRe-emit a corrected plan that uses only the capabilities and parameter shapes from the catalog above.`;
    let repaired: EvidencePlan;
    try {
      repaired = await this.callModel(repairPrompt);
    } catch (err) {
      throw err;
    }

    const finalViolations = validatePlan(repaired, catalog);
    if (finalViolations.length > 0) {
      throw new PlannerValidationError(finalViolations, repaired);
    }
    return repaired;
  }

  private async callModel(userPrompt: string): Promise<EvidencePlan> {
    const wire = await this.options.model.generateStructured({
      systemPrompt: this.options.systemPrompt,
      userPrompt,
      schema: PlannerLLMOutputSchema,
      schemaName: this.options.schemaName ?? 'planner_output',
      temperature: this.options.temperature ?? 0,
      ...(this.options.seed !== undefined ? { seed: this.options.seed } : {}),
      ...(this.options.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.options.maxOutputTokens }
        : {}),
    });

    const requests: EvidenceRequest[] = wire.requests.map((r, i) => {
      let parameters: Record<string, unknown>;
      try {
        const parsed = JSON.parse(r.parameters);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('parameters must JSON-decode to an object');
        }
        parameters = parsed as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Planner emitted invalid JSON for request[${i}].parameters: ${(err as Error).message}. Raw: ${r.parameters}`,
        );
      }
      const req: EvidenceRequest = {
        capability: r.capability,
        parameters,
        intent: r.intent,
        ...(r.expected_role ? { expected_role: r.expected_role } : {}),
      };
      return req;
    });

    return EvidencePlanSchema.parse({ requests });
  }
}

function buildUserPrompt(scope: Scope, catalog: CapabilityCatalog): string {
  // Deliberately omit scope.user_context — §7.3 boundary.
  const scopeForPlanner = {
    subscription_ids: scope.subscription_ids,
    resource_group_names: scope.resource_group_names,
    time_window: scope.time_window,
    baseline_window: scope.baseline_window,
    analysis_type: scope.analysis_type,
    resource_type_filter: scope.resource_type_filter,
    effective_scope_summary: scope.effective_scope_summary,
  };

  return [
    '## scope',
    JSON.stringify(scopeForPlanner, null, 2),
    '',
    '## capability_catalog',
    JSON.stringify(
      {
        capabilities: catalog.capabilities.map((c) => ({
          name: c.name,
          version: c.version,
          description: c.description,
          inputSchema: c.inputSchema,
        })),
      },
      null,
      2,
    ),
  ].join('\n');
}

function validatePlan(plan: EvidencePlan, catalog: DiscoveredCatalog): string[] {
  const violations: string[] = [];
  const advertisedNames = new Set(catalog.raw.capabilities.map((c) => c.name));
  const seenKeys = new Set<string>();

  for (let i = 0; i < plan.requests.length; i += 1) {
    const req = plan.requests[i]!;
    if (!advertisedNames.has(req.capability)) {
      violations.push(
        `request[${i}].capability "${req.capability}" is not in the AMG-MCP capability catalog.`,
      );
      continue;
    }
    if (!isAllowedCapability(req.capability)) {
      violations.push(
        `request[${i}].capability "${req.capability}" is not in the Phase 1 read-only allowlist.`,
      );
      continue;
    }
    const key = `${req.capability}::${JSON.stringify(req.parameters)}`;
    if (seenKeys.has(key)) {
      violations.push(
        `request[${i}] duplicates an earlier request for "${req.capability}" with identical parameters.`,
      );
      continue;
    }
    seenKeys.add(key);
  }
  return violations;
}
