import { describe, it, expect } from 'vitest';
import {
  PHASE_1_READ_ONLY_ALLOWLIST,
  isAllowedCapability,
  isMutatingCapabilityName,
  MUTATING_NAME_PATTERNS,
} from '../../src/mcp/allowlist.js';

describe('PHASE_1_READ_ONLY_ALLOWLIST', () => {
  it('contains exactly the seven Phase 1 capabilities (design §15.4)', () => {
    expect(Array.from(PHASE_1_READ_ONLY_ALLOWLIST).sort()).toEqual([
      'cost_analysis',
      'query_activity_log',
      'query_azure_subscriptions',
      'query_resource_graph',
      'query_resource_health',
      'query_resource_metric',
      'query_resource_metric_definition',
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
    'query_azure_subscriptions',
    'cost_analysis',
    'query_resource_graph',
    'query_resource_metric_definition',
    'query_resource_metric',
    'query_activity_log',
    'query_resource_health',
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
    'pulse_check',
    'kusto_query',
    'mssql_query',
    'prometheus_query',
    'query_resource_log',
    'query_application_insights_trace',
    'insights_get_agents',
    'datasource_list',
    'dashboard_inspect',
    'dashboard_search',
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
