import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { trace, type Tracer } from '@opentelemetry/api';

/**
 * Observability setup (design §4.9). Initializes a single OTEL tracer
 * provider for the run. Three modes:
 *
 *   - 'langfuse' — register LangfuseSpanProcessor (requires
 *     LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASEURL env
 *     vars or explicit options). LLM spans auto-emitted via
 *     observeOpenAI; manual §14 spans emitted via startActiveSpan.
 *   - 'memory' — InMemorySpanExporter, useful for tests and the local
 *     trace-artifact mode when Langfuse is disabled.
 *   - 'noop' — no exporter; spans created but never shipped. Default
 *     when no configuration is supplied.
 *
 * The function is idempotent within a process — subsequent calls return
 * the same tracer provider. Use shutdownTracing() between runs in tests
 * to reset.
 */

const TRACER_NAME = 'az-pixiu';
const TRACER_VERSION = '0.1.0';

export type ObservabilityMode = 'langfuse' | 'memory' | 'noop';

export interface ObservabilityConfig {
  mode: ObservabilityMode;
}

export interface ObservabilityState {
  mode: ObservabilityMode;
  tracer: Tracer;
  inMemoryExporter?: InMemorySpanExporter;
  shutdown: () => Promise<void>;
}

let activeState: ObservabilityState | undefined;

export function initializeTracing(config: ObservabilityConfig = { mode: 'noop' }): ObservabilityState {
  if (activeState && activeState.mode === config.mode) return activeState;
  if (activeState) {
    // Different mode requested — shut the previous one down.
    void activeState.shutdown();
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
      // Lazy-require so test runs without Langfuse env don't pay the
      // initialization cost or risk env-validation throws.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { LangfuseSpanProcessor } = require('@langfuse/otel') as typeof import('@langfuse/otel');
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

  const tracer = provider.getTracer(TRACER_NAME, TRACER_VERSION);

  const state: ObservabilityState = {
    mode: config.mode,
    tracer,
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
