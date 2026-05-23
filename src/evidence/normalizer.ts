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
import { extractText, tryParseJson, isWrappedError, classifyWrappedError } from '../mcp/content.js';

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

      // Decode MCP-standard content: typically `content: [{type:"text", text:"..."}]`.
      // The text may be a JSON-stringified payload, plain text, or an
      // AMG-MCP wrapped error envelope (e.g., Grafana data-source auth
      // failure surfaced as a successful tool result).
      const rawContent = raw.result.content;
      const text = extractText(raw.result);
      const wrapped = isWrappedError(text);
      const parsed = wrapped ? undefined : tryParseJson(text);
      const decoded: unknown = parsed ?? (text.length > 0 ? text : rawContent);

      if (wrapped) {
        const category = classifyWrappedError(text);
        caveats.push(`upstream wrapped error: ${text.slice(0, 120)}`);
        data_quality.push(
          DataQualityFindingSchema.parse({
            dq_id: `dq-${++dqCounter}`,
            category,
            affected_capability: raw.request.capability,
            affected_scope_subset: scope_subset,
            consequence_for_analysis: `${raw.request.capability} returned a wrapped error (${category}) instead of data: ${text.slice(0, 240)}`,
            impact_on_recommendations: [],
            actionable_hint:
              category === 'auth'
                ? 'Re-authenticate (e.g., `az login`) and check that the Grafana Azure Monitor data source can authenticate to Azure on behalf of your identity.'
                : category === 'authz_gap'
                  ? 'Ensure your identity (or the Grafana data source service principal) holds Reader on the target scope.'
                  : 'Inspect the raw payload — the response did not match a known data shape.',
          }),
        );
      } else if (isEmptyResult(decoded)) {
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
      } else if (raw.request.capability === 'amgmcp_query_resource_graph') {
        const tagging = inspectTagging(decoded);
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

      // For cost-analysis evidence, the response payload always carries
      // the subscription set it actually covers (`subscriptions[].subscriptionId`
      // in the live AMG-MCP shape). Promote those into scope_subset when
      // the request parameters didn't already, so coverage detection
      // (src/report/coverage.ts) works against any plan source —
      // playbook (snake_case params), planner LLM (camelCase), or future
      // multi-sub fan-in.
      const enrichedScope =
        raw.request.capability === 'amgmcp_cost_analysis' || raw.request.capability === 'cost_analysis'
          ? mergeScopeFromCostPayload(scope_subset, decoded)
          : scope_subset;

      const record = EvidenceRecordSchema.parse({
        evidence_id,
        source_capability: raw.request.capability,
        capability_version: raw.capability_version,
        query_intent: raw.request.intent,
        scope_subset: enrichedScope,
        time_window,
        payload_ref: { kind: 'inline', data: decoded },
        payload_summary: summarize(raw.request.capability, decoded),
        caveats,
      });

      records.push(record);
    }

    return { records, data_quality };
  }
}

// --- helpers ---

function extractScopeSubset(params: Record<string, unknown>): ScopeSubset {
  let subscription_ids: string[] | null = null;
  let resource_group_names: string[] | null = null;
  let resource_ids: string[] | null = null;

  // Accept both the playbook's snake_case naming and the planner LLM's
  // camelCase (which mirrors AMG-MCP's published JSON schema).
  for (const key of ['subscription_id', 'subscriptionId']) {
    const v = params[key];
    if (typeof v === 'string') {
      subscription_ids = subscription_ids ?? [];
      subscription_ids.push(v);
    }
  }
  for (const key of ['subscription_ids', 'subscriptionIds']) {
    const v = params[key];
    if (Array.isArray(v)) {
      subscription_ids = subscription_ids ?? [];
      for (const s of v) if (typeof s === 'string') subscription_ids.push(s);
    }
  }
  for (const key of ['resource_group_name', 'resourceGroupName']) {
    const v = params[key];
    if (typeof v === 'string') {
      resource_group_names = resource_group_names ?? [];
      resource_group_names.push(v);
    }
  }
  for (const key of ['resource_group_names', 'resourceGroupNames']) {
    const v = params[key];
    if (Array.isArray(v)) {
      resource_group_names = resource_group_names ?? [];
      for (const s of v) if (typeof s === 'string') resource_group_names.push(s);
    }
  }
  for (const key of ['resource_ids', 'resourceIds']) {
    const v = params[key];
    if (Array.isArray(v)) {
      resource_ids = resource_ids ?? [];
      for (const s of v) if (typeof s === 'string') resource_ids.push(s);
    }
  }
  return {
    subscription_ids: subscription_ids ? Array.from(new Set(subscription_ids)) : null,
    resource_group_names: resource_group_names ? Array.from(new Set(resource_group_names)) : null,
    resource_ids: resource_ids ? Array.from(new Set(resource_ids)) : null,
  };
}

/**
 * Walk the cost_analysis response payload and union the subscriptions
 * it actually covers into the request-derived scope_subset. The live
 * AMG-MCP shape is `{ subscriptions: [{ subscriptionId, ... }, ...] }`;
 * the tabular fixture shape uses `{ rows: [[..., subscriptionId, ...]] }`
 * less often, so we only mine the structured field. When no usable
 * payload subscriptions are present, the original scope_subset is
 * returned unchanged.
 */
function mergeScopeFromCostPayload(initial: ScopeSubset, payload: unknown): ScopeSubset {
  if (typeof payload !== 'object' || payload === null) return initial;
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.subscriptions)) return initial;
  const ids: string[] = [];
  for (const sub of obj.subscriptions) {
    if (typeof sub !== 'object' || sub === null) continue;
    const s = sub as Record<string, unknown>;
    const v = s.subscriptionId ?? s.subscription_id ?? s.id;
    if (typeof v === 'string' && v.length > 0) ids.push(v);
  }
  if (ids.length === 0) return initial;
  const merged = new Set<string>([...(initial.subscription_ids ?? []), ...ids]);
  return {
    subscription_ids: Array.from(merged),
    resource_group_names: initial.resource_group_names,
    resource_ids: initial.resource_ids,
  };
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
    case 'amgmcp_cost_analysis': {
      const rows = Array.isArray(c.rows) ? c.rows : [];
      const total = (c.total as { cost?: number; currency?: string } | undefined) ?? {};
      // Live AMG-MCP shape ({subscriptions: [{totalCost, byService, ...}]})
      // carries no rows/total, so fall through to a subscriptions
      // rollup that produces the same summary shape.
      if (rows.length === 0 && total.cost === undefined && Array.isArray(c.subscriptions)) {
        let liveTotal = 0;
        let liveCurrency: string | undefined;
        let liveServiceCount = 0;
        for (const sub of c.subscriptions) {
          if (typeof sub !== 'object' || sub === null) continue;
          const s = sub as Record<string, unknown>;
          if (typeof s.totalCost === 'number') liveTotal += s.totalCost;
          if (!liveCurrency && typeof s.currency === 'string') liveCurrency = s.currency;
          if (Array.isArray(s.byService)) liveServiceCount += s.byService.length;
        }
        return {
          capability,
          row_count: liveServiceCount,
          total_cost: liveTotal,
          currency: liveCurrency,
        };
      }
      return {
        capability,
        row_count: rows.length,
        total_cost: total.cost,
        currency: total.currency,
      };
    }
    case 'amgmcp_query_resource_graph': {
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
    case 'amgmcp_query_resource_metric': {
      const series = Array.isArray(c.series) ? c.series : Array.isArray(c.data) ? c.data : [];
      return { capability, series_count: series.length };
    }
    case 'amgmcp_query_resource_metric_definition': {
      const metrics = Array.isArray(c.metrics) ? c.metrics : Array.isArray(c.data) ? c.data : [];
      return { capability, metric_count: metrics.length };
    }
    case 'amgmcp_query_activity_log': {
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
    case 'amgmcp_query_resource_health': {
      const transitions = Array.isArray(c.transitions) ? c.transitions : Array.isArray(c.data) ? c.data : [];
      return { capability, transition_count: transitions.length };
    }
    case 'amgmcp_query_azure_subscriptions': {
      const subs = Array.isArray(c.subscriptions) ? c.subscriptions : [];
      return { capability, subscription_count: subs.length };
    }
    default:
      return { capability, payload_type: 'unrecognized' };
  }
}
