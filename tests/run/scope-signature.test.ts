import { describe, it, expect } from 'vitest';
import { computeScopeSignature } from '../../src/run/scope-signature.js';
import type { Scope } from '../../src/schemas/index.js';

const baseScope: Scope = {
  subscription_ids: [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
  ],
  resource_group_names: ['rg-a', 'rg-b'],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  analysis_type: 'cost_summary',
  effective_scope_summary: '2 subs, 2 rgs',
};

describe('computeScopeSignature', () => {
  it('is deterministic for the same scope', () => {
    expect(computeScopeSignature(baseScope)).toBe(computeScopeSignature(baseScope));
  });

  it('is insensitive to subscription_ids order', () => {
    const reordered: Scope = {
      ...baseScope,
      subscription_ids: [...baseScope.subscription_ids].reverse(),
    };
    expect(computeScopeSignature(reordered)).toBe(computeScopeSignature(baseScope));
  });

  it('is insensitive to resource_group_names order', () => {
    const reordered: Scope = {
      ...baseScope,
      resource_group_names: ['rg-b', 'rg-a'],
    };
    expect(computeScopeSignature(reordered)).toBe(computeScopeSignature(baseScope));
  });

  it('treats undefined and empty resource_group_names as the same scope', () => {
    const undef: Scope = { ...baseScope };
    delete undef.resource_group_names;
    const empty: Scope = { ...baseScope, resource_group_names: [] };
    expect(computeScopeSignature(undef)).toBe(computeScopeSignature(empty));
  });

  it('is insensitive to time_window (the whole point of continuity)', () => {
    const laterWindow: Scope = {
      ...baseScope,
      time_window: { start: '2026-06-01T00:00:00Z', end: '2026-06-08T00:00:00Z' },
    };
    expect(computeScopeSignature(laterWindow)).toBe(computeScopeSignature(baseScope));
  });

  it('is insensitive to effective_scope_summary and display names', () => {
    const cosmetic: Scope = {
      ...baseScope,
      effective_scope_summary: 'different prose',
      subscription_display_names: {
        '11111111-1111-1111-1111-111111111111': 'prod',
        '22222222-2222-2222-2222-222222222222': 'staging',
      },
    };
    expect(computeScopeSignature(cosmetic)).toBe(computeScopeSignature(baseScope));
  });

  it('changes when a subscription is added or removed', () => {
    const fewer: Scope = {
      ...baseScope,
      subscription_ids: [baseScope.subscription_ids[0]!],
    };
    expect(computeScopeSignature(fewer)).not.toBe(computeScopeSignature(baseScope));
  });

  it('changes when analysis_type differs', () => {
    const other: Scope = { ...baseScope, analysis_type: 'cost_surprise' };
    expect(computeScopeSignature(other)).not.toBe(computeScopeSignature(baseScope));
  });

  it('changes when resource_group_names are narrowed', () => {
    const narrowed: Scope = { ...baseScope, resource_group_names: ['rg-a'] };
    expect(computeScopeSignature(narrowed)).not.toBe(computeScopeSignature(baseScope));
  });
});
