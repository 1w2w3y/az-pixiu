import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  inspectPayloadForFailure,
  inspectToolCallResultForFailure,
} from '../../src/evidence/payload-failure.js';
import type { ToolCallResult } from '../../src/schemas/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '../fixtures/cost-analysis-embedded-429.json');

async function loadEmbedded429Fixture(): Promise<Record<string, unknown>> {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('inspectPayloadForFailure — unknown capability', () => {
  it('returns undefined for capabilities with no registered inspector', () => {
    expect(inspectPayloadForFailure('amgmcp_query_resource_graph', { anything: true })).toBeUndefined();
    expect(inspectPayloadForFailure('amgmcp_query_activity_log', null)).toBeUndefined();
    expect(inspectPayloadForFailure('made_up_capability', { subscriptions: [{ error: 'rate limit (429)' }] })).toBeUndefined();
  });
});

describe('inspectPayloadForFailure — amgmcp_cost_analysis', () => {
  it('detects the live embedded-429 fixture as rate_limit', async () => {
    const payload = await loadEmbedded429Fixture();
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', payload);
    expect(failure).toBeDefined();
    expect(failure?.category).toBe('rate_limit');
    expect(failure?.capability).toBe('amgmcp_cost_analysis');
    expect(failure?.source).toBe('payload-embedded');
    expect(failure?.message).toMatch(/rate limit \(429\)/i);
  });

  it('matches the throttle pattern', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 0,
          byService: [],
          byRegion: [],
          byResourceType: [],
          error: 'Upstream throttled the request',
        },
      ],
    });
    expect(failure?.category).toBe('rate_limit');
    expect(failure?.source).toBe('payload-embedded');
  });

  it('matches the rate-limit pattern with separator variants', () => {
    for (const wording of [
      'rate limit exceeded',
      'rate-limit exceeded',
      'ratelimit exceeded',
    ]) {
      const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
        subscriptions: [{ error: wording, totalCost: 0, byService: [] }],
      });
      expect(failure?.category, `wording: ${wording}`).toBe('rate_limit');
    }
  });

  it('classifies "unauthorized" embedded errors as auth', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 0,
          byService: [],
          error: 'Unauthorized: token expired',
        },
      ],
    });
    expect(failure?.category).toBe('auth');
    expect(failure?.source).toBe('payload-embedded');
  });

  it('classifies "forbidden" embedded errors as authz_gap', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 0,
          byService: [],
          error: 'Access denied to subscription',
        },
      ],
    });
    expect(failure?.category).toBe('authz_gap');
  });

  it('classifies unrecognised error + empty data as schema_mismatch', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 0,
          byService: [],
          error: 'Some weird upstream condition we have not seen',
        },
      ],
    });
    expect(failure?.category).toBe('schema_mismatch');
  });

  it('returns undefined for clean payloads', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 1234.56,
          byService: [{ service: 'Storage', cost: 1000 }],
          byRegion: [],
          byResourceType: [],
        },
      ],
    });
    expect(failure).toBeUndefined();
  });

  it('returns undefined when subscriptions has an error string but data is non-empty (unclear partial — out of scope, treat as success today)', () => {
    // Partial-success handling is explicitly deferred per the design's
    // Out-of-scope note. An "unknown error" plus real data is not yet
    // matched as schema_mismatch — only the empty-data path is.
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 100,
          byService: [{ service: 'X', cost: 100 }],
          error: 'something weird happened',
        },
      ],
    });
    expect(failure).toBeUndefined();
  });

  it('returns undefined when the payload has no subscriptions field', () => {
    expect(inspectPayloadForFailure('amgmcp_cost_analysis', {})).toBeUndefined();
    expect(inspectPayloadForFailure('amgmcp_cost_analysis', null)).toBeUndefined();
    expect(inspectPayloadForFailure('amgmcp_cost_analysis', 'just a string')).toBeUndefined();
    expect(inspectPayloadForFailure('amgmcp_cost_analysis', { subscriptions: 'not-an-array' })).toBeUndefined();
  });

  it('returns undefined when the error field is empty or missing', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        { subscriptionId: 'a', totalCost: 0, byService: [] },
        { subscriptionId: 'b', totalCost: 0, byService: [], error: '' },
      ],
    });
    expect(failure).toBeUndefined();
  });

  it('prioritises rate_limit over auth/authz/schema_mismatch when both are present', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-a',
          totalCost: 0,
          byService: [],
          error: 'Unauthorized for subscription',
        },
        {
          subscriptionId: 'sub-b',
          totalCost: 0,
          byService: [],
          error: 'Cost Management rate limit (429) hit',
        },
      ],
    });
    expect(failure?.category).toBe('rate_limit');
  });

  it('carries the offending subscriptionId in the cause for forensics', () => {
    const failure = inspectPayloadForFailure('amgmcp_cost_analysis', {
      subscriptions: [
        {
          subscriptionId: 'sub-rate-limited',
          totalCost: 0,
          byService: [],
          error: 'rate limit hit (429)',
        },
      ],
    });
    expect((failure?.cause as { subscriptionId?: string } | undefined)?.subscriptionId).toBe(
      'sub-rate-limited',
    );
  });
});

describe('inspectToolCallResultForFailure — decodes MCP envelope', () => {
  it('decodes the live wire shape (content: [{type:"text", text:"<json>"}])', async () => {
    const payload = await loadEmbedded429Fixture();
    const result: ToolCallResult = {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
    const failure = inspectToolCallResultForFailure('amgmcp_cost_analysis', result);
    expect(failure?.category).toBe('rate_limit');
  });

  it('handles the fixture shape (content as a decoded object)', async () => {
    const payload = await loadEmbedded429Fixture();
    const result: ToolCallResult = {
      content: payload,
      isError: false,
    };
    const failure = inspectToolCallResultForFailure('amgmcp_cost_analysis', result);
    expect(failure?.category).toBe('rate_limit');
  });

  it('returns undefined for unknown capabilities without decoding the payload', () => {
    const result: ToolCallResult = {
      content: [{ type: 'text', text: 'this would otherwise match a rate-limit pattern' }],
    };
    expect(inspectToolCallResultForFailure('amgmcp_query_resource_graph', result)).toBeUndefined();
  });
});
