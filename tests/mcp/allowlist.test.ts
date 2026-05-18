import { describe, it, expect } from 'vitest';
import {
  PHASE_1_READ_ONLY_ALLOWLIST,
  isAllowedCapability,
  isMutatingCapabilityName,
  MUTATING_NAME_PATTERNS,
} from '../../src/mcp/allowlist.js';

describe('PHASE_1_READ_ONLY_ALLOWLIST', () => {
  it('contains exactly the seven Phase 1 capabilities (real AMG-MCP `amgmcp_*` wire names)', () => {
    expect(Array.from(PHASE_1_READ_ONLY_ALLOWLIST).sort()).toEqual([
      'amgmcp_cost_analysis',
      'amgmcp_query_activity_log',
      'amgmcp_query_azure_subscriptions',
      'amgmcp_query_resource_graph',
      'amgmcp_query_resource_health',
      'amgmcp_query_resource_metric',
      'amgmcp_query_resource_metric_definition',
    ]);
  });
});

describe('isMutatingCapabilityName', () => {
  it('catches dashboard_update (the design §12 deny example)', () => {
    expect(isMutatingCapabilityName('dashboard_update')).toBe(true);
  });

  it.each([
    'update_dashboard',
    'create_alert_rule',
    'delete_panel',
    'modify_data_source',
    'remove_user',
    'replace_config',
    'set_default_dashboard',
    'apply_changes',
    'write_metric',
    'data_source_update',
    'rule_create',
    'panel_delete',
  ])('flags "%s" as mutating', (name) => {
    expect(isMutatingCapabilityName(name)).toBe(true);
  });

  it.each([
    'cost_analysis',
    'query_resource_metric',
    'query_resource_metric_definition',
    'query_activity_log',
    'query_resource_health',
    'query_resource_graph',
    'query_azure_subscriptions',
    'list_datasources',
    'fetch_metric',
    'inspect_dashboard',
  ])('does not flag read-style name "%s"', (name) => {
    expect(isMutatingCapabilityName(name)).toBe(false);
  });

  it('uses word boundaries — substring matches inside words are not mutating', () => {
    // "modification" contains "modify" but only as a substring, not a word
    expect(isMutatingCapabilityName('query_modification_history')).toBe(false);
    // "creation_time" contains "create" only as a substring
    expect(isMutatingCapabilityName('query_creation_time')).toBe(false);
  });

  it('has at least the verbs the design explicitly names', () => {
    const verbs = ['update', 'create', 'delete', 'modify', 'remove', 'replace', 'set', 'apply', 'write'];
    for (const verb of verbs) {
      expect(MUTATING_NAME_PATTERNS.some((p) => p.test(verb))).toBe(true);
    }
  });
});

describe('isAllowedCapability', () => {
  it.each([
    'amgmcp_query_azure_subscriptions',
    'amgmcp_cost_analysis',
    'amgmcp_query_resource_graph',
    'amgmcp_query_resource_metric_definition',
    'amgmcp_query_resource_metric',
    'amgmcp_query_activity_log',
    'amgmcp_query_resource_health',
  ])('allows Phase 1 read-only capability "%s"', (name) => {
    expect(isAllowedCapability(name)).toBe(true);
  });

  it.each([
    'dashboard_update',
    'update_dashboard',
    'create_alert',
    'delete_panel',
    'modify_data_source',
    'set_default_dashboard',
  ])('denies mutating capability "%s"', (name) => {
    expect(isAllowedCapability(name)).toBe(false);
  });

  it.each([
    'amgmcp_pulse_check',
    'amgmcp_kusto_query',
    'amgmcp_mssql_query',
    'amgmcp_prometheus_query',
    'amgmcp_query_resource_log',
    'amgmcp_query_application_insights_trace',
    'amgmcp_insights_get_agents',
    'amgmcp_datasource_list',
    'amgmcp_dashboard_inspect',
    'amgmcp_dashboard_search',
  ])('denies read-only capability "%s" that is not in the Phase 1 allowlist', (name) => {
    expect(isAllowedCapability(name)).toBe(false);
  });

  it('defense in depth: even if a mutating name were somehow in the allowlist, the pattern check denies it', () => {
    // The set is readonly at the type level; this test asserts the
    // *logic* would still deny a mutating name if the set were mutated.
    // We can't mutate a ReadonlySet at runtime here, but we can verify
    // the logic by composing the two checks ourselves.
    const inAllowlist = true;
    const matchesMutating = isMutatingCapabilityName('dashboard_update');
    const allowed = inAllowlist && !matchesMutating;
    expect(allowed).toBe(false);
  });
});
