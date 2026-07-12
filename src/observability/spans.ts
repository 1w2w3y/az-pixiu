import { SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';
import { currentTracer } from './setup.js';

/**
 * Helpers for emitting the §14 trace vocabulary. Names are constants so
 * future agents inheriting the substrate (per the multi-agent platform
 * PRD) can match exact span names rather than string-typo-prone literals.
 */

export const SpanNames = {
  RunRoot: 'run.root',
  ConfigResolution: 'run.config_resolution',
  ScopeIntake: 'run.scope_intake',
  SubscriptionDiscovery: 'run.subscription_discovery',
  CapabilityDiscovery: 'run.capability_discovery',
  EvidencePlanning: 'run.evidence_planning',
  EvidenceRetrieval: 'run.evidence_retrieval',
  // Phase 3 — design/cost-summary-depth.md §Gap 1. Runs after evidence
  // retrieval for cost_summary analyses; fans the lane registry out
  // through the existing transport. One span per run, one
  // `waste_lane.*` attribute group per lane added to it.
  WasteDetection: 'run.waste_detection',
  Reasoning: 'run.reasoning',
  ReportAssembly: 'run.report_assembly',
  Finalize: 'run.finalize',
  EvidenceToolCall: (capability: string) => `evidence.tool_call.${capability}`,
  ReasoningPromptFetch: 'reasoning.prompt_fetch',
  ReasoningModelCall: 'reasoning.model_call',
  ReasoningNormalize: 'reasoning.normalize',
} as const;

/**
 * Attribute namespace for project-specific span attributes. OTEL
 * gen_ai.* attributes (set by @langfuse/openai when wrapping the OpenAI
 * client) remain untouched.
 */
export const ATTR = {
  agentName: 'az_pixiu.agent.name',
  agentDomain: 'az_pixiu.agent.domain',
  analysisType: 'az_pixiu.analysis.type',
  scopeSubscriptions: 'az_pixiu.scope.subscription_ids',
  scopeTimeWindow: 'az_pixiu.scope.time_window',
  scopeBaselineWindow: 'az_pixiu.scope.baseline_window',
  promptPlannerVersion: 'az_pixiu.prompt.planner_version',
  promptReasonerVersion: 'az_pixiu.prompt.reasoner_version',
  promptPlannerContentSha256: 'az_pixiu.prompt.planner_content_sha256',
  promptReasonerContentSha256: 'az_pixiu.prompt.reasoner_content_sha256',
  modelProvider: 'az_pixiu.model.provider',
  modelName: 'az_pixiu.model.name',
  modelConfigHash: 'az_pixiu.model.config_hash',
  modelDeploymentSku: 'az_pixiu.model.deployment_sku',
  credentialSource: 'az_pixiu.credential.source',
  credentialIdentity: 'az_pixiu.credential.identity',
  fixtureId: 'az_pixiu.fixture.id',
  status: 'az_pixiu.status',
  capability: 'az_pixiu.capability.name',
  capabilityVersion: 'az_pixiu.capability.version',
  evidencePlanRequests: 'az_pixiu.evidence.plan_request_count',
  evidenceRecordsProduced: 'az_pixiu.evidence.records_produced',
  evidenceFailuresClassified: 'az_pixiu.evidence.failures_classified',
  reasoningFactsProduced: 'az_pixiu.reasoning.facts',
  reasoningHypothesesProduced: 'az_pixiu.reasoning.hypotheses',
  reasoningRecommendationsProduced: 'az_pixiu.reasoning.recommendations',
  reasoningDqProduced: 'az_pixiu.reasoning.data_quality',
  reasoningIssuesEmitted: 'az_pixiu.reasoning.post_process_issues',
  discoveryLimit: 'az_pixiu.discovery.limit',
  discoveryVisibleCount: 'az_pixiu.discovery.visible_count',
  discoveryWithNamesCount: 'az_pixiu.discovery.with_names_count',
  discoverySelectedCount: 'az_pixiu.discovery.selected_count',
  discoveryShapeHint: 'az_pixiu.discovery.shape_hint',
  // Billing-access pre-flight probe (Phase 3). Attached to the
  // SubscriptionDiscovery span when auto-discovery probed candidates.
  // Per-sub detail surfaces as `probe.start` / `probe.end` span
  // events on the same span; these are the run-level rollup
  // attributes used for Langfuse filter pivots.
  discoveryPoolSize: 'az_pixiu.discovery.pool_size',
  discoveryProbedCount: 'az_pixiu.discovery.probed_count',
  discoveryPassedCount: 'az_pixiu.discovery.passed_count',
  discoveryCacheHits: 'az_pixiu.discovery.cache_hits',
  discoveryCacheMisses: 'az_pixiu.discovery.cache_misses',
  instrumentationFlavor: 'az_pixiu.instrumentation.flavor',
  // Transport-level retry observability (Phase 3 §Gap 7 / §S4). Attached
  // to the evidence_retrieval span as run-level aggregates; per-attempt
  // detail surfaces as `transport.retry_scheduled` / `transport.pacing_applied`
  // span events on the same span (emitted from src/run/orchestrator.ts
  // via EvidenceExecutor.onEvent).
  transportRetryCount: 'az_pixiu.transport.retry_count',
  transportCumulativeBackoffMs: 'az_pixiu.transport.cumulative_backoff_ms',
  transportFinalOutcome: 'az_pixiu.transport.final_outcome',
  transportRateLimitSeen: 'az_pixiu.transport.rate_limit_seen',
  transportRecoveredCount: 'az_pixiu.transport.recovered_count',
  transportExhaustedCount: 'az_pixiu.transport.exhausted_count',
  // Waste-detection lane attributes (Phase 3 — design/cost-summary-depth.md
  // §Gap 1, §"Trace vocabulary additions"). Emitted on the
  // WasteDetection span, one set per executed lane. Names join the
  // existing az_pixiu.* vocabulary so Langfuse filtering generalises
  // to the new dimensions without new namespaces.
  wasteLaneName: 'az_pixiu.waste_lane.name',
  wasteLaneCandidateCount: 'az_pixiu.waste_lane.candidate_count',
  wasteLaneEstimatedWeeklyUsdLow: 'az_pixiu.waste_lane.estimated_weekly_usd_low',
  wasteLaneEstimatedWeeklyUsdHigh: 'az_pixiu.waste_lane.estimated_weekly_usd_high',
  wasteLaneRateSource: 'az_pixiu.waste_lane.rate_source',
  wasteLaneRateUnavailableCount: 'az_pixiu.waste_lane.rate_unavailable_count',
  wasteLaneFailed: 'az_pixiu.waste_lane.failed',
} as const;

/**
 * Run an async block inside an OTEL span. Records exceptions, sets
 * status to ERROR on throw, OK on success. Returns the block's value.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return currentTracer().startActiveSpan(name, async (span) => {
    if (attributes) span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Emit a §14 event on the current span (e.g., mutating_capabilities_excluded).
 */
export function emitEvent(span: Span, name: string, attributes?: Attributes): void {
  span.addEvent(name, attributes);
}
