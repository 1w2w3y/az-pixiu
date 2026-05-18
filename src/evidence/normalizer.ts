import {
  EvidenceRecordSchema,
  DataQualityFindingSchema,
  type EvidenceRecord,
  type DataQualityFinding,
  type TimeWindow,
  type ScopeSubset,
} from '../schemas/index.js';
import type { RawEvidence } from './executor.js';
import { isEmptyResult } from '../failure/taxonomy.js';
import { shortDigest } from '../mcp/digest.js';

export interface NormalizationContext {
  /**
   * Time window to attribute to records whose request did not carry a
   * time_window parameter (e.g., query_azure_subscriptions). Typically
   * the run's analysis window from Scope.
   */
  defaultTimeWindow: TimeWindow;
}

export interface NormalizationResult {
  records: EvidenceRecord[];
  data_quality: DataQualityFinding[];
}

/**
 * Evidence normalizer (design §4.6 / §7.2 step 6). Converts the
 * executor's RawEvidence into EvidenceRecord with full provenance, and
 * surfaces analytical-quality concerns (empty results, tagging gaps) as
 * DataQualityFindings. The categories produced here are disjoint from the
 * failure_taxonomy's call-failure categories — empty_result here means
 * the call *succeeded* but with no useful content.
 *
 * Per-capability payload summarization keeps span payloads small (design
 * §4.9 redaction) while full payloads stay in run.json via inline
 * payload_ref. Phase 1 inlines everything; the hash variant is reserved
 * for when individual payloads grow beyond an in-memory comfort zone.
 */
export class EvidenceNormalizer {
  normalize(rawList: RawEvidence[], context: NormalizationContext): NormalizationResult {
    const records: EvidenceRecord[] = [];
    const data_quality: DataQualityFinding[] = [];
    let dqCounter = 0;

    for (const raw of rawList) {
      const evidence_id = `ev-${raw.request.capability}-${shortDigest(raw.parameters_digest)}`;
      const scope_subset = extractScopeSubset(raw.request.parameters);
      const time_window = extractTimeWindow(raw.request.parameters) ?? context.defaultTimeWindow;
      const caveats: string[] = [];

      const content = raw.result.content;

      if (isEmptyResult(content)) {
        caveats.push('empty payload from upstream');
        data_quality.push(
          DataQualityFindingSchema.parse({
            dq_id: `dq-${++dqCounter}`,
            category: 'empty_result',
            affected_capability: raw.request.capability,
            affected_scope_subset: scope_subset,
            consequence_for_analysis: `${raw.request.capability} returned no data for this slice.`,
            impact_on_recommendations: [],
            actionable_hint: 'Confirm the scope and window cover an interval with activity.',
          }),
        );
      } else if (raw.request.capability === 'query_resource_graph') {
        const tagging = inspectTagging(content);
        if (tagging.total > 0 && tagging.untagged / tagging.total >= 0.5) {
          caveats.push(`${tagging.untagged}/${tagging.total} resources untagged`);
          data_quality.push(
            DataQualityFindingSchema.parse({
              dq_id: `dq-${++dqCounter}`,
              category: 'tagging_gap',
              affected_capability: raw.request.capability,
              affected_scope_subset: scope_subset,
              consequence_for_analysis:
                'Owner/cost-center grouping is unreliable when half or more of the inventoried resources lack tags.',
              impact_on_recommendations: [],
              actionable_hint:
                'Apply a tagging policy to the affected resource groups so cost can be attributed.',
            }),
          );
        }
      }

      const record = EvidenceRecordSchema.parse({
        evidence_id,
        source_capability: raw.request.capability,
        capability_version: raw.capability_version,
        query_intent: raw.request.intent,
        scope_subset,
        time_window,
        payload_ref: { kind: 'inline', data: content },
        payload_summary: summarize(raw.request.capability, content),
        caveats,
      });

      records.push(record);
    }

    return { records, data_quality };
  }
}

// --- helpers ---

function extractScopeSubset(params: Record<string, unknown>): ScopeSubset {
  const subset: ScopeSubset = {};
  if (typeof params.subscription_id === 'string') {
    subset.subscription_ids = [params.subscription_id];
  } else if (Array.isArray(params.subscription_ids)) {
    subset.subscription_ids = params.subscription_ids.filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (typeof params.resource_group_name === 'string') {
    subset.resource_group_names = [params.resource_group_name];
  } else if (Array.isArray(params.resource_group_names)) {
    subset.resource_group_names = params.resource_group_names.filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (Array.isArray(params.resource_ids)) {
    subset.resource_ids = params.resource_ids.filter((s): s is string => typeof s === 'string');
  }
  return subset;
}

function extractTimeWindow(params: Record<string, unknown>): TimeWindow | undefined {
  const tw = params.time_window;
  if (typeof tw !== 'object' || tw === null) return undefined;
  const obj = tw as { start?: unknown; end?: unknown };
  if (typeof obj.start !== 'string' || typeof obj.end !== 'string') return undefined;
  if (new Date(obj.end).getTime() <= new Date(obj.start).getTime()) return undefined;
  return { start: obj.start, end: obj.end };
}

interface TaggingStats {
  total: number;
  untagged: number;
}

function inspectTagging(content: unknown): TaggingStats {
  if (typeof content !== 'object' || content === null) return { total: 0, untagged: 0 };
  const data = (content as { data?: unknown }).data;
  if (!Array.isArray(data)) return { total: 0, untagged: 0 };
  let untagged = 0;
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const tags = (row as { tags?: unknown }).tags;
    if (
      tags === undefined ||
      tags === null ||
      (typeof tags === 'object' && Object.keys(tags as object).length === 0)
    ) {
      untagged += 1;
    }
  }
  return { total: data.length, untagged };
}

function summarize(capability: string, content: unknown): unknown {
  if (typeof content !== 'object' || content === null) {
    return { capability, payload_type: 'scalar', value: content };
  }
  const c = content as Record<string, unknown>;

  switch (capability) {
    case 'cost_analysis': {
      const rows = Array.isArray(c.rows) ? c.rows : [];
      const total = (c.total as { cost?: number; currency?: string } | undefined) ?? {};
      return {
        capability,
        row_count: rows.length,
        total_cost: total.cost,
        currency: total.currency,
      };
    }
    case 'query_resource_graph': {
      const data = Array.isArray(c.data) ? c.data : [];
      const sample = data
        .slice(0, 3)
        .map((row) =>
          typeof row === 'object' && row !== null
            ? (row as { name?: string; id?: string }).name ??
              (row as { id?: string }).id ??
              '(no name)'
            : String(row),
        );
      return {
        capability,
        count: typeof c.count === 'number' ? c.count : data.length,
        sample_names: sample,
      };
    }
    case 'query_resource_metric': {
      const series = Array.isArray(c.series) ? c.series : Array.isArray(c.data) ? c.data : [];
      return { capability, series_count: series.length };
    }
    case 'query_resource_metric_definition': {
      const metrics = Array.isArray(c.metrics) ? c.metrics : Array.isArray(c.data) ? c.data : [];
      return { capability, metric_count: metrics.length };
    }
    case 'query_activity_log': {
      const entries = Array.isArray(c.entries) ? c.entries : [];
      return {
        capability,
        entry_count: entries.length,
        operations: Array.from(
          new Set(
            entries
              .map((e) => (typeof e === 'object' && e !== null ? (e as { operation?: string }).operation : undefined))
              .filter((s): s is string => typeof s === 'string'),
          ),
        ),
      };
    }
    case 'query_resource_health': {
      const transitions = Array.isArray(c.transitions) ? c.transitions : Array.isArray(c.data) ? c.data : [];
      return { capability, transition_count: transitions.length };
    }
    case 'query_azure_subscriptions': {
      const subs = Array.isArray(c.subscriptions) ? c.subscriptions : [];
      return { capability, subscription_count: subs.length };
    }
    default:
      return { capability, payload_type: 'unrecognized' };
  }
}
