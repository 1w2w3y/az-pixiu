import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { trace, type Tracer } from '@opentelemetry/api';
import { LangfuseSpanProcessor } from '@langfuse/otel';

/**
 * Observability setup (design §4.9). Initializes a single OTEL tracer
 * provider for the run. Three modes:
 *
 *   - 'langfuse' — registers a LangfuseSpanProcessor. The processor's
 *     constructor reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
 *     LANGFUSE_BASE_URL (legacy LANGFUSE_BASEURL also accepted) at call
 *     time, so callers should only select this mode when those are set
 *     (or supply explicit options).
 *   - 'memory' — InMemorySpanExporter, used by tests and by the local
 *     trace-artifact mode when Langfuse is disabled.
 *   - 'noop' — no exporter; spans created but never shipped. Default
 *     when no configuration is supplied.
 *
 * Idempotent within a process: subsequent calls return the existing
 * state when the requested mode matches. A mode switch fully awaits the
 * previous provider's shutdown before installing the new one — earlier
 * fire-and-forget behavior could drop in-flight spans.
 */

const TRACER_NAME = 'az-pixiu';
const TRACER_VERSION = '0.1.0';

export type ObservabilityMode = 'langfuse' | 'memory' | 'noop';

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

export async function initializeTracing(
  config: ObservabilityConfig = { mode: 'noop' },
): Promise<ObservabilityState> {
  if (activeState && activeState.mode === config.mode) return activeState;
  if (activeState) {
    // Different mode requested — wait for the previous one to flush
    // before installing the new provider, so spans don't get dropped.
    await activeState.shutdown();
  }

  let processor: SpanProcessor | undefined;
  let inMemoryExporter: InMemorySpanExporter | undefined;

  switch (config.mode) {
    case 'memory': {
      inMemoryExporter = new InMemorySpanExporter();
      processor = new SimpleSpanProcessor(inMemoryExporter);
      break;
    }
    case 'langfuse': {
      processor = new LangfuseSpanProcessor();
      break;
    }
    case 'noop':
    default:
      processor = undefined;
      break;
  }

  const provider = new NodeTracerProvider({
    spanProcessors: processor ? [processor] : [],
  });
  provider.register();
  // Belt-and-braces: ensure the global is the new provider even if some
  // other code path nuked it (vitest workers tend to share globals).
  trace.setGlobalTracerProvider(provider);

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
