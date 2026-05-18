import { describe, it, expect } from 'vitest';
import {
  TimeWindowSchema,
  ScopeSubsetSchema,
  EvidenceIdSchema,
  FactIdSchema,
  RunIdSchema,
  AnalysisTypeSchema,
  QueryIntentSchema,
} from '../../src/schemas/index.js';

describe('TimeWindowSchema', () => {
  it('accepts an ordered ISO window', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-01T00:00:00Z',
      end: '2026-05-08T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects when end is before start', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-08T00:00:00Z',
      end: '2026-05-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when end equals start (must be strictly greater)', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-01T00:00:00Z',
      end: '2026-05-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('accepts windows with explicit non-UTC offsets', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-01T00:00:00-07:00',
      end: '2026-05-01T08:00:00+00:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects naive (no-offset) datetimes', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-01T00:00:00',
      end: '2026-05-08T00:00:00',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra keys (strict)', () => {
    const result = TimeWindowSchema.safeParse({
      start: '2026-05-01T00:00:00Z',
      end: '2026-05-08T00:00:00Z',
      duration: '7d',
    });
    expect(result.success).toBe(false);
  });
});

describe('ScopeSubsetSchema', () => {
  it('accepts an empty object (everything optional)', () => {
    expect(ScopeSubsetSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a fully-populated subset', () => {
    const result = ScopeSubsetSchema.safeParse({
      subscription_ids: ['11111111-1111-1111-1111-111111111111'],
      resource_group_names: ['rg-db-prod'],
      resource_ids: ['/subscriptions/.../resourceGroups/.../providers/...'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID subscription id', () => {
    const result = ScopeSubsetSchema.safeParse({ subscription_ids: ['not-a-uuid'] });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const result = ScopeSubsetSchema.safeParse({ regions: ['eastus'] });
    expect(result.success).toBe(false);
  });
});

describe('Branded ID schemas', () => {
  it('EvidenceIdSchema accepts non-empty strings', () => {
    expect(EvidenceIdSchema.safeParse('ev-1').success).toBe(true);
  });

  it('EvidenceIdSchema rejects empty strings', () => {
    expect(EvidenceIdSchema.safeParse('').success).toBe(false);
  });

  it('FactIdSchema accepts non-empty strings', () => {
    expect(FactIdSchema.safeParse('fact-1').success).toBe(true);
  });

  it('RunIdSchema accepts a UUID', () => {
    expect(RunIdSchema.safeParse('11111111-1111-1111-1111-111111111111').success).toBe(true);
  });

  it('RunIdSchema rejects a non-UUID', () => {
    expect(RunIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('Enum schemas', () => {
  it('AnalysisTypeSchema accepts cost_surprise (Phase 1)', () => {
    expect(AnalysisTypeSchema.safeParse('cost_surprise').success).toBe(true);
  });

  it('AnalysisTypeSchema accepts Phase 2 reserved names', () => {
    for (const name of [
      'idle_underused',
      'quarterly_review',
      'cost_telemetry_correlation',
      'tagging_hygiene',
    ]) {
      expect(AnalysisTypeSchema.safeParse(name).success).toBe(true);
    }
  });

  it('AnalysisTypeSchema rejects unknown analysis types', () => {
    expect(AnalysisTypeSchema.safeParse('reliability_review').success).toBe(false);
  });

  it('QueryIntentSchema accepts all defined intents', () => {
    for (const intent of [
      'cost_breakdown',
      'inventory',
      'utilization',
      'activity',
      'health',
      'metric_definition',
    ]) {
      expect(QueryIntentSchema.safeParse(intent).success).toBe(true);
    }
  });
});
