import { describe, it, expect } from 'vitest';
import { RunMetadataSchema } from '../../src/schemas/index.js';

const validMetadata = {
  run_id: '11111111-1111-1111-1111-111111111111',
  trace_id: 'trace-abc-123',
  prompt_versions: { planner: 'planner.v1', reasoner: 'reasoner.v1' },
  model_provider: 'foundry',
  model_name: 'gpt-5.4',
  model_config_hash: 'sha256:deadbeef',
  model_deployment_sku: 'GlobalStandard',
  credential_source: {
    implementation: 'AzureCliCredential',
    identity: 'operator@example.com',
  },
  amg_mcp_endpoint: 'https://example.grafana.azure.com',
  capability_versions: { cost_analysis: '1.0.0', query_resource_metric: '2.1.0' },
  started_at: '2026-05-18T12:00:00Z',
  status: 'success',
};

describe('RunMetadataSchema', () => {
  it('accepts a well-formed metadata record', () => {
    expect(RunMetadataSchema.safeParse(validMetadata).success).toBe(true);
  });

  it('accepts optional fields (ended_at, experiment_variant, fixture_id)', () => {
    expect(
      RunMetadataSchema.safeParse({
        ...validMetadata,
        ended_at: '2026-05-18T12:03:42Z',
        experiment_variant: 'planner-temperature-0.2',
        fixture_id: 'fixture-cost-surprise-001',
      }).success,
    ).toBe(true);
  });

  it('rejects when run_id is not a UUID', () => {
    expect(
      RunMetadataSchema.safeParse({ ...validMetadata, run_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects an unknown deployment SKU', () => {
    expect(
      RunMetadataSchema.safeParse({ ...validMetadata, model_deployment_sku: 'PayAsYouGo' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      RunMetadataSchema.safeParse({ ...validMetadata, status: 'in_progress' }).success,
    ).toBe(false);
  });

  it('rejects a non-URL amg_mcp_endpoint', () => {
    expect(
      RunMetadataSchema.safeParse({ ...validMetadata, amg_mcp_endpoint: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('rejects an empty capability version', () => {
    expect(
      RunMetadataSchema.safeParse({
        ...validMetadata,
        capability_versions: { cost_analysis: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      RunMetadataSchema.safeParse({ ...validMetadata, host: 'workstation-01' }).success,
    ).toBe(false);
  });
});
