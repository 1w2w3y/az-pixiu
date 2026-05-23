import type { AnalysisType } from '../schemas/index.js';

/**
 * Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md §Gap 5).
 *
 * A {@link RunHistoryStore} lets the orchestrator look up prior agent
 * runs that targeted the same scope and analysis type, so the reasoner
 * can recognise carry-forward recommendations and recurring patterns.
 *
 * Phase 2.5 ships a single implementation: an index over the existing
 * `runs/<run-id>/run.json` artefacts that the agent already writes. The
 * interface is shaped so a SQLite-backed or Langfuse-Datasets-backed
 * implementation can be swapped in later without changing the
 * orchestrator or the reasoner.
 */

export interface RunSummary {
  /** UUID identifying the prior run. */
  run_id: string;
  /** Scope signature the prior run matched against (matches the query). */
  scope_signature: string;
  /** Analysis type the prior run produced. */
  analysis_type: AnalysisType;
  /** ISO timestamp the prior run started. Used to order results. */
  started_at: string;
  /**
   * Recommendations the prior run produced, in the order the report
   * rendered them. Only the fields useful for cross-run continuity are
   * surfaced — the full reasoning output stays in run.json on disk.
   */
  recommendations: PriorRecommendationSummary[];
}

export interface PriorRecommendationSummary {
  recommendation_id: string;
  recommendation_signature: string;
  statement: string;
  priority: 'high' | 'medium' | 'low';
}

export interface FindPriorRunsOptions {
  /** Match against runs with this scope signature. Required. */
  scope_signature: string;
  /** Only return runs whose analysis_type matches. */
  analysis_type: AnalysisType;
  /**
   * Maximum number of prior runs to return (most-recent-first). Default
   * is 12, matching the "12-week lookback" default named in the design.
   */
  limit?: number;
  /**
   * Optional lower bound on started_at. Runs older than this ISO
   * timestamp are excluded. Lets callers cap the lookback by wall-clock
   * time instead of just count.
   */
  startedAtMin?: string;
  /**
   * Run id to exclude from results. The orchestrator passes the current
   * run's id so a re-read after the artefact is written cannot return
   * the current run as its own "prior".
   */
  excludeRunId?: string;
}

export interface RunHistoryStore {
  findPriorRuns(options: FindPriorRunsOptions): Promise<RunSummary[]>;
}

/**
 * No-op implementation: returns no prior runs. Used when the operator
 * has not configured a history store (e.g. CI fixtures, mock-model
 * tests) so cross-run continuity is silently absent rather than a hard
 * dependency. Matches FR-19 "operate without it rather than fabricate
 * continuity claims".
 */
export class NoopRunHistoryStore implements RunHistoryStore {
  async findPriorRuns(): Promise<RunSummary[]> {
    return [];
  }
}
