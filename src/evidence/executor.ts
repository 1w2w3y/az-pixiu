import { parameterDigest } from '../mcp/digest.js';
import { classifyFailure, type ClassifiedFailure } from '../failure/taxonomy.js';
import type { MCPClient, DiscoveredCatalog } from '../mcp/client.js';
import type { EvidencePlan, EvidenceRequest, ToolCallResult } from '../schemas/index.js';
import {
  failureCategoryToOutcome,
  scopeSubsetFromParameters,
  type TransportSummaryEntry,
} from '../schemas/transport.js';

/**
 * Per-request retrieval result before normalization (§7.2 step 5).
 * Carries enough provenance for the normalizer (step 6) to build the
 * EvidenceRecord.
 */
export interface RawEvidence {
  request: EvidenceRequest;
  parameters_digest: string;
  capability_version: string;
  result: ToolCallResult;
  retrieved_at: string;
}

export interface ExecutionResult {
  raw_evidence: RawEvidence[];
  failures: ClassifiedFailure[];
  /**
   * One {@link TransportSummaryEntry} per logical evidence request, in
   * plan order. Phase 3 (cron-comparison §S4) substrate: PR 1 emits
   * single-attempt rows; PR 2 (§Gap 7 retry) fills in retry counts and
   * cumulative backoff without changing the shape.
   */
  transport_summary: TransportSummaryEntry[];
}

export interface EvidenceExecutorOptions {
  client: MCPClient;
  catalog: DiscoveredCatalog;
  /**
   * Now-supplier for retrieved_at timestamps. Defaults to () => new Date()
   * — overridable in tests for deterministic timestamps.
   */
  now?: () => Date;
}

/**
 * The evidence executor (design §4.6, §7.2 step 5). Walks the
 * EvidencePlan, dispatching each request through the MCPClient and
 * classifying per-call failures via the failure_taxonomy. Failures are
 * collected, not thrown — analysis continues with bounded coverage (§11)
 * unless an unrecoverable error escapes (e.g., DiscoveryNotPerformedError,
 * which classifyFailure deliberately re-throws).
 *
 * Back-pressure scaffolding: Phase 1 runs requests sequentially because
 * the fixture transport is in-process and free. The scheduling shape is
 * preserved so Phase 2 can introduce per-capability serialization (Cost
 * Management QPU) and metric-call batching without changing the
 * caller-visible interface.
 */
export class EvidenceExecutor {
  private readonly client: MCPClient;
  private readonly catalog: DiscoveredCatalog;
  private readonly now: () => Date;

  constructor(options: EvidenceExecutorOptions) {
    this.client = options.client;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
  }

  async execute(plan: EvidencePlan): Promise<ExecutionResult> {
    const raw_evidence: RawEvidence[] = [];
    const failures: ClassifiedFailure[] = [];
    const transport_summary: TransportSummaryEntry[] = [];

    for (let i = 0; i < plan.requests.length; i++) {
      const request = plan.requests[i]!;
      const parameters_digest = parameterDigest(request.parameters);
      const logical_request_id = `req-${i + 1}`;
      try {
        const result = await this.client.invoke(request.capability, request.parameters);
        raw_evidence.push({
          request,
          parameters_digest,
          capability_version:
            this.catalog.capability_versions[request.capability] ?? 'unknown',
          result,
          retrieved_at: this.now().toISOString(),
        });
        transport_summary.push({
          logical_request_id,
          capability: request.capability,
          scope_subset: scopeSubsetFromParameters(request.parameters),
          parameters_digest,
          attempt_count: 1,
          retry_count: 0,
          final_outcome: 'success',
          pacing_applied: false,
          cumulative_backoff_ms: 0,
        });
      } catch (err) {
        const failure = classifyFailure(err, { capability: request.capability });
        failures.push(failure);
        transport_summary.push({
          logical_request_id,
          capability: request.capability,
          scope_subset: scopeSubsetFromParameters(request.parameters),
          parameters_digest,
          attempt_count: 1,
          retry_count: 0,
          final_outcome: failureCategoryToOutcome(failure.category),
          failure_category: failure.category,
          pacing_applied: false,
          cumulative_backoff_ms: 0,
        });
      }
    }

    return { raw_evidence, failures, transport_summary };
  }
}
