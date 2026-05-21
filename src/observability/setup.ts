import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { McpInstrumentation as TraceloopMcpInstrumentation } from '@traceloop/instrumentation-mcp';
import { MCPInstrumentation as OpenInferenceMcpInstrumentation } from '@arizeai/openinference-instrumentation-mcp';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
import { Client as MCPSDKClient } from '@modelcontextprotocol/sdk/client/index.js';
import * as ClientStreamableHTTPModule from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as openaiModule from 'openai';

/**
 * Observability setup (design §4.9, §14). Initializes a single OTEL tracer
 * provider for the run. Three modes:
 *
 *   - 'langfuse' — registers a LangfuseSpanProcessor; if PHOENIX_BASE_URL
 *     is set, a parallel BatchSpanProcessor ships the same spans to a
 *     Phoenix instance over OTLP HTTP. The Langfuse processor reads
 *     LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL
 *     (legacy LANGFUSE_BASEURL also accepted) at call time, so callers
 *     should only select this mode when those are set.
 *   - 'memory' — InMemorySpanExporter, used by tests and by the local
 *     trace-artifact mode when Langfuse is disabled.
 *   - 'noop' — no exporter; spans created but never shipped. Default
 *     when no configuration is supplied.
 *
 * Two instrumentation flavors run side-by-side in this codebase:
 *
 *   - 'langfuse'        — @langfuse/openai wraps OpenAI clients (emits
 *                         gen_ai.* attributes that Langfuse's UI renders);
 *                         @traceloop/instrumentation-mcp patches the MCP
 *                         SDK Client.
 *   - 'openinference'   — @arizeai/openinference-instrumentation-openai
 *                         patches the openai module (emits OpenInference
 *                         input.value / output.value / llm.* attributes
 *                         that Phoenix's UI renders); the Arize MCP
 *                         instrumentation patches the streamableHttp
 *                         transport module.
 *
 * Both flavors patch the same OpenAI client and the same MCP machinery,
 * so running them in the same process would double-instrument every
 * call. Instead the flavor is chosen **once per process** at module-load
 * time (env override AZ_PIXIU_INSTRUMENTATION; otherwise a 50/50 coin
 * flip) and the choice is exported via {@link currentInstrumentationFlavor}
 * so the model clients can decide whether to apply the Langfuse wrapper.
 *
 * Idempotent within a process: subsequent calls return the existing
 * state when the requested mode matches. A mode switch fully awaits the
 * previous provider's shutdown before installing the new one — earlier
 * fire-and-forget behavior could drop in-flight spans.
 */

const TRACER_NAME = 'az-pixiu';
const TRACER_VERSION = '0.1.0';

export type ObservabilityMode = 'langfuse' | 'memory' | 'noop';

export type InstrumentationFlavor = 'langfuse' | 'openinference';

export interface ObservabilityConfig {
  mode: ObservabilityMode;
}

export interface ObservabilityState {
  mode: ObservabilityMode;
  /**
   * Tracer obtained directly from the run-specific provider. Used as
   * the fast path in currentTracer() — bypasses the global registry,
   * which can return a no-op tracer when vitest workers share state.
   */
  tracer: Tracer;
  inMemoryExporter?: InMemorySpanExporter;
  shutdown: () => Promise<void>;
}

let activeState: ObservabilityState | undefined;

/**
 * Instrumentation flavor is selected once at module-load time and frozen
 * for the lifetime of the process. We resolve it eagerly (not lazily
 * inside initializeTracing) so callers like the model clients — which
 * are constructed before the first tracing init — can read the same
 * value when deciding whether to apply the Langfuse openai wrapper.
 */
const flavor: InstrumentationFlavor = pickInstrumentationFlavor();

function pickInstrumentationFlavor(): InstrumentationFlavor {
  const override = process.env.AZ_PIXIU_INSTRUMENTATION?.trim().toLowerCase();
  if (override === 'langfuse' || override === 'openinference') return override;
  // Math.random() is not cryptographic but the choice has no security
  // implication — we just want a roughly-even sample across runs so
  // both flavors get exercised in eval sweeps and live runs over time.
  return Math.random() < 0.5 ? 'langfuse' : 'openinference';
}

export function currentInstrumentationFlavor(): InstrumentationFlavor {
  return flavor;
}

/**
 * The OpenAI/MCP instrumentations patch shared module state and need to
 * run exactly once per process. Each `ensure*Patched` flag guards a
 * different patch — we keep them separate so that a future mode that
 * mixes them (e.g. Arize OpenAI + Traceloop MCP) is a small change.
 *
 * Only the live MCP transport benefits from MCP instrumentation —
 * FixtureMCPTransport doesn't call the SDK at all. Fixture runs default
 * to --observability noop anyway, so the practical impact is zero.
 */
let mcpInstrumentationPatched = false;
function ensureMcpInstrumented(): void {
  if (mcpInstrumentationPatched) return;
  if (flavor === 'langfuse') {
    // In CommonJS `registerInstrumentations()` would handle this via
    // require-hooks, but this project is ESM — imports are hoisted
    // before any registration runs — so we use the SDK's explicit
    // `manuallyInstrument({ Client })` path instead.
    new TraceloopMcpInstrumentation().manuallyInstrument({ Client: MCPSDKClient });
  } else {
    // Arize's MCP instrumentation patches transport modules (it
    // propagates trace context across the wire), not the Client class.
    // Az-Pixiu's live transport uses streamable-HTTP, so that's the
    // only sub-module we hand it.
    new OpenInferenceMcpInstrumentation().manuallyInstrument({
      clientStreamableHTTPModule: ClientStreamableHTTPModule,
    });
  }
  mcpInstrumentationPatched = true;
}

let openaiInstrumentationPatched = false;
function ensureOpenAIInstrumented(): void {
  if (openaiInstrumentationPatched) return;
  // The langfuse flavor instruments OpenAI per-client via observeOpenAI()
  // inside the model client constructor — see openai-client.ts /
  // litellm-client.ts. Nothing to register globally here.
  if (flavor !== 'openinference') {
    openaiInstrumentationPatched = true;
    return;
  }
  // Arize's manuallyInstrument types its parameter as `typeof OpenAI`
  // (the default-exported class), but the runtime walks
  // `module.OpenAI.Chat.Completions.prototype` — i.e., it expects the
  // module namespace object. Pass the namespace and cast through never.
  new OpenAIInstrumentation().manuallyInstrument(openaiModule as never);
  openaiInstrumentationPatched = true;
}

/**
 * Build a Phoenix span processor if PHOENIX_BASE_URL is set. The base
 * URL is treated as the Phoenix root (no path); we append `/v1/traces`
 * unless the operator already included it. PHOENIX_API_KEY is optional —
 * dev Phoenix instances commonly run without auth, prod ones expect a
 * bearer header.
 *
 * Uses the protobuf OTLP exporter (`exporter-trace-otlp-proto`), not the
 * JSON one (`exporter-trace-otlp-http`). Phoenix's OTLP receiver rejects
 * `Content-Type: application/json` with `415 Unsupported Media Type`; it
 * only accepts protobuf payloads. The two packages have identical APIs
 * and both target `<base>/v1/traces`, so the only practical difference
 * is the wire encoding.
 */
function buildPhoenixProcessor(): SpanProcessor | undefined {
  const base = process.env.PHOENIX_BASE_URL?.trim();
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, '');
  const url = trimmed.endsWith('/v1/traces') ? trimmed : `${trimmed}/v1/traces`;
  const apiKey = process.env.PHOENIX_API_KEY?.trim();
  return new BatchSpanProcessor(
    new OTLPTraceExporter({
      url,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    }),
  );
}

export async function initializeTracing(
  config: ObservabilityConfig = { mode: 'noop' },
): Promise<ObservabilityState> {
  if (activeState && activeState.mode === config.mode) return activeState;
  if (activeState) {
    // Different mode requested — wait for the previous one to flush
    // before installing the new provider, so spans don't get dropped.
    await activeState.shutdown();
  }

  const processors: SpanProcessor[] = [];
  let inMemoryExporter: InMemorySpanExporter | undefined;

  switch (config.mode) {
    case 'memory': {
      inMemoryExporter = new InMemorySpanExporter();
      processors.push(new SimpleSpanProcessor(inMemoryExporter));
      break;
    }
    case 'langfuse': {
      // By default LangfuseSpanProcessor only keeps spans from a small
      // allowlist of LLM-flavored instrumentation scopes (langfuse-sdk,
      // openinference, litellm, etc.) or spans carrying gen_ai.*
      // attributes. That filter drops the az-pixiu trace tree —
      // run.*, evidence.tool_call.*, and the MCP spans — leaving only
      // the OpenAI auto-instrumentation visible. Override with a
      // permissive filter so the full §14 trace tree exports.
      processors.push(new LangfuseSpanProcessor({ shouldExportSpan: () => true }));
      const phoenix = buildPhoenixProcessor();
      if (phoenix) processors.push(phoenix);
      break;
    }
    case 'noop':
    default:
      break;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: TRACER_NAME,
    [ATTR_SERVICE_VERSION]: TRACER_VERSION,
  });
  const provider = new NodeTracerProvider({ spanProcessors: processors, resource });
  provider.register();
  // Belt-and-braces: ensure the global is the new provider even if some
  // other code path nuked it (vitest workers tend to share globals).
  trace.setGlobalTracerProvider(provider);

  // Install instrumentation patches now that the global provider is in
  // place. Patching before this point would leave the instrumentation
  // wired to whatever stale provider was previously global. Both calls
  // are idempotent — the patches stay installed for the lifetime of the
  // process even across mode switches.
  ensureMcpInstrumented();
  ensureOpenAIInstrumented();

  const state: ObservabilityState = {
    mode: config.mode,
    tracer: provider.getTracer(TRACER_NAME, TRACER_VERSION),
    ...(inMemoryExporter ? { inMemoryExporter } : {}),
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
      activeState = undefined;
    },
  };
  activeState = state;
  return state;
}

export function shutdownTracing(): Promise<void> {
  if (!activeState) return Promise.resolve();
  return activeState.shutdown();
}

export function currentTracer(): Tracer {
  if (activeState) return activeState.tracer;
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}
