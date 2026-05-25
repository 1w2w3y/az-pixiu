/**
 * Deterministic `recommendation_signature` helper.
 *
 * Phase 2.5 closes out the substrate for cross-run continuity
 * (design/cost-summary-depth.md §Gap 5). The v1 reasoner emits the
 * signature as an LLM-produced kebab-case slug (rule #15 in
 * prompts/reasoner.v1.md) because the inputs required for the design's
 * lane + cluster + SKU computation do not yet exist: waste lanes,
 * naming-pattern clusters, and dominant-SKU rollup all land in Phase 3.
 *
 * This module ships the deterministic helper *now* so Phase 3 lane code
 * can call it the moment those inputs arrive, without a follow-up
 * schema change. The v1 LLM path continues to use the fallback slug
 * (which the live `runs/<id>/run.json` artefacts on disk show is
 * already stable across runs of the same scope in practice).
 *
 * Output contract:
 *   - When `lane` / `cluster_prefix` / `dominant_sku` are supplied, the
 *     signature is `<lane>--<cluster_prefix>--<dominant_sku>`, each
 *     part normalised (lowercase, non-alphanumeric → `-`, runs of `-`
 *     collapsed, leading/trailing `-` trimmed). Missing structured
 *     parts are filled with `none`.
 *   - When only `fallback_slug` is supplied, the helper returns it
 *     normalised. This is the v1 path: the LLM produces the slug,
 *     the orchestrator can run it through this helper to guarantee
 *     stable canonicalisation before write.
 *   - Throws when neither structured parts nor a fallback slug is
 *     supplied — there is no honest signature to compute.
 */

export interface RecommendationSignatureInput {
  /** Phase 3 waste-detection lane name (e.g. `orphan-ip-cleanup`). */
  lane?: string;
  /** Phase 3 cluster prefix (e.g. `liftrtools`). */
  cluster_prefix?: string;
  /** Phase 3 dominant SKU among the lane's candidates. */
  dominant_sku?: string;
  /**
   * v1 fallback path: the LLM-emitted slug. Used when none of the
   * Phase 3 structured parts are available.
   */
  fallback_slug?: string;
}

export function computeRecommendationSignature(
  input: RecommendationSignatureInput,
): string {
  const hasStructured =
    input.lane !== undefined ||
    input.cluster_prefix !== undefined ||
    input.dominant_sku !== undefined;
  if (hasStructured) {
    const parts = [
      normalise(input.lane) || 'none',
      normalise(input.cluster_prefix) || 'none',
      normalise(input.dominant_sku) || 'none',
    ];
    return parts.join('--');
  }
  if (input.fallback_slug !== undefined) {
    const normalised = normalise(input.fallback_slug);
    if (normalised.length === 0) {
      throw new Error(
        'computeRecommendationSignature: fallback_slug normalised to an empty string; refusing to emit an empty signature.',
      );
    }
    return normalised;
  }
  throw new Error(
    'computeRecommendationSignature: at least one of lane / cluster_prefix / dominant_sku / fallback_slug must be supplied.',
  );
}

function normalise(value: string | undefined): string {
  if (value === undefined) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
