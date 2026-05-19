import type {
  AnalysisType,
  CapabilityCatalog,
  CapabilityDescriptor,
  ToolCallResult,
} from '../schemas/index.js';
import type { MCPTransport } from './transport.js';
import { isAllowedCapability, isMutatingCapabilityName } from './allowlist.js';
import { getRequiredCapabilities } from './required-capabilities.js';
import { withSpan, SpanNames, ATTR } from '../observability/spans.js';
import { updateActiveObservation } from '@langfuse/tracing';
import { parameterDigest, shortDigest } from './digest.js';

export class MCPClientError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MCPClientError';
    this.cause = cause;
  }
}

export class CapabilityNotAllowedError extends MCPClientError {
  constructor(
    public readonly capability: string,
    public readonly reason: string,
  ) {
    super(`Capability "${capability}" is not allowed: ${reason}`);
    this.name = 'CapabilityNotAllowedError';
  }
}

export class RequiredCapabilityMissingError extends MCPClientError {
  constructor(
    public readonly analysisType: AnalysisType,
    public readonly missing: readonly string[],
  ) {
    super(
      `Analysis type "${analysisType}" requires capabilities that AMG-MCP does not advertise (or that are denied by the read-only allowlist): ${missing.join(', ')}`,
    );
    this.name = 'RequiredCapabilityMissingError';
  }
}

export class DiscoveryNotPerformedError extends MCPClientError {
  constructor() {
    super(
      'MCPClient.invoke called before discover(). Capability discovery must run first (design §4.3).',
    );
    this.name = 'DiscoveryNotPerformedError';
  }
}

/**
 * The result of a capability-discovery run. `allowed` is the only set
 * mcp_client will invoke; `denied` and `mutating_denied` are surfaced so
 * the observability component can emit the `mutating_capabilities_excluded`
 * trace event (§14). `capability_versions` feeds `RunMetadata.capability_versions`
 * (§5.7).
 */
export interface DiscoveredCatalog {
  raw: CapabilityCatalog;
  allowed: readonly CapabilityDescriptor[];
  denied: readonly CapabilityDescriptor[];
  mutating_denied: readonly CapabilityDescriptor[];
  capability_versions: Readonly<Record<string, string>>;
}

export interface MCPClientOptions {
  transport: MCPTransport;
}

/**
 * The mcp_client component (§4.3). Wraps an MCPTransport and adds:
 *   - capability discovery on session open
 *   - read-only allowlist filtering (defense layer 1, §12)
 *   - cross-check that invoked capabilities were actually advertised
 *   - close() that propagates to the transport
 *
 * Deliberately separate from analysis-type concerns: the caller runs
 * assertRequiredCapabilities() after discover() to enforce the fail-fast
 * check (§7.2 step 3). This keeps MCPClient reusable across analysis types.
 */
export class MCPClient {
  private readonly transport: MCPTransport;
  private cachedCatalog: DiscoveredCatalog | undefined;

  constructor(options: MCPClientOptions) {
    this.transport = options.transport;
  }

  async discover(): Promise<DiscoveredCatalog> {
    if (this.cachedCatalog) return this.cachedCatalog;

    const raw = await this.transport.listCapabilities();

    const allowed: CapabilityDescriptor[] = [];
    const denied: CapabilityDescriptor[] = [];
    const mutating_denied: CapabilityDescriptor[] = [];
    const capability_versions: Record<string, string> = {};

    for (const cap of raw.capabilities) {
      const mutating = isMutatingCapabilityName(cap.name);
      const inAllowlist = isAllowedCapability(cap.name);

      if (mutating) {
        mutating_denied.push(cap);
        denied.push(cap);
        continue;
      }

      if (inAllowlist) {
        allowed.push(cap);
        if (cap.version) {
          capability_versions[cap.name] = cap.version;
        }
      } else {
        denied.push(cap);
      }
    }

    this.cachedCatalog = {
      raw,
      allowed,
      denied,
      mutating_denied,
      capability_versions,
    };
    return this.cachedCatalog;
  }

  async invoke(
    capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    if (!this.cachedCatalog) {
      throw new DiscoveryNotPerformedError();
    }

    if (!isAllowedCapability(capability)) {
      throw new CapabilityNotAllowedError(
        capability,
        'not in the Phase 1 read-only allowlist',
      );
    }

    if (!this.cachedCatalog.allowed.some((c) => c.name === capability)) {
      throw new CapabilityNotAllowedError(
        capability,
        'allowed by the static allowlist but not advertised by AMG-MCP — discovery did not see it',
      );
    }

    // Per-call observability span. Nests under whatever parent is
    // active — typically `run.evidence_retrieval` (executor) or
    // `run.subscription_discovery` (auto-discovery). input/output
    // land on the observation so Langfuse renders the request and
    // response payloads, matching the trace card it produces for
    // OpenAI tool calls.
    const digest = parameterDigest(parameters);
    const version = this.cachedCatalog.capability_versions[capability];
    return withSpan(
      SpanNames.EvidenceToolCall(capability),
      async () => {
        updateActiveObservation({ input: parameters });
        const result = await this.transport.invoke(capability, parameters);
        updateActiveObservation({ output: result.content });
        return result;
      },
      {
        [ATTR.capability]: capability,
        ...(version ? { [ATTR.capabilityVersion]: version } : {}),
        'az_pixiu.mcp.parameters_digest': shortDigest(digest),
      },
    );
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * Enforce §7.2 step 3: fail fast if any required capability for the given
 * analysis type is missing from the discovered allowed set. Optional
 * capabilities that are missing become data-quality findings later
 * (in the evidence executor / normalizer), not failures here.
 */
export function assertRequiredCapabilities(
  catalog: DiscoveredCatalog,
  analysisType: AnalysisType,
): void {
  const { required } = getRequiredCapabilities(analysisType);
  const allowedNames = new Set(catalog.allowed.map((c) => c.name));
  const missing = required.filter((n) => !allowedNames.has(n));
  if (missing.length > 0) {
    throw new RequiredCapabilityMissingError(analysisType, missing);
  }
}
