import { describe, it, expect } from 'vitest';
import {
  EvidenceRequestSchema,
  EvidencePlanSchema,
  EvidenceRecordSchema,
  PayloadRefSchema,
} from '../../src/schemas/index.js';

const validRequest = {
  capability: 'cost_analysis',
  parameters: { subscription_id: '11111111-1111-1111-1111-111111111111', granularity: 'Daily' },
  intent: 'cost_breakdown',
};

const validRecord = {
  evidence_id: 'ev-1',
  source_capability: 'cost_analysis',
  capability_version: '1.0.0',
  query_intent: 'cost_breakdown',
  scope_subset: { subscription_ids: ['11111111-1111-1111-1111-111111111111'] },
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  payload_ref: { kind: 'inline', data: { total: 1234.56 } },
  payload_summary: { total: 1234.56 },
  caveats: [],
};

describe('EvidenceRequestSchema', () => {
  it('accepts a well-formed request', () => {
    expect(EvidenceRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it('accepts an expected_role hint', () => {
    expect(
      EvidenceRequestSchema.safeParse({
        ...validRequest,
        expected_role: 'baseline cost for comparison',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty capability name', () => {
    expect(EvidenceRequestSchema.safeParse({ ...validRequest, capability: '' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown intent', () => {
    expect(EvidenceRequestSchema.safeParse({ ...validRequest, intent: 'lookup' }).success).toBe(
      false,
    );
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(
      EvidenceRequestSchema.safeParse({ ...validRequest, retry_count: 3 }).success,
    ).toBe(false);
  });
});

describe('EvidencePlanSchema', () => {
  it('accepts a non-empty plan', () => {
    expect(EvidencePlanSchema.safeParse({ requests: [validRequest] }).success).toBe(true);
  });

  it('rejects an empty plan (planner must produce at least one request)', () => {
    expect(EvidencePlanSchema.safeParse({ requests: [] }).success).toBe(false);
  });
});

describe('PayloadRefSchema', () => {
  it('accepts an inline payload', () => {
    expect(PayloadRefSchema.safeParse({ kind: 'inline', data: { rows: 3 } }).success).toBe(true);
  });

  it('accepts a hash reference', () => {
    expect(PayloadRefSchema.safeParse({ kind: 'hash', hash: 'sha256:abc...' }).success).toBe(true);
  });

  it('rejects a payload without a discriminator', () => {
    expect(PayloadRefSchema.safeParse({ data: { rows: 3 } }).success).toBe(false);
  });

  it('rejects a hash reference with an empty hash', () => {
    expect(PayloadRefSchema.safeParse({ kind: 'hash', hash: '' }).success).toBe(false);
  });
});

describe('EvidenceRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(EvidenceRecordSchema.safeParse(validRecord).success).toBe(true);
  });

  it('accepts a record carrying caveats', () => {
    expect(
      EvidenceRecordSchema.safeParse({
        ...validRecord,
        caveats: ['data is 14h stale', 'aggregation includes 3 untagged resources'],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty evidence_id', () => {
    expect(
      EvidenceRecordSchema.safeParse({ ...validRecord, evidence_id: '' }).success,
    ).toBe(false);
  });

  it('rejects when payload_ref is missing', () => {
    const { payload_ref: _p, ...withoutPayload } = validRecord;
    expect(EvidenceRecordSchema.safeParse(withoutPayload).success).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(
      EvidenceRecordSchema.safeParse({ ...validRecord, retrieved_at: '2026-05-18T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('rejects an inverted time_window via the refinement', () => {
    expect(
      EvidenceRecordSchema.safeParse({
        ...validRecord,
        time_window: { start: '2026-05-08T00:00:00Z', end: '2026-05-01T00:00:00Z' },
      }).success,
    ).toBe(false);
  });
});
