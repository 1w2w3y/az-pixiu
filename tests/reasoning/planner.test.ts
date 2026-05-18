import { describe, it, expect } from 'vitest';
import { Planner, PlannerValidationError } from '../../src/reasoning/planner.js';
import { MockModelClient } from '../../src/model/mock-client.js';
import { MCPClient } from '../../src/mcp/client.js';
import type { CapabilityCatalog, EvidencePlan, Scope, ToolCallResult } from '../../src/schemas/index.js';
import type { MCPTransport } from '../../src/mcp/transport.js';

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
    { name: 'cost_analysis', version: '1.0.0' },
    { name: 'query_resource_graph', version: '1.0.0' },
    { name: 'query_activity_log', version: '1.0.0' },
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
      capability: 'cost_analysis',
      parameters: {
        subscription_id: subId,
        time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      },
      intent: 'cost_breakdown',
    },
    {
      capability: 'cost_analysis',
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
      model: new MockModelClient({ responses: validPlan }),
      systemPrompt: 'planner',
    });
    const plan = await planner.plan(scope, await getCatalog());
    expect(plan.requests).toHaveLength(2);
  });

  it('does not include user_context in the user prompt (§7.3 boundary)', async () => {
    const mock = new MockModelClient({ responses: validPlan });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await planner.plan(scope, await getCatalog());
    expect(mock.calls[0]?.userPrompt).not.toContain('user_context');
    expect(mock.calls[0]?.userPrompt).not.toContain('not be visible to the planner');
  });
});

describe('Planner — validation', () => {
  it('rejects a plan that names an unadvertised capability and attempts one repair', async () => {
    const badPlan: EvidencePlan = {
      requests: [
        { capability: 'kusto_query', parameters: {}, intent: 'cost_breakdown' },
      ],
    };
    const mock = new MockModelClient({ responses: [badPlan, validPlan] });
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
    const mock = new MockModelClient({ responses: [badPlan, badPlan] });
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
    const mock = new MockModelClient({ responses: [mutatingPlan, mutatingPlan] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await expect(planner.plan(scope, wideDiscovered)).rejects.toBeInstanceOf(
      PlannerValidationError,
    );
  });

  it('rejects duplicate (capability, parameters) requests', async () => {
    const duplicatePlan: EvidencePlan = {
      requests: [
        { capability: 'cost_analysis', parameters: { sub: 'a' }, intent: 'cost_breakdown' },
        { capability: 'cost_analysis', parameters: { sub: 'a' }, intent: 'cost_breakdown' },
      ],
    };
    const mock = new MockModelClient({ responses: [duplicatePlan, duplicatePlan] });
    const planner = new Planner({ model: mock, systemPrompt: 'planner' });
    await expect(planner.plan(scope, await getCatalog())).rejects.toBeInstanceOf(
      PlannerValidationError,
    );
  });
});
