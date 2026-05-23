import { describe, it, expect } from 'vitest';
import { Planner, PlannerValidationError } from '../../src/reasoning/planner.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import { MCPClient } from '../../src/mcp/client.js';
import type { CapabilityCatalog, EvidencePlan, Scope, ToolCallResult } from '../../src/schemas/index.js';
import type { MCPTransport } from '../../src/mcp/transport.js';

/**
 * The planner's LLM wire format encodes `parameters` as a JSON string
 * (OpenAI strict-mode rejects open `additionalProperties`). The Planner
 * JSON-parses on the way out. Tests build canned responses in the
 * convenient EvidencePlan object form and then encode parameters before
 * handing them to MockModelClient.
 */
type LLMRequest = {
  capability: string;
  parameters: string;
  intent: string;
  expected_role?: string;
};
type LLMPlan = { requests: LLMRequest[] };

function encodePlan(plan: EvidencePlan): LLMPlan {
  return {
    requests: plan.requests.map((r) => ({
      capability: r.capability,
      parameters: JSON.stringify(r.parameters),
      intent: r.intent,
      ...(r.expected_role !== undefined && r.expected_role !== null
        ? { expected_role: r.expected_role }
        : {}),
    })),
  };
}

const subId = '11111111-1111-1111-1111-111111111111';

const scope: Scope = {
  subscription_ids: [subId],
  time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
  baseline_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
  analysis_type: 'cost_surprise',
  effective_scope_summary: 'one sub, 7d vs 7d',
  user_context: 'this should not be visible to the planner',
};

const catalog: CapabilityCatalog = {
  capabilities: [
    { name: 'amgmcp_cost_analysis', version: '1.0.0' },
    { name: 'amgmcp_query_resource_graph', version: '1.0.0' },
    { name: 'amgmcp_query_activity_log', version: '1.0.0' },
  ],
};

class FakeTransport implements MCPTransport {
  async listCapabilities() {
    return catalog;
  }
  async invoke(): Promise<ToolCallResult> {
    return { content: {} };
  }
  async close() {}
}

const validPlan: EvidencePlan = {
  requests: [
    {
      capability: 'amgmcp_cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      },
      intent: 'cost_breakdown',
    },
    {
      capability: 'amgmcp_cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: { start: '2026-04-24T00:00:00Z', end: '2026-05-01T00:00:00Z' },
      },
      intent: 'cost_breakdown',
    },
  ],
};

async function getCatalog() {
  const client = new MCPClient({ transport: new FakeTransport() });
  return client.discover();
}

describe('Planner — happy path', () => {
  it('returns the plan when valid against the catalog', async () => {
    const planner = new Planner({
      model: new MockModelClient({ responses: encodePlan(validPlan) }),
      systemPrompt: 'planner',
    });
    const plan = await planner.plan(scope, await getCatalog());
    expect(plan.requests).toHaveLength(2);
  });

  it('does not include user_context in the user prompt (§7.3 boundary)', async () => {
    const mock = new MockModelClient({ responses: encodePlan(validPlan) });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await planner.plan(scope, await getCatalog());
    expect(mock.calls[0]?.userPrompt).not.toContain('user_context');
    expect(mock.calls[0]?.userPrompt).not.toContain('not be visible to the planner');
  });
});

describe('Planner — parameter canonicalization', () => {
  it('rewrites camelCase scope-related keys to snake_case before emitting the plan', async () => {
    // The planner LLM follows the capability inputSchema's camelCase
    // convention; the rest of the agent uses snake_case. Canonicalising
    // at the planner boundary means executor / normalizer / coverage
    // helpers don't have to recognise both.
    const camelPlan = {
      requests: [
        {
          capability: 'amgmcp_cost_analysis',
          parameters: JSON.stringify({
            subscriptionId: subId,
            timeWindow: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
            resourceGroupNames: ['rg-a', 'rg-b'],
          }),
          intent: 'cost_breakdown',
        },
        {
          capability: 'amgmcp_query_resource_graph',
          parameters: JSON.stringify({
            subscriptionIds: [subId],
            resourceIds: ['/subscriptions/x/resourceGroups/y/providers/z/foo'],
            query: 'Resources | take 1',
          }),
          intent: 'inventory',
        },
      ],
    };
    const planner = new Planner({
      model: new MockModelClient({ responses: camelPlan }),
      systemPrompt: 'planner',
    });
    const plan = await planner.plan(scope, await getCatalog());
    const p0 = plan.requests[0]!.parameters;
    expect(p0).toHaveProperty('subscription_id', subId);
    expect(p0).toHaveProperty('time_window');
    expect(p0).toHaveProperty('resource_group_names');
    expect(p0).not.toHaveProperty('subscriptionId');
    expect(p0).not.toHaveProperty('timeWindow');
    expect(p0).not.toHaveProperty('resourceGroupNames');
    const p1 = plan.requests[1]!.parameters;
    expect(p1).toHaveProperty('subscription_ids', [subId]);
    expect(p1).toHaveProperty('resource_ids');
    // Capability-specific keys (e.g. `query`) pass through untouched.
    expect(p1).toHaveProperty('query', 'Resources | take 1');
  });
});

describe('Planner — validation', () => {
  it('rejects a plan that names an unadvertised capability and attempts one repair', async () => {
    const badPlan: EvidencePlan = {
      requests: [
        { capability: 'kusto_query', parameters: {}, intent: 'cost_breakdown' },
      ],
    };
    const mock = new MockModelClient({ responses: [encodePlan(badPlan), encodePlan(validPlan)] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    const plan = await planner.plan(scope, await getCatalog());
    expect(plan.requests).toHaveLength(2);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.userPrompt).toContain('prior_attempt_validation_errors');
  });

  it('throws PlannerValidationError after one failed repair pass', async () => {
    const badPlan: EvidencePlan = {
      requests: [
        { capability: 'kusto_query', parameters: {}, intent: 'cost_breakdown' },
      ],
    };
    const mock = new MockModelClient({ responses: [encodePlan(badPlan), encodePlan(badPlan)] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await expect(planner.plan(scope, await getCatalog())).rejects.toBeInstanceOf(
      PlannerValidationError,
    );
  });

  it('rejects a mutating capability even if AMG-MCP advertised it', async () => {
    const wideCatalog: CapabilityCatalog = {
      capabilities: [
        ...catalog.capabilities,
        { name: 'dashboard_update' },
      ],
    };
    class WideTransport implements MCPTransport {
      async listCapabilities() {
        return wideCatalog;
      }
      async invoke(): Promise<ToolCallResult> {
        return { content: {} };
      }
      async close() {}
    }
    const wideClient = new MCPClient({ transport: new WideTransport() });
    const wideDiscovered = await wideClient.discover();

    const mutatingPlan: EvidencePlan = {
      requests: [{ capability: 'dashboard_update', parameters: {}, intent: 'cost_breakdown' }],
    };
    const mock = new MockModelClient({ responses: [encodePlan(mutatingPlan), encodePlan(mutatingPlan)] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await expect(planner.plan(scope, wideDiscovered)).rejects.toBeInstanceOf(
      PlannerValidationError,
    );
  });

  it('rejects duplicate (capability, parameters) requests', async () => {
    const duplicatePlan: EvidencePlan = {
      requests: [
        { capability: 'amgmcp_cost_analysis', parameters: { sub: 'a' }, intent: 'cost_breakdown' },
        { capability: 'amgmcp_cost_analysis', parameters: { sub: 'a' }, intent: 'cost_breakdown' },
      ],
    };
    const mock = new MockModelClient({ responses: [encodePlan(duplicatePlan), encodePlan(duplicatePlan)] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await expect(planner.plan(scope, await getCatalog())).rejects.toBeInstanceOf(
      PlannerValidationError,
    );
  });
});
