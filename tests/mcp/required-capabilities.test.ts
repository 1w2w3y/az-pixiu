import { describe, it, expect } from 'vitest';
import {
  REQUIRED_CAPABILITY_MAP,
  getRequiredCapabilities,
} from '../../src/mcp/required-capabilities.js';
import { PHASE_1_READ_ONLY_ALLOWLIST } from '../../src/mcp/allowlist.js';
import type { AnalysisType } from '../../src/schemas/index.js';

describe('REQUIRED_CAPABILITY_MAP', () => {
  it('defines a map for cost_surprise (the Phase 1 analysis type)', () => {
    expect(REQUIRED_CAPABILITY_MAP.cost_surprise).toBeDefined();
  });

  it('every required and optional capability is in the read-only allowlist', () => {
    // If this fails, the map and the allowlist have drifted apart.
    const cs = REQUIRED_CAPABILITY_MAP.cost_surprise;
    if (!cs) throw new Error('cost_surprise map missing');
    for (const name of [...cs.required, ...cs.optional]) {
      expect(PHASE_1_READ_ONLY_ALLOWLIST.has(name)).toBe(true);
    }
  });

  it('required and optional sets do not overlap', () => {
    const cs = REQUIRED_CAPABILITY_MAP.cost_surprise;
    if (!cs) throw new Error('cost_surprise map missing');
    const requiredSet = new Set(cs.required);
    for (const name of cs.optional) {
      expect(requiredSet.has(name)).toBe(false);
    }
  });

  it('cost_analysis is required (the central signal)', () => {
    const cs = REQUIRED_CAPABILITY_MAP.cost_surprise;
    expect(cs?.required).toContain('cost_analysis');
  });

  it('query_resource_health is optional (degradable per §11)', () => {
    const cs = REQUIRED_CAPABILITY_MAP.cost_surprise;
    expect(cs?.optional).toContain('query_resource_health');
  });
});

describe('getRequiredCapabilities', () => {
  it('returns the cost_surprise map', () => {
    const map = getRequiredCapabilities('cost_surprise');
    expect(map.required.length).toBeGreaterThan(0);
    expect(map.optional.length).toBeGreaterThan(0);
  });

  it.each<AnalysisType>([
    'idle_underused',
    'quarterly_review',
    'cost_telemetry_correlation',
    'tagging_hygiene',
  ])('throws for Phase 2+ analysis type "%s"', (analysisType) => {
    expect(() => getRequiredCapabilities(analysisType)).toThrow(/Phase 1 supports cost_surprise/);
  });
});
