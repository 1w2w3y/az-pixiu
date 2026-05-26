import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
  DataQualityFinding,
  TransportSummaryEntry,
} from '../schemas/index.js';
import type { WasteLaneResult } from '../playbooks/waste-lanes/types.js';
import type { LaneTotal, EstimateResult } from '../pricing/impact.js';

/**
 * Per-run output envelope for run.json (design §10.2, §15.6). Versioned
 * via schema_version so Phase 2 dataset ingestion can detect Phase 1
 * envelope evolution.
 */
export const RUN_JSON_SCHEMA_VERSION = '1' as const;

export interface RunArtifact {
  schema_version: typeof RUN_JSON_SCHEMA_VERSION;
  metadata: RunMetadata;
  scope: Scope;
  evidence: EvidenceRecord[];
  reasoning: ReasoningOutput;
  /**
   * Data-quality findings surfaced *before* the reasoner ran — the
   * normalizer's own findings (e.g., tagging_gap from a resource_graph
   * payload) plus the failure-taxonomy's classifications. The reasoner
   * receives these as a prompt block; whatever it endorses lands in
   * `reasoning.data_quality`. Persisting the pre-reasoner set
   * separately preserves provenance: an operator can see what was
   * detected during retrieval, and a reviewer can spot a finding the
   * reasoner silently dropped. Optional so older artefacts written
   * before this field existed still parse.
   */
  input_data_quality?: DataQualityFinding[];
  /**
   * Per-logical-request transport summary (Phase 3 — design/cron-comparison-improvements.md §S4).
   * One entry per evidence request, capturing attempt/retry counts,
   * cumulative backoff, and final outcome. Phase 3 PR 1 emits single-
   * attempt rows; PR 2 (§Gap 7 retry) fills in real retry counts. Older
   * artefacts written before this field existed continue to parse.
   */
  transport_summary?: TransportSummaryEntry[];
  /**
   * Phase 3 — design/cost-summary-depth.md §Gap 1. Per-lane summary of
   * the waste candidates the WasteDetectionExecutor surfaced, with the
   * lane's classification predicate, the per-candidate rate-lookup
   * outcome, and the rolled-up lane total. Indexed here (alongside
   * `transport_summary`) so the `RunHistoryStore` can answer per-lane
   * continuity questions in PR 4 without re-walking the evidence
   * records. Empty/absent for analysis types that do not run lanes.
   */
  waste_lanes?: WasteLanesBlockEntry[];
}

export interface WasteLanesBlockCandidate {
  resource_id: string;
  name: string;
  subscription_id: string;
  resource_group: string;
  location: string;
  sku: string;
  fields: Record<string, string>;
  evidence_id: string;
  estimated_weekly_impact: EstimateResult;
}

export interface WasteLanesBlockEntry {
  /** Machine-readable lane name (e.g. 'orphan_public_ip'). */
  name: string;
  /** Human-readable title used in the report. */
  title: string;
  /** Wire capability the lane ultimately hit (always ARG today). */
  source_capability: string;
  /** Predicate the lane cited to classify each row. */
  predicate: string;
  /** Rate-card snapshot date, propagated to the per-lane footnote. */
  rate_source_captured_at: string;
  candidates: WasteLanesBlockCandidate[];
  lane_total: LaneTotal;
  /** True when the ARG call exhausted retries or otherwise failed. */
  failed: boolean;
  /** Rows the parser could not interpret; surfaced for transparency. */
  unparsed_row_count: number;
}

export interface WriteRunArtifactOptions {
  path: string;
  artifact: RunArtifact;
  /**
   * Atomic write: serialize → temp file → rename. Avoids leaving a
   * half-written run.json when the process is killed mid-write.
   */
  atomic?: boolean;
}

export async function writeRunArtifact(options: WriteRunArtifactOptions): Promise<string> {
  const finalPath = isAbsolute(options.path)
    ? options.path
    : resolve(process.cwd(), options.path);
  await mkdir(dirname(finalPath), { recursive: true });
  const serialized = JSON.stringify(options.artifact, null, 2) + '\n';
  if (options.atomic === false) {
    await writeFile(finalPath, serialized, 'utf8');
    return finalPath;
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, serialized, 'utf8');
  await rename(tempPath, finalPath);
  return finalPath;
}

export function buildRunArtifact(
  metadata: RunMetadata,
  scope: Scope,
  evidence: EvidenceRecord[],
  reasoning: ReasoningOutput,
  inputDataQuality?: DataQualityFinding[],
  transportSummary?: TransportSummaryEntry[],
  wasteLanes?: WasteLaneResult[],
): RunArtifact {
  return {
    schema_version: RUN_JSON_SCHEMA_VERSION,
    metadata,
    scope,
    evidence,
    reasoning,
    ...(inputDataQuality && inputDataQuality.length > 0
      ? { input_data_quality: inputDataQuality }
      : {}),
    ...(transportSummary && transportSummary.length > 0
      ? { transport_summary: transportSummary }
      : {}),
    ...(wasteLanes && wasteLanes.length > 0
      ? { waste_lanes: wasteLanes.map(toWasteLaneBlockEntry) }
      : {}),
  };
}

function toWasteLaneBlockEntry(result: WasteLaneResult): WasteLanesBlockEntry {
  return {
    name: result.lane,
    title: result.title,
    source_capability: result.source_capability,
    predicate: result.predicate_text,
    rate_source_captured_at: result.rate_source_captured_at,
    candidates: result.candidates.map((c) => ({
      resource_id: c.candidate.resource_id,
      name: c.candidate.name,
      subscription_id: c.candidate.subscription_id,
      resource_group: c.candidate.resource_group,
      location: c.candidate.location,
      sku: c.candidate.sku,
      fields: c.candidate.fields,
      evidence_id: c.evidence.evidence_id,
      estimated_weekly_impact: c.estimated_weekly_impact,
    })),
    lane_total: result.lane_total,
    failed: result.failed,
    unparsed_row_count: result.unparsed_row_count,
  };
}
