import { extractText, isWrappedError, tryParseJson } from '../mcp/content.js';
import { shortDigest } from '../mcp/digest.js';
import {
  DataQualityFindingSchema,
  EvidenceRecordSchema,
  type DataQualityFinding,
  type EvidenceRecord,
  type ToolCallResult,
} from '../schemas/index.js';
import { scopeSubsetFromParameters } from '../schemas/transport.js';
import type { RawEvidence } from '../evidence/executor.js';
import { COST_WIRE_CAPABILITIES } from './cost-capabilities.js';

/**
 * Cost evidence that remains inspectable in run.json but is deliberately
 * excluded from cost coverage, totals, freshness, and reasoner arithmetic.
 */
export const QUARANTINED_COST_SOURCE_CAPABILITY = 'az_pixiu_quarantined_cost';

export type ZeroCostAssessment =
  | 'valid_zero'
  | 'cost_zero_suspected'
  | 'zero_unresolved'
  | 'cost_scope_mismatch';

export interface ZeroCostAssessmentEntry {
  capability: string;
  parameters_digest: string;
  evidence_id: string;
  subscription_id: string | null;
  assessment: ZeroCostAssessment;
  reason: string;
}

export interface ZeroCostAssessmentResult {
  entries: ZeroCostAssessmentEntry[];
  data_quality: DataQualityFinding[];
}

interface CostObservation {
  raw: RawEvidence;
  evidence_id: string;
  subscription_id: string | null;
  total: number | null;
  has_non_zero_components: boolean;
  has_invalid_components: boolean;
  returned_scope: 'matched' | 'mismatched' | 'unknown';
}

/**
 * Assess every structurally readable zero or missing-total cost payload in a
 * retrieval batch. Zero is accepted only when the batch also proves the
 * subscription is genuinely empty. A matching request/response scope without
 * corroboration is intentionally unresolved; an absent numeric aggregate is
 * never converted into authoritative zero.
 */
export function assessCostZeroEvidence(rawList: readonly RawEvidence[]): ZeroCostAssessmentResult {
  const observations = rawList
    .map(inspectCostObservation)
    .filter((v): v is CostObservation => v !== null);
  const resourceCounts = collectSubscriptionResourceCounts(rawList);
  const entries: ZeroCostAssessmentEntry[] = [];
  const data_quality: DataQualityFinding[] = [];

  for (const observation of observations) {
    let assessment: ZeroCostAssessment;
    let reason: string;
    const sub = observation.subscription_id;
    const hasAdjacentNonZero =
      sub !== null &&
      observations.some(
        (other) =>
          other !== observation &&
          other.subscription_id !== null &&
          sameId(other.subscription_id, sub) &&
          other.total !== null &&
          other.total !== 0,
      );

    if (observation.total === null && observation.has_non_zero_components) {
      assessment = 'cost_zero_suspected';
      reason = 'the payload omits a numeric total while carrying non-zero cost rows or dimensions';
    } else if (observation.total === null) {
      assessment = 'zero_unresolved';
      reason = observation.has_invalid_components
        ? 'the payload omits a numeric total or contains malformed cost rows/dimensions, so it cannot establish zero cost'
        : 'the payload omits a numeric total, so an empty or missing aggregate cannot establish zero cost';
    } else if (observation.returned_scope === 'mismatched') {
      assessment = 'cost_scope_mismatch';
      reason = 'the structured cost payload did not return exactly the subscription set requested by the call';
    } else if (observation.total !== 0) {
      continue;
    } else if (observation.has_non_zero_components) {
      assessment = 'cost_zero_suspected';
      reason = 'the zero total conflicts with non-zero cost rows or dimensions in the same payload';
    } else if (observation.has_invalid_components) {
      assessment = 'zero_unresolved';
      reason = 'one or more cost rows or dimensions omit a finite numeric cost, so the zero cannot be validated';
    } else if (hasAdjacentNonZero) {
      assessment = 'cost_zero_suspected';
      reason = 'another cost record in the same retrieval batch reports non-zero cost for this subscription';
    } else if (
      observation.returned_scope === 'matched' &&
      sub !== null &&
      resourceCounts.get(normalizeId(sub)) === 0
    ) {
      assessment = 'valid_zero';
      reason = 'the returned subscription scope matches and subscription inventory reports zero resources';
    } else {
      assessment = 'zero_unresolved';
      reason =
        observation.returned_scope === 'unknown'
          ? 'the payload does not carry enough returned-scope evidence to validate the zero'
          : 'the zero is internally consistent but lacks corroborating empty-scope evidence';
    }

    const entry: ZeroCostAssessmentEntry = {
      capability: observation.raw.request.capability,
      parameters_digest: observation.raw.parameters_digest,
      evidence_id: observation.evidence_id,
      subscription_id: sub,
      assessment,
      reason,
    };
    entries.push(entry);

    if (assessment !== 'valid_zero') {
      data_quality.push(
        DataQualityFindingSchema.parse({
          dq_id: `dq-cost-zero-${data_quality.length + 1}`,
          category: assessment,
          affected_capability: observation.raw.request.capability,
          affected_scope_subset: sub
            ? {
                subscription_ids: [sub],
                resource_group_names: null,
                resource_ids: null,
              }
            : null,
          consequence_for_analysis:
            `The cost response was quarantined (${assessment}): ${reason}. ` +
            'It is excluded from cost coverage, trend, savings, and impact arithmetic.',
          impact_on_recommendations: [],
          actionable_hint:
            assessment === 'cost_scope_mismatch'
              ? 'Verify that the request and every returned subscriptionId describe the same exact subscription set before using this cost payload.'
              : 'Retry the same window and compare it with an adjacent period and returned subscription scope before treating zero as authoritative.',
        }),
      );
    }
  }

  return { entries, data_quality };
}

/**
 * Keep quarantined payloads inspectable for provenance while removing them
 * from every surface keyed to COST_EVIDENCE_CAPABILITIES. The reasoner receives
 * a filtered evidence list, so these records cannot become numeric facts.
 */
export function markQuarantinedCostEvidence(
  records: readonly EvidenceRecord[],
  assessment: ZeroCostAssessmentResult,
): EvidenceRecord[] {
  const quarantined = new Map(
    assessment.entries
      .filter((entry) => entry.assessment !== 'valid_zero')
      .map((entry) => [entry.evidence_id, entry] as const),
  );
  return records.map((record) => {
    const entry = quarantined.get(record.evidence_id);
    if (!entry) return record;
    const summary =
      typeof record.payload_summary === 'object' && record.payload_summary !== null
        ? (record.payload_summary as Record<string, unknown>)
        : {};
    return EvidenceRecordSchema.parse({
      ...record,
      source_capability: QUARANTINED_COST_SOURCE_CAPABILITY,
      payload_summary: {
        ...summary,
        original_source_capability: entry.capability,
        zero_cost_assessment: entry.assessment,
      },
      caveats: [
        ...record.caveats,
        `Quarantined ${entry.assessment}: ${entry.reason}. This payload is provenance only and is not cost evidence for arithmetic or coverage.`,
      ],
    });
  });
}

export function findZeroAssessment(
  result: ZeroCostAssessmentResult,
  raw: RawEvidence,
): ZeroCostAssessmentEntry | undefined {
  return result.entries.find(
    (entry) =>
      entry.capability === raw.request.capability &&
      entry.parameters_digest === raw.parameters_digest,
  );
}

function inspectCostObservation(raw: RawEvidence): CostObservation | null {
  if (!COST_WIRE_CAPABILITIES.has(raw.request.capability)) return null;
  const requested = scopeSubsetFromParameters(raw.request.parameters)?.subscription_ids ?? [];
  const requestedSub = requested.length === 1 ? requested[0]! : null;
  const evidence_id = `ev-${raw.request.capability}-${shortDigest(raw.parameters_digest)}`;
  const missingTotalObservation: CostObservation = {
    raw,
    evidence_id,
    subscription_id: requestedSub,
    total: null,
    has_non_zero_components: false,
    has_invalid_components: false,
    returned_scope: 'unknown',
  };
  const decoded = decode(raw.result);
  if (decoded === undefined || decoded === null || typeof decoded !== 'object') {
    return missingTotalObservation;
  }

  if (!Array.isArray(decoded) && Array.isArray((decoded as Record<string, unknown>).subscriptions)) {
    const subscriptions = (decoded as Record<string, unknown>).subscriptions as unknown[];
    let total = 0;
    let sawNumericTotal = false;
    let missingNumericTotal = subscriptions.length === 0;
    let hasNonZeroComponents = false;
    let hasInvalidComponents = false;
    const returnedIds: string[] = [];
    let missingReturnedId = subscriptions.length === 0;

    for (const item of subscriptions) {
      if (typeof item !== 'object' || item === null) {
        missingNumericTotal = true;
        missingReturnedId = true;
        continue;
      }
      const sub = item as Record<string, unknown>;
      const id = firstString(sub, ['subscriptionId', 'subscription_id', 'id']);
      if (id) returnedIds.push(id);
      else missingReturnedId = true;
      if (typeof sub.totalCost === 'number' && Number.isFinite(sub.totalCost)) {
        total += sub.totalCost;
        sawNumericTotal = true;
      } else {
        missingNumericTotal = true;
      }
      const serviceState = inspectCostDimension(sub.byService, true);
      hasNonZeroComponents ||= serviceState.has_non_zero;
      hasInvalidComponents ||= serviceState.invalid;
      for (const key of ['byRegion', 'byResourceType', 'byResourceGroup']) {
        const state = inspectCostDimension(sub[key], false);
        hasNonZeroComponents ||= state.has_non_zero;
        hasInvalidComponents ||= state.invalid;
      }
    }
    const requestedKeys = Array.from(new Set(requested.map(normalizeId)));
    const normalizedReturned = returnedIds.map(normalizeId);
    const uniqueReturned = Array.from(new Set(normalizedReturned));
    const returned_scope =
      requestedKeys.length === 0
        ? 'unknown'
        : missingReturnedId ||
            normalizedReturned.length !== uniqueReturned.length ||
            !sameStringSet(requestedKeys, uniqueReturned)
          ? 'mismatched'
          : 'matched';
    return {
      raw,
      evidence_id,
      subscription_id: requestedSub,
      total: sawNumericTotal && !missingNumericTotal ? total : null,
      has_non_zero_components: hasNonZeroComponents,
      has_invalid_components: hasInvalidComponents,
      returned_scope,
    };
  }

  if (!Array.isArray(decoded)) {
    const obj = decoded as Record<string, unknown>;
    if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) {
      const columnNames = obj.columns.map((column) =>
        typeof column === 'object' && column !== null && typeof (column as { name?: unknown }).name === 'string'
          ? (column as { name: string }).name
          : '',
      );
      const costIndex = columnNames.indexOf('Cost');
      const rowCosts: number[] = [];
      let hasInvalidComponents = costIndex < 0;
      if (costIndex >= 0) {
        for (const row of obj.rows) {
          if (!Array.isArray(row)) {
            hasInvalidComponents = true;
            continue;
          }
          const cost = row[costIndex];
          if (typeof cost !== 'number' || !Number.isFinite(cost)) {
            hasInvalidComponents = true;
            continue;
          }
          rowCosts.push(cost);
        }
      }
      const totalObj = obj.total as { cost?: unknown } | undefined;
      const total =
        typeof totalObj?.cost === 'number' && Number.isFinite(totalObj.cost)
          ? totalObj.cost
          : costIndex >= 0
            ? rowCosts.reduce((sum, cost) => sum + cost, 0)
            : null;
      return {
        raw,
        evidence_id,
        subscription_id: requestedSub,
        total,
        has_non_zero_components: rowCosts.some((cost) => cost !== 0),
        has_invalid_components: hasInvalidComponents,
        returned_scope: 'unknown',
      };
    }
  }
  return missingTotalObservation;
}

function collectSubscriptionResourceCounts(rawList: readonly RawEvidence[]): Map<string, number> {
  const counts = new Map<string, number>();
  const invalid = new Set<string>();
  for (const raw of rawList) {
    if (raw.request.capability !== 'amgmcp_query_azure_subscriptions') continue;
    const decoded = decode(raw.result);
    const rows = subscriptionRows(decoded);
    for (const item of rows) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const id = firstString(row, ['subscriptionId', 'subscription_id', 'id']);
      const count = firstNumber(row, [
        'resourceCount',
        'resource_count',
        'totalResources',
        'total_resources',
      ]);
      if (!id) continue;
      const key = normalizeId(id);
      if (count === undefined) {
        invalid.add(key);
        counts.delete(key);
        continue;
      }
      if (!Number.isInteger(count) || count < 0) {
        invalid.add(key);
        counts.delete(key);
        continue;
      }
      if (invalid.has(key)) continue;
      // A positive observation wins over zero if the payload repeats a row.
      counts.set(key, Math.max(counts.get(key) ?? 0, count));
    }
  }
  return counts;
}

function subscriptionRows(decoded: unknown): unknown[] {
  if (Array.isArray(decoded)) return decoded;
  if (typeof decoded !== 'object' || decoded === null) return [];
  const obj = decoded as Record<string, unknown>;
  if (Array.isArray(obj.subscriptions)) return obj.subscriptions;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function decode(result: ToolCallResult): unknown {
  const text = extractText(result);
  if (isWrappedError(text)) return undefined;
  const parsed = tryParseJson(text);
  return parsed ?? (text.length > 0 ? undefined : result.content);
}

function inspectCostDimension(
  value: unknown,
  required: boolean,
): { has_non_zero: boolean; invalid: boolean } {
  if (value === undefined) return { has_non_zero: false, invalid: required };
  if (!Array.isArray(value)) return { has_non_zero: false, invalid: true };
  let hasNonZero = false;
  let invalid = false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      invalid = true;
      continue;
    }
    const cost = (item as Record<string, unknown>).cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost)) {
      invalid = true;
      continue;
    }
    if (cost !== 0) hasNonZero = true;
  }
  return { has_non_zero: hasNonZero, invalid };
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (typeof row[key] === 'string' && (row[key] as string).length > 0) return row[key] as string;
  }
  return '';
}

function firstNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key] as number)) return row[key] as number;
  }
  return undefined;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function sameId(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((value) => right.has(value));
}
