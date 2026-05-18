import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeTracing, shutdownTracing } from '../../src/observability/setup.js';
import { withSpan, emitEvent, SpanNames, ATTR } from '../../src/observability/spans.js';

let state: ReturnType<typeof initializeTracing>;

beforeEach(() => {
  state = initializeTracing({ mode: 'memory' });
});

afterEach(async () => {
  await shutdownTracing();
});

describe('initializeTracing — memory mode', () => {
  it('exposes an in-memory exporter', () => {
    expect(state.mode).toBe('memory');
    expect(state.inMemoryExporter).toBeDefined();
  });
});

describe('withSpan', () => {
  it('emits a span with the supplied name and attributes', async () => {
    await withSpan(
      SpanNames.RunRoot,
      async () => {
        return 'done';
      },
      { [ATTR.agentName]: 'az-pixiu', [ATTR.analysisType]: 'cost_surprise' },
    );
    await state.inMemoryExporter!.forceFlush();
    const spans = state.inMemoryExporter!.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('run.root');
    expect(spans[0]?.attributes[ATTR.agentName]).toBe('az-pixiu');
    expect(spans[0]?.attributes[ATTR.analysisType]).toBe('cost_surprise');
  });

  it('returns the wrapped block value', async () => {
    const result = await withSpan('run.test', async () => 42);
    expect(result).toBe(42);
  });

  it('records an exception and re-throws on failure', async () => {
    await expect(
      withSpan('run.fail', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await state.inMemoryExporter!.forceFlush();
    const spans = state.inMemoryExporter!.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).not.toBe(0); // OK = UNSET = 0; ERROR = 2
    expect(spans[0]?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('nests child spans inside parent spans (OTEL context propagation)', async () => {
    await withSpan(SpanNames.RunRoot, async () => {
      await withSpan(SpanNames.CapabilityDiscovery, async () => {
        await withSpan(SpanNames.EvidenceToolCall('cost_analysis'), async () => null);
      });
    });
    await state.inMemoryExporter!.forceFlush();
    const spans = state.inMemoryExporter!.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'evidence.tool_call.cost_analysis',
      'run.capability_discovery',
      'run.root',
    ]);
    const rootId = spans.find((s) => s.name === 'run.root')?.spanContext().spanId;
    const discoveryId = spans.find((s) => s.name === 'run.capability_discovery')?.spanContext().spanId;
    const toolCall = spans.find((s) => s.name === 'evidence.tool_call.cost_analysis');
    expect(spans.find((s) => s.name === 'run.capability_discovery')?.parentSpanContext?.spanId).toBe(rootId);
    expect(toolCall?.parentSpanContext?.spanId).toBe(discoveryId);
  });
});

describe('emitEvent', () => {
  it('adds a named event to the current span (e.g., mutating_capabilities_excluded)', async () => {
    await withSpan(SpanNames.CapabilityDiscovery, async (span) => {
      emitEvent(span, 'mutating_capabilities_excluded', { count: 1 });
    });
    await state.inMemoryExporter!.forceFlush();
    const spans = state.inMemoryExporter!.getFinishedSpans();
    expect(spans[0]?.events).toContainEqual(
      expect.objectContaining({ name: 'mutating_capabilities_excluded' }),
    );
  });
});

describe('SpanNames vocabulary', () => {
  it('matches the §14 catalog', () => {
    expect(SpanNames.RunRoot).toBe('run.root');
    expect(SpanNames.ConfigResolution).toBe('run.config_resolution');
    expect(SpanNames.ScopeIntake).toBe('run.scope_intake');
    expect(SpanNames.CapabilityDiscovery).toBe('run.capability_discovery');
    expect(SpanNames.EvidencePlanning).toBe('run.evidence_planning');
    expect(SpanNames.EvidenceRetrieval).toBe('run.evidence_retrieval');
    expect(SpanNames.Reasoning).toBe('run.reasoning');
    expect(SpanNames.ReportAssembly).toBe('run.report_assembly');
    expect(SpanNames.Finalize).toBe('run.finalize');
    expect(SpanNames.EvidenceToolCall('cost_analysis')).toBe('evidence.tool_call.cost_analysis');
    expect(SpanNames.ReasoningModelCall).toBe('reasoning.model_call');
  });
});
