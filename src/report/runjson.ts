import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import type {
  ReasoningOutput,
  Scope,
  RunMetadata,
  EvidenceRecord,
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
): RunArtifact {
  return {
    schema_version: RUN_JSON_SCHEMA_VERSION,
    metadata,
    scope,
    evidence,
    reasoning,
  };
}
