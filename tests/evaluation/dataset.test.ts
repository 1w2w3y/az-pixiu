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
