import { describe, it, expect } from 'vitest';
import { DataQualityFindingSchema } from '../../src/schemas/index.js';

const validFinding = {
  dq_id: 'dq-1',
  category: 'missing_telemetry',
  affected_capability: 'query_resource_metric',
  affected_scope_subset: {
    subscription_ids: null,
    resource_group_names: ['rg-db-prod'],
    resource_ids: null,
  },
  consequence_for_analysis:
    'utilization signal is unavailable for 2 PostgreSQL servers; cost-only recommendations are bounded',
  impact_on_recommendations: ['rec-1'],
  actionable_hint: 'grant Reader on rg-db-prod to fill the telemetry gap',
};

describe('DataQualityFindingSchema', () => {
  it('accepts a well-formed finding', () => {
    expect(DataQualityFindingSchema.safeParse(validFinding).success).toBe(true);
  });

  it('accepts a finding with null actionable_hint and affected_capability', () => {
    expect(
      DataQualityFindingSchema.safeParse({
        ...validFinding,
        actionable_hint: null,
        affected_capability: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(
      DataQualityFindingSchema.safeParse({ ...validFinding, category: 'cosmic_ray' }).success,
    ).toBe(false);
  });

  it('rejects an empty consequence_for_analysis', () => {
    expect(
      DataQualityFindingSchema.safeParse({ ...validFinding, consequence_for_analysis: '' })
        .success,
    ).toBe(false);
  });

  it('accepts all design-specified retrieval and analytical categories', () => {
    for (const category of [
      'auth',
      'authz_gap',
      'unsupported_capability',
      'invalid_scope',
      'timeout',
      'rate_limit',
      'schema_mismatch',
      'empty_result',
      'stale_data',
      'partial_coverage',
      'tagging_gap',
      'missing_telemetry',
      'freshness_partial_window',
      'freshness_uniform_drop',
      'cost_zero_suspected',
      'zero_unresolved',
      'cost_scope_mismatch',
      'billing_probe_excluded',
    ]) {
      expect(DataQualityFindingSchema.safeParse({ ...validFinding, category }).success).toBe(true);
    }
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      DataQualityFindingSchema.safeParse({ ...validFinding, severity: 'medium' }).success,
    ).toBe(false);
  });
});
