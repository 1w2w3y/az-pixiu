import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  FindPriorRunsOptions,
  PriorRecommendationSummary,
  RunHistoryStore,
  RunSummary,
} from './store.js';
import { computeScopeSignature } from '../run/scope-signature.js';
import type { RunArtifact } from '../report/runjson.js';

/**
 * Filesystem-backed {@link RunHistoryStore}. Indexes the existing
 * `runs/<run-id>/run.json` artefacts that the orchestrator writes; no
 * new persistent store is introduced (design §Gap 5 — the local
 * fallback that keeps offline-first operation working as a default).
 *
 * On every query, the store walks `runs/`, reads each `run.json`,
 * derives its scope signature, and returns the matching summaries. This
 * is fine for the hundreds-of-runs scale a single operator accumulates
 * locally; performance becomes a problem at thousands, at which point
 * a SQLite-backed implementation can be swapped in without changing
 * the interface.
 *
 * Concrete behaviour worth knowing:
 *   - Malformed run.json files are skipped, not raised. A partially
 *     written artefact (rare, since the writer is atomic) or an
 *     artefact written by an incompatible schema_version should not
 *     fail the analysis that called us.
 *   - Subdirectories without a `run.json` (e.g. `runs/eval/...` from
 *     the eval runner) are walked one level deep so eval-runner runs
 *     are included alongside `pixiu analyze` runs.
 *   - Results are sorted descending by `started_at` so the caller can
 *     trivially compute "N consecutive runs since" by walking the list.
 */
export class FilesystemRunHistoryStore implements RunHistoryStore {
  private readonly runsDir: string;

  constructor(options: { runsDir: string }) {
    this.runsDir = options.runsDir;
  }

  async findPriorRuns(options: FindPriorRunsOptions): Promise<RunSummary[]> {
    const limit = options.limit ?? 12;
    const summaries: RunSummary[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch (err) {
      // No runs directory yet — first run against this operator's
      // filesystem. Returning [] is the correct "no continuity available"
      // signal; the design treats absence as conservative-by-default.
      if (isNoEntError(err)) return [];
      throw err;
    }

    for (const entry of entries) {
      const entryPath = join(this.runsDir, entry);
      const summary = await this.readDirectory(entryPath);
      if (summary) summaries.push(summary);
    }

    return summaries
      .filter((s) => s.analysis_type === options.analysis_type)
      .filter((s) => s.scope_signature === options.scope_signature)
      .filter((s) => options.excludeRunId === undefined || s.run_id !== options.excludeRunId)
      .filter((s) => options.startedAtMin === undefined || s.started_at >= options.startedAtMin)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Try to read a `run.json` directly under `entryPath`. If `entryPath`
   * is a directory that contains nested `<id>/run.json` files instead
   * (the eval runner's `runs/eval/<item-id>/<run-id>/run.json` layout),
   * walk one level deeper. Returns the *first* summary read at each
   * leaf; the caller flattens.
   */
  private async readDirectory(entryPath: string): Promise<RunSummary | undefined> {
    const directRunJson = join(entryPath, 'run.json');
    const direct = await tryReadRunJson(directRunJson);
    if (direct) return summarise(direct);

    // No direct run.json — entryPath might be an intermediate dir (e.g.
    // `runs/eval`). One level of recursion covers `runs/eval/<item>/<id>/run.json`.
    let nested: string[];
    try {
      const statResult = await stat(entryPath);
      if (!statResult.isDirectory()) return undefined;
      nested = await readdir(entryPath);
    } catch (err) {
      if (isNoEntError(err)) return undefined;
      throw err;
    }

    for (const child of nested) {
      const childPath = join(entryPath, child);
      const candidate = join(childPath, 'run.json');
      const artifact = await tryReadRunJson(candidate);
      if (artifact) return summarise(artifact);
      // Two-level case: `runs/eval/<item-id>/<run-id>/run.json` — try
      // one more level of recursion.
      const stat2 = await stat(childPath).catch(() => undefined);
      if (!stat2?.isDirectory()) continue;
      const grandchildren = await readdir(childPath).catch(() => []);
      for (const gc of grandchildren) {
        const gcPath = join(childPath, gc, 'run.json');
        const a = await tryReadRunJson(gcPath);
        if (a) return summarise(a);
      }
    }
    return undefined;
  }
}

async function tryReadRunJson(path: string): Promise<RunArtifact | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RunArtifact;
    // Defensive: schema_version absence means an unrelated JSON file
    // (e.g. a config) — skip rather than crash.
    if (typeof parsed !== 'object' || parsed === null || !('schema_version' in parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function summarise(artifact: RunArtifact): RunSummary {
  const recommendations: PriorRecommendationSummary[] = artifact.reasoning.recommendations.map(
    (r) => ({
      recommendation_id: r.recommendation_id,
      recommendation_signature: r.recommendation_signature,
      statement: r.statement,
      priority: r.priority,
    }),
  );
  return {
    run_id: artifact.metadata.run_id,
    scope_signature: computeScopeSignature(artifact.scope),
    analysis_type: artifact.scope.analysis_type,
    started_at: artifact.metadata.started_at,
    recommendations,
  };
}

function isNoEntError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}
