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
});

describe('loadDataset — eval/cost-surprise-001.json', () => {
  it('loads and parses the seeded eval dataset', async () => {
    const dataset = await loadDataset('eval/cost-surprise-001.json');
    expect(dataset.schema_version).toBe('1');
    expect(dataset.items).toHaveLength(1);
    const item = dataset.items[0]!;
    expect(item.id).toBe('cost-surprise-001');
    expect(item.scope.analysis_type).toBe('cost_surprise');
    expect(item.expectations?.expected_capabilities_invoked).toContain('cost_analysis');
  });

  it('fixturePathFor resolves to fixtures/<fixture_id>', async () => {
    const dataset = await loadDataset('eval/cost-surprise-001.json');
    const item = dataset.items[0]!;
    const path = fixturePathFor(item).replace(/\\/g, '/');
    expect(path).toBe('fixtures/cost-surprise-001');
  });
});
