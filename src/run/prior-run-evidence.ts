import type { EvidenceRecord, Scope } from '../schemas/index.js';
import type { RunSummary } from '../history/store.js';

/**
 * Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md §Gap 5).
 *
 * Turns a list of prior-run summaries returned by {@link RunHistoryStore}
 * into a single synthetic {@link EvidenceRecord} that the reasoner can
 * read alongside AMG-MCP evidence. The record uses
 * `query_intent: 'prior_run_context'` and a sentinel
 * `source_capability: 'az_pixiu_run_history'` so it is obviously
 * distinguishable from real Azure-derived evidence in the trace and
 * the report.
 *
 * Phase 2.5 ships this as a *single* synthetic record per analysis run
 * (rather than one per prior run). That keeps the reasoner prompt's
 * evidence list compact and lets the reasoner see "all prior runs at
 * once" without having to correlate N separate records. Phase 3's
 * reasoner.v2 prompt will use the embedded summaries to mark waste
 * candidates as UNCHANGED week N and clusters as RECURRING.
 *
 * Returns an empty array when there are no prior runs — the orchestrator
 * then injects nothing, so the evidence pipeline behaves exactly as it
 * did before Phase 2.5 for the no-history case.
 */

/**
 * How the prior runs were selected for this record. `exact_scope` is
 * the default — the orchestrator queried `findPriorRuns` with the
 * current scope_signature and got matches. `operator_override` means
 * the operator passed `--prior-run <run-id>` and the named run was
 * injected verbatim, regardless of whether its scope matched.
 */
export type PriorRunMatchMode = 'exact_scope' | 'operator_override';

const SCOPE_MISMATCH_CAVEAT =
  'Operator-selected prior run did not exactly match the current scope_signature; injecting for continuity review only.';

export function buildPriorRunContextEvidence(options: {
  priorRuns: RunSummary[];
  scope: Scope;
  matchMode?: PriorRunMatchMode;
  currentScopeSignature?: string;
}): EvidenceRecord[] {
  if (options.priorRuns.length === 0) return [];
  const { priorRuns, scope, currentScopeSignature } = options;
  const matchMode: PriorRunMatchMode = options.matchMode ?? 'exact_scope';
  const caveats: string[] = [
    'Synthetic evidence: summarises prior Az-Pixiu runs against the same scope. Not retrieved from AMG-MCP.',
  ];
  if (
    matchMode === 'operator_override' &&
    currentScopeSignature !== undefined &&
    priorRuns.some((r) => r.scope_signature !== currentScopeSignature)
  ) {
    caveats.push(SCOPE_MISMATCH_CAVEAT);
  }
  return [
    {
      evidence_id: 'ev-az_pixiu_run_history-prior',
      source_capability: 'az_pixiu_run_history',
      capability_version: '1.0.0',
      query_intent: 'prior_run_context',
      scope_subset: {
        subscription_ids: scope.subscription_ids,
        resource_group_names: scope.resource_group_names ?? null,
        resource_ids: null,
      },
      time_window: scope.time_window,
      payload_ref: {
        kind: 'inline',
        data: {
          match_mode: matchMode,
          ...(currentScopeSignature !== undefined
            ? { current_scope_signature: currentScopeSignature }
            : {}),
          prior_runs: priorRuns.map((r) => ({
            run_id: r.run_id,
            started_at: r.started_at,
            analysis_type: r.analysis_type,
            scope_signature: r.scope_signature,
            recommendations: r.recommendations.map((rec) => ({
              recommendation_id: rec.recommendation_id,
              recommendation_signature: rec.recommendation_signature,
              priority: rec.priority,
              statement: rec.statement,
            })),
          })),
        },
      },
      payload_summary: {
        prior_run_count: priorRuns.length,
        oldest_started_at: priorRuns[priorRuns.length - 1]?.started_at,
        newest_started_at: priorRuns[0]?.started_at,
        match_mode: matchMode,
      },
      caveats,
    },
  ];
}
