import { parameterDigest } from '../mcp/digest.js';
import { classifyFailure, type ClassifiedFailure } from '../failure/taxonomy.js';
import type { MCPClient, DiscoveredCatalog } from '../mcp/client.js';
import type { EvidencePlan, EvidenceRequest, ToolCallResult } from '../schemas/index.js';

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

    for (const request of plan.requests) {
      try {
        const result = await this.client.invoke(request.capability, request.parameters);
        raw_evidence.push({
          request,
          parameters_digest: parameterDigest(request.parameters),
          capability_version:
            this.catalog.capability_versions[request.capability] ?? 'unknown',
          result,
          retrieved_at: this.now().toISOString(),
        });
      } catch (err) {
        failures.push(classifyFailure(err, { capability: request.capability }));
      }
    }

    return { raw_evidence, failures };
  }
}
