import { describe, it, expect } from 'vitest';
import { loadDataset, fixturePathFor, DatasetSchema } from '../../src/evaluation/dataset.js';

describe('DatasetSchema', () => {
  it('rejects an empty items list', () => {
    expect(DatasetSchema.safeParse({ schema_version: '1', items: [] }).success).toBe(false);
  });

  it('rejects unknown schema_version', () => {
    expect(
      DatasetSchema.safeParse({ schema_version: '2', items: [] }).success,
    ).toBe(false);
  });

  it('requires a target lane for waste-candidate expectations', () => {
    const parsed = DatasetSchema.safeParse({
      schema_version: '1',
      items: [
        {
          id: 'waste-contract',
          fixture_id: 'fixture',
          scope: {
            subscription_ids: ['11111111-1111-1111-1111-111111111111'],
            time_window: {
              start: '2026-05-01T00:00:00Z',
              end: '2026-05-08T00:00:00Z',
            },
            analysis_type: 'cost_summary',
            effective_scope_summary: 'one subscription',
          },
          expectations: { expected_candidate_count: 0 },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the cost-judgment expectation contracts together', () => {
    const parsed = DatasetSchema.safeParse({
      schema_version: '1',
      items: [
        {
          id: 'cost-judgment-contract',
          fixture_id: 'fixture',
          scope: {
            subscription_ids: ['11111111-1111-1111-1111-111111111111'],
            time_window: {
              start: '2026-05-01T00:00:00Z',
              end: '2026-05-08T00:00:00Z',
            },
            analysis_type: 'cost_summary',
            effective_scope_summary: 'one subscription',
          },
          expectations: {
            expected_waste_lane: 'orphan_public_ip',
            expected_lane_total: {
              low_usd: 9,
              high_usd: 11,
              point_usd: 10,
              available_count: 1,
              unavailable_count: 0,
            },
            require_utilization_evidence_for_optimization_claims: true,
            require_waste_cost_reconciliation: {
              lane: 'orphan_public_ip',
              resource_type: 'Microsoft.Network/publicIPAddresses',
            },
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('requires a target lane for expected_lane_total', () => {
    const parsed = DatasetSchema.safeParse({
      schema_version: '1',
      items: [
        {
          id: 'lane-total-without-lane',
          fixture_id: 'fixture',
          scope: {
            subscription_ids: ['11111111-1111-1111-1111-111111111111'],
            time_window: {
              start: '2026-05-01T00:00:00Z',
              end: '2026-05-08T00:00:00Z',
            },
            analysis_type: 'cost_summary',
            effective_scope_summary: 'one subscription',
          },
          expectations: {
            expected_lane_total: {
              low_usd: 9,
              high_usd: 11,
              point_usd: 10,
              available_count: 1,
              unavailable_count: 0,
            },
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['items', 0, 'expectations', 'expected_waste_lane'],
          }),
        ]),
      );
    }
  });

  it('requires reconciliation to name the selected waste lane', () => {
    const makeDataset = (expectedWasteLane?: string) => ({
      schema_version: '1',
      items: [
        {
          id: 'reconciliation-lane-refinement',
          fixture_id: 'fixture',
          scope: {
            subscription_ids: ['11111111-1111-1111-1111-111111111111'],
            time_window: {
              start: '2026-05-01T00:00:00Z',
              end: '2026-05-08T00:00:00Z',
            },
            analysis_type: 'cost_summary',
            effective_scope_summary: 'one subscription',
          },
          expectations: {
            ...(expectedWasteLane ? { expected_waste_lane: expectedWasteLane } : {}),
            require_waste_cost_reconciliation: {
              lane: 'orphan_public_ip',
              resource_type: 'Microsoft.Network/publicIPAddresses',
            },
          },
        },
      ],
    });

    expect(DatasetSchema.safeParse(makeDataset()).success).toBe(false);
    expect(DatasetSchema.safeParse(makeDataset('idle_disk')).success).toBe(false);
    expect(DatasetSchema.safeParse(makeDataset('orphan_public_ip')).success).toBe(true);
  });
});

describe('loadDataset — eval/cost-surprise-001.json', () => {
  it('loads and parses the seeded eval dataset', async () => {
    const dataset = await loadDataset('eval/cost-surprise-001.json');
    expect(dataset.schema_version).toBe('1');
    expect(dataset.items).toHaveLength(1);
    const item = dataset.items[0]!;
    expect(item.id).toBe('cost-surprise-001');
    expect(item.scope.analysis_type).toBe('cost_surprise');
    expect(item.expectations?.expected_capabilities_invoked).toContain('amgmcp_cost_analysis');
  });

  it('fixturePathFor resolves to fixtures/<fixture_id>', async () => {
    const dataset = await loadDataset('eval/cost-surprise-001.json');
    const item = dataset.items[0]!;
    const path = fixturePathFor(item).replace(/\\/g, '/');
    expect(path).toBe('fixtures/cost-surprise-001');
  });
});
