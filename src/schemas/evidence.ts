import { z } from 'zod';
import {
  EvidenceIdSchema,
  TimeWindowSchema,
  ScopeSubsetSchema,
  QueryIntentSchema,
} from './common.js';

// ---------- EvidenceRequest / EvidencePlan (§7.4) ----------
// The planner emits a list of EvidenceRequests that the deterministic
// executor (§4.6) validates against the capability catalog before running.

export const EvidenceRequestSchema = z
  .object({
    capability: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    intent: QueryIntentSchema,
    /**
     * Internal provenance for capabilities whose supported wire schema does
     * not carry scope separately (for example ARG, where scope lives in KQL).
     * The executor never forwards this field to MCP.
     */
    intended_scope_subset: ScopeSubsetSchema.optional(),
    // .nullable().optional() — OpenAI strict-mode structured outputs reject
    // .optional() fields that aren't also .nullable(); see the
    // zod-to-json-schema check at object.ts:50–60 in the OpenAI SDK.
    expected_role: z.string().min(1).nullable().optional(),
  })
  .strict();

export const EvidencePlanSchema = z
  .object({
    requests: z.array(EvidenceRequestSchema).min(1),
  })
  .strict();

export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;

// ---------- EvidenceRecord (§5.2) ----------
// payload_ref is either inline data (small) or a hash pointer into
// run.json (large) — full payloads are kept out of trace spans to
// satisfy the Langfuse PRD redaction requirement (design §4.9).

export const PayloadRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inline'),
      data: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('hash'),
      hash: z.string().min(1),
    })
    .strict(),
]);

export const EvidenceRecordSchema = z
  .object({
    evidence_id: EvidenceIdSchema,
    source_capability: z.string().min(1),
    capability_version: z.string().min(1),
    query_intent: QueryIntentSchema,
    scope_subset: ScopeSubsetSchema,
    time_window: TimeWindowSchema,
    data_freshness: z.string().datetime({ offset: true }).optional(),
    payload_ref: PayloadRefSchema,
    payload_summary: z.unknown(),
    caveats: z.array(z.string().min(1)),
  })
  .strict();

export type PayloadRef = z.infer<typeof PayloadRefSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
