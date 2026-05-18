import { describe, it, expect } from 'vitest';
import { detectImperativeRemediation } from '../../src/lint/imperative.js';

describe('detectImperativeRemediation', () => {
  it.each([
    'delete the orphaned snapshot in rg-db-prod',
    'terminate db-prod-2 to save cost',
    'scale down the App Service plan',
    'restart the postgres server',
    'run kubectl scale to 0',
    'apply terraform to remove the unused subnet',
  ])('flags imperative remediation: %j', (text) => {
    expect(detectImperativeRemediation(text)).toEqual({
      matched: true,
      phrase: expect.any(String),
    });
  });

  it.each([
    'consider whether to delete the orphaned snapshot',
    'review the recent deployment to confirm workload alignment',
    'investigate whether scaling down is justified',
    'examine telemetry before deciding to terminate inactive instances',
    'evaluate whether to apply the SKU upgrade in the next change window',
    'compare utilization before and after to assess the restart pattern',
  ])('accepts softened phrasing: %j', (text) => {
    expect(detectImperativeRemediation(text)).toEqual({ matched: false });
  });

  it('returns the matched phrase for diagnostics', () => {
    const result = detectImperativeRemediation('delete the orphaned snapshot');
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.phrase.toLowerCase()).toContain('delete');
  });

  it('ignores imperative-looking words inside non-mutation contexts', () => {
    // "drop" appears but as a noun, not a verb
    expect(detectImperativeRemediation('investigate the cost drop in May')).toEqual({
      matched: false,
    });
  });

  it('handles empty / whitespace text', () => {
    expect(detectImperativeRemediation('')).toEqual({ matched: false });
    expect(detectImperativeRemediation('   ')).toEqual({ matched: false });
  });
});
