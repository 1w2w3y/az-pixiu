import {
  EvidenceRecordSchema,
  type EvidencePlan,
  type EvidenceRecord,
  type Scope,
  type TransportSummaryEntry,
} from '../schemas/index.js';
import type { DiscoveredCatalog, MCPClient } from '../mcp/client.js';
import { EvidenceExecutor, type ExecutorEvent, type RawEvidence } from '../evidence/executor.js';
import type { RetryPolicy } from '../evidence/retry-policy.js';
import type { ClassifiedFailure } from '../failure/taxonomy.js';
import { parameterDigest, shortDigest } from '../mcp/digest.js';
import { estimateWeeklyImpactRange, rollUpLaneTotal } from '../pricing/impact.js';
import type { PricingRateSource } from '../pricing/source.js';
import type {
  WasteCandidate,
  WasteCandidateEvidence,
  WasteLane,
  WasteLaneResult,
} from '../playbooks/waste-lanes/types.js';

/**
 * Waste-detection executor (Phase 3 — design/cost-summary-depth.md
 * §Gap 1, "WasteDetectionExecutor … parallel to EvidenceExecutor").
 *
 * Runs after the cost-summary evidence plan completes and fans the
 * lane registry out through the *existing* {@link EvidenceExecutor} so
 * every ARG query inherits §Gap 7 retry, per-capability pacing, and
 * embedded rate-limit detection without bespoke transport plumbing.
 * The Azure boundary stays exactly where the rest of the agent puts it
 * ({@link MCPTransport}): no Azure SDK call, no second client.
 *
 * Per-candidate {@link EvidenceRecord}s are emitted with
 * `query_intent: 'waste_candidate'` and
 * `source_capability: 'az_pixiu_waste_lane'` so they are obviously
 * distinguishable from generic `inventory` records in the trace and
 * report. The wire call ('amgmcp_query_resource_graph') is still
 * recorded in the transport summary so the operator can audit which
 * capability was hit on the lane's behalf.
 *
 * The executor is deterministic — it writes evidence + the
 * `waste_lanes` block, never recommendation prose. The reasoner is
 * the only writer of recommendation framing (§Reasoner prompt changes
 * in the design): waste candidates are *facts the reasoner cites*,
 * not the reasoner's voice spoken by the lane code.
 */

export const WASTE_LANE_SOURCE_CAPABILITY = 'az_pixiu_waste_lane';
export const WASTE_LANE_CAPABILITY_VERSION = '1.0.0';

export interface WasteDetectionExecutorOptions {
  client: MCPClient;
  catalog: DiscoveredCatalog;
  rateSource: PricingRateSource;
  lanes: readonly WasteLane[];
  /** Optional retry policy override. Tests inject a tight policy. */
  retryPolicy?: RetryPolicy;
  /** Sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter override for tests. */
  jitter?: (policy: RetryPolicy) => number;
  /** Now-supplier for deterministic timestamps in tests. */
  now?: () => Date;
  /** Forwarded to the underlying EvidenceExecutor for tracing. */
  onEvent?: (event: ExecutorEvent) => void;
}

export interface WasteDetectionRunOptions {
  scope: Scope;
}

export interface WasteDetectionResult {
  /** Per-lane summaries, in registry order. */
  lanes: WasteLaneResult[];
  /**
   * One {@link EvidenceRecord} per candidate across every lane. These
   * are appended to the main evidence list before the reasoner runs.
   */
  evidence: EvidenceRecord[];
  /**
   * Per-logical-request transport entries (recovered + exhausted) so
   * lane wire activity is visible in the same `run.json.transport_summary`
   * block as cost-summary calls. Inherits the §Gap 7 retry detail.
   */
  transport_summary: TransportSummaryEntry[];
  /**
   * Classified failures the executor produced for lane ARG calls.
   * Surfaced so the orchestrator can fold them into the same
   * `failureToDq` path as cost-summary failures.
   */
  failures: ClassifiedFailure[];
}

export class WasteDetectionExecutor {
  private readonly client: MCPClient;
  private readonly catalog: DiscoveredCatalog;
  private readonly rateSource: PricingRateSource;
  private readonly lanes: readonly WasteLane[];
  private readonly retryPolicy?: RetryPolicy;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly jitter?: (policy: RetryPolicy) => number;
  private readonly now: () => Date;
  private readonly onEvent: (event: ExecutorEvent) => void;

  constructor(options: WasteDetectionExecutorOptions) {
    this.client = options.client;
    this.catalog = options.catalog;
    this.rateSource = options.rateSource;
    this.lanes = options.lanes;
    if (options.retryPolicy !== undefined) this.retryPolicy = options.retryPolicy;
    if (options.sleep !== undefined) this.sleep = options.sleep;
    if (options.jitter !== undefined) this.jitter = options.jitter;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async execute(options: WasteDetectionRunOptions): Promise<WasteDetectionResult> {
    const allLaneResults: WasteLaneResult[] = [];
    const allEvidence: EvidenceRecord[] = [];
    const allTransport: TransportSummaryEntry[] = [];
    const allFailures: ClassifiedFailure[] = [];

    for (const lane of this.lanes) {
      const request = lane.buildRequest({ scope: options.scope, rateSource: this.rateSource });
      const plan: EvidencePlan = { requests: [request] };

      // Use the existing EvidenceExecutor so the lane's ARG call gets
      // §Gap 7 retry + embedded-rate-limit detection + per-capability
      // pacing for free.
      const executor = new EvidenceExecutor({
        client: this.client,
        catalog: this.catalog,
        ...(this.now ? { now: this.now } : {}),
        ...(this.retryPolicy ? { retryPolicy: this.retryPolicy } : {}),
        ...(this.sleep ? { sleep: this.sleep } : {}),
        ...(this.jitter ? { jitter: this.jitter } : {}),
        onEvent: this.onEvent,
      });
      const { raw_evidence, failures, transport_summary } = await executor.execute(plan);

      allTransport.push(...transport_summary);
      allFailures.push(...failures);

      const raw: RawEvidence | undefined = raw_evidence[0];
      if (!raw) {
        // Lane failed before returning data (exhausted retries, denied
        // capability, etc.). Surface the lane as a failed entry so the
        // operator sees the lane was attempted; impact stays empty.
        allLaneResults.push({
          lane: lane.name,
          title: lane.title,
          predicate_text: lane.predicate_text,
          source_capability: WASTE_LANE_SOURCE_CAPABILITY,
          candidates: [],
          lane_total: rollUpLaneTotal([]),
          rate_source_captured_at: this.rateSource.capturedAt(),
          unparsed_row_count: 0,
          failed: true,
        });
        continue;
      }

      const { candidates, unparsed_row_count } = lane.parseRows(raw.result);

      const enriched: WasteCandidateEvidence[] = candidates.map((candidate) => {
        const estimate = estimateWeeklyImpactRange({
          count: 1,
          sku: candidate.sku,
          region: candidate.location || undefined,
          rateSource: this.rateSource,
        });
        const evidence = this.buildCandidateEvidence({
          lane,
          candidate,
          estimate,
          scope: options.scope,
          unparsed_row_count,
        });
        return { candidate, estimated_weekly_impact: estimate, evidence };
      });

      const laneTotal = rollUpLaneTotal(enriched.map((c) => c.estimated_weekly_impact));

      allLaneResults.push({
        lane: lane.name,
        title: lane.title,
        predicate_text: lane.predicate_text,
        source_capability: WASTE_LANE_SOURCE_CAPABILITY,
        candidates: enriched,
        lane_total: laneTotal,
        rate_source_captured_at: this.rateSource.capturedAt(),
        unparsed_row_count,
        failed: false,
      });
      for (const c of enriched) allEvidence.push(c.evidence);
    }

    return {
      lanes: allLaneResults,
      evidence: allEvidence,
      transport_summary: allTransport,
      failures: allFailures,
    };
  }

  private buildCandidateEvidence(args: {
    lane: WasteLane;
    candidate: WasteCandidate;
    estimate: ReturnType<typeof estimateWeeklyImpactRange>;
    scope: Scope;
    unparsed_row_count: number;
  }): EvidenceRecord {
    const { lane, candidate, estimate, scope } = args;
    const impactSummary =
      estimate.kind === 'available'
        ? {
            kind: 'available' as const,
            low_usd: estimate.low_usd,
            high_usd: estimate.high_usd,
            point_usd: estimate.point_usd,
            source_url: estimate.source_url,
            captured_at: estimate.captured_at,
          }
        : {
            kind: 'unavailable' as const,
            rate_unavailable: true,
            reason: estimate.reason,
            sku: estimate.sku,
          };
    // Deterministic per-candidate id: 8 hex of SHA-256 over the
    // resource id. shortDigest() expects a hex digest as input, so the
    // resource id is hashed first; using it directly would slice the
    // resource string and produce noisy non-hex segments.
    const evidence_id = `ev-${WASTE_LANE_SOURCE_CAPABILITY}-${lane.name}-${shortDigest(parameterDigest(candidate.resource_id))}`;
    const caveats: string[] = [
      `Synthetic evidence: deterministic ${lane.name} waste-lane row classified by the cited ARG predicate against AMG-MCP resource graph.`,
    ];
    if (args.unparsed_row_count > 0) {
      caveats.push(
        `${args.unparsed_row_count} ARG row(s) for this lane were unparseable and excluded from candidates.`,
      );
    }
    return EvidenceRecordSchema.parse({
      evidence_id,
      source_capability: WASTE_LANE_SOURCE_CAPABILITY,
      capability_version: WASTE_LANE_CAPABILITY_VERSION,
      query_intent: 'waste_candidate',
      scope_subset: {
        subscription_ids: [candidate.subscription_id],
        resource_group_names: candidate.resource_group ? [candidate.resource_group] : null,
        resource_ids: [candidate.resource_id],
      },
      time_window: scope.time_window,
      payload_ref: {
        kind: 'inline',
        data: {
          waste_lane: lane.name,
          classification_predicate: lane.predicate_text,
          candidate_count: 1,
          candidate: {
            resource_id: candidate.resource_id,
            name: candidate.name,
            subscription_id: candidate.subscription_id,
            resource_group: candidate.resource_group,
            location: candidate.location,
            sku: candidate.sku,
            fields: candidate.fields,
          },
          estimated_weekly_impact: impactSummary,
        },
      },
      payload_summary: {
        waste_lane: lane.name,
        resource_id: candidate.resource_id,
        sku: candidate.sku,
        estimated_weekly_impact: impactSummary,
      },
      caveats,
    });
  }
}
