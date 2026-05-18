import { describe, it, expect } from 'vitest';
import { ScopeSchema } from '../../src/schemas/index.js';

const validScope = {
  subscription_ids: ['11111111-1111-1111-1111-111111111111'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: '1 subscription, 7-day window vs 7-day baseline',
};

describe('ScopeSchema', () => {
  it('accepts a minimal valid scope', () => {
    expect(ScopeSchema.safeParse(validScope).success).toBe(true);
  });

  it('accepts a fully-populated scope including user_context and filters', () => {
    const result = ScopeSchema.safeParse({
      ...validScope,
      resource_group_names: ['rg-db-prod', 'rg-app-prod'],
      resource_type_filter: ['Microsoft.DBforPostgreSQL/flexibleServers'],
      user_context: 'recent deployment of new caching layer',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty subscription_ids list', () => {
    expect(ScopeSchema.safeParse({ ...validScope, subscription_ids: [] }).success).toBe(false);
  });

  it('rejects a non-UUID subscription_id', () => {
    expect(
      ScopeSchema.safeParse({ ...validScope, subscription_ids: ['not-a-uuid'] }).success,
    ).toBe(false);
  });

  it('rejects when baseline_window is missing (Phase 1: cost_surprise requires it)', () => {
    const { baseline_window: _b, ...withoutBaseline } = validScope;
    expect(ScopeSchema.safeParse(withoutBaseline).success).toBe(false);
  });

  it('rejects an inverted time window via the TimeWindow refinement', () => {
    expect(
      ScopeSchema.safeParse({
        ...validScope,
        time_window: { start: '2026-05-08T00:00:00Z', end: '2026-05-01T00:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty effective_scope_summary', () => {
    expect(ScopeSchema.safeParse({ ...validScope, effective_scope_summary: '' }).success).toBe(
      false,
    );
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(
      ScopeSchema.safeParse({ ...validScope, regions: ['eastus'] }).success,
    ).toBe(false);
  });

  it('rejects an unknown analysis_type', () => {
    expect(
      ScopeSchema.safeParse({ ...validScope, analysis_type: 'capacity_review' }).success,
    ).toBe(false);
  });
});
