import { describe, it, expect } from 'vitest';
import { intakeScope } from '../../src/run/scope-intake.js';

const subId = '11111111-1111-1111-1111-111111111111';

describe('intakeScope — happy path', () => {
  it('produces a valid Scope from a minimal subscription id', () => {
    const scope = intakeScope({
      subscription_ids: [subId],
      now: new Date('2026-05-18T00:00:00Z'),
    });
    expect(scope.subscription_ids).toEqual([subId]);
    expect(scope.analysis_type).toBe('cost_surprise');
    expect(scope.time_window.end).toBe('2026-05-18T00:00:00.000Z');
    expect(scope.time_window.start).toBe('2026-05-11T00:00:00.000Z');
    // baseline defaults to the 7 days before time_window.start
    expect(scope.baseline_window.end).toBe('2026-05-11T00:00:00.000Z');
    expect(scope.baseline_window.start).toBe('2026-05-04T00:00:00.000Z');
  });

  it('echoes the scope summary with subscription, RGs, and windows', () => {
    const scope = intakeScope({
      subscription_ids: [subId],
      resource_group_names: ['rg-a', 'rg-b'],
      now: new Date('2026-05-18T00:00:00Z'),
    });
    expect(scope.effective_scope_summary).toContain(subId);
    expect(scope.effective_scope_summary).toContain('2 resource group(s)');
    expect(scope.effective_scope_summary).toContain('rg-a');
  });

  it('respects explicit time windows', () => {
    const scope = intakeScope({
      subscription_ids: [subId],
      time_window_start: '2026-04-01T00:00:00Z',
      time_window_end: '2026-04-08T00:00:00Z',
      baseline_window_start: '2026-03-25T00:00:00Z',
      baseline_window_end: '2026-04-01T00:00:00Z',
    });
    expect(scope.time_window).toEqual({
      start: '2026-04-01T00:00:00Z',
      end: '2026-04-08T00:00:00Z',
    });
    expect(scope.baseline_window).toEqual({
      start: '2026-03-25T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
  });

  it('threads user_context through unchanged', () => {
    const scope = intakeScope({
      subscription_ids: [subId],
      user_context: 'we deployed a caching layer last week',
    });
    expect(scope.user_context).toBe('we deployed a caching layer last week');
  });

  it('embeds subscription_display_names and uses them in the summary', () => {
    const scope = intakeScope({
      subscription_ids: [subId],
      subscription_display_names: { [subId]: 'prod-billing' },
    });
    expect(scope.subscription_display_names).toEqual({ [subId]: 'prod-billing' });
    expect(scope.effective_scope_summary).toContain('"prod-billing"');
    expect(scope.effective_scope_summary).toContain(subId);
  });

  it('uses names for multi-subscription summaries and drops names for out-of-scope ids', () => {
    const otherSub = '22222222-2222-2222-2222-222222222222';
    const strayId = '33333333-3333-3333-3333-333333333333';
    const scope = intakeScope({
      subscription_ids: [subId, otherSub],
      subscription_display_names: {
        [subId]: 'prod-billing',
        [otherSub]: 'dev-sandbox',
        [strayId]: 'unrelated',
      },
    });
    expect(scope.subscription_display_names).toEqual({
      [subId]: 'prod-billing',
      [otherSub]: 'dev-sandbox',
    });
    expect(scope.effective_scope_summary).toContain('"prod-billing"');
    expect(scope.effective_scope_summary).toContain('"dev-sandbox"');
    expect(scope.effective_scope_summary).not.toContain('unrelated');
  });

  it('renders bare ids when no display names are supplied', () => {
    const scope = intakeScope({ subscription_ids: [subId] });
    expect(scope.subscription_display_names).toBeUndefined();
    expect(scope.effective_scope_summary).toContain(`subscription ${subId}`);
    expect(scope.effective_scope_summary).not.toContain('"');
  });
});

describe('intakeScope — validation', () => {
  it('throws when subscription is not a UUID (caught by ScopeSchema)', () => {
    expect(() => intakeScope({ subscription_ids: ['not-a-uuid'] })).toThrow();
  });

  it('throws when time_window.end <= time_window.start', () => {
    expect(() =>
      intakeScope({
        subscription_ids: [subId],
        time_window_start: '2026-05-08T00:00:00Z',
        time_window_end: '2026-05-01T00:00:00Z',
      }),
    ).toThrow();
  });
});
