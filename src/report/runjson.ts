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
  };
}
