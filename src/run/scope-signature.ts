import { createHash } from 'node:crypto';
import type { Scope } from '../schemas/index.js';

/**
 * Cross-run continuity (Phase 2.5 — design/cost-summary-depth.md §Gap 5).
 *
 * Produces a deterministic hash of the parts of a {@link Scope} that
 * define "the same analysis against the same target", so the
 * {@link RunHistoryStore} can match the current run against prior runs
 * even when the time window has advanced.
 *
 * Inputs to the hash:
 *   - sorted subscription_ids
 *   - sorted resource_group_names (empty list ≠ missing — both normalise
 *     to "no resource-group filter" because the orchestrator treats
 *     `undefined` and `[]` interchangeably in scope intake)
 *   - analysis_type
 *
 * Inputs deliberately NOT in the hash:
 *   - time_window / baseline_window (the whole point of continuity is to
 *     compare across windows)
 *   - resource_type_filter (a narrowing dimension; runs that narrow
 *     differently are not the "same" recurring analysis)
 *   - user_context (free-text; not a structural identity)
 *   - effective_scope_summary / subscription_display_names (human-readable)
 *
 * Scope-drift handling: an exact match is required. If a subscription is
 * lost to RBAC or added later, the signature changes and the prior runs
 * will not be considered a match. The design names this as conservative-
 * by-default; a future override may relax it.
 */
export function computeScopeSignature(scope: Scope): string {
  const subscriptionIds = [...scope.subscription_ids].sort();
  const resourceGroups = [...(scope.resource_group_names ?? [])].sort();
  const payload = JSON.stringify({
    subscription_ids: subscriptionIds,
    resource_group_names: resourceGroups,
    analysis_type: scope.analysis_type,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
