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
