import { describe, it, expect } from 'vitest';
import { renderHtmlReport } from '../../src/report/html.js';
import { renderMarkdownReport } from '../../src/report/markdown.js';
import type {
  ReasoningOutput,
  Scope,
  EvidenceRecord,
  DataQualityFinding,
} from '../../src/schemas/index.js';
import {
  subId,
  scope,
  evidence,
  reasoning,
  metadata,
} from './fixtures.js';
import type { WasteLaneResult } from '../../src/playbooks/waste-lanes/types.js';
import { rollUpLaneTotal } from '../../src/pricing/impact.js';

describe('renderHtmlReport', () => {
  it('produces a well-formed, self-contained HTML5 document', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // Exactly one <html lang="en">, one <style>, one <script> — proves
    // the document is single-file and not concatenated from multiple
    // partials.
    expect(occurrences(html, '<html lang="en">')).toBe(1);
    expect(occurrences(html, '<style>')).toBe(1);
    expect(occurrences(html, '</style>')).toBe(1);
    expect(occurrences(html, '<script>')).toBe(1);
    expect(occurrences(html, '</script>')).toBe(1);
    expect(html).toContain('<title>Az-Pixiu Cost-Surprise Report</title>');
    // Restrictive CSP — no remote network access from the rendered file.
    expect(html).toContain(`default-src 'none'`);
  });

  it('uses the analysis-type display name in the title for cost_summary', () => {
    const summaryScope: Scope = {
      ...scope,
      analysis_type: 'cost_summary',
      effective_scope_summary: '1 sub, 7-day cost summary',
    };
    const html = renderHtmlReport({ scope: summaryScope, reasoning, evidence, metadata });
    expect(html).toContain('<title>Az-Pixiu Cost Summary Report</title>');
  });

  it('renders an incomplete zero-candidate waste lane without claiming no matches', () => {
    const lane: WasteLaneResult = {
      lane: 'orphan_public_ip',
      title: 'Unassociated public IP review candidates',
      predicate_text:
        "where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration) | where isnull(properties.natGateway)",
      source_capability: 'az_pixiu_waste_lane',
      candidates: [],
      lane_total: rollUpLaneTotal([]),
      rate_source_captured_at: '2026-05-23',
      unparsed_row_count: 1,
      rejected_row_count: 1,
      failed: false,
    };
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata, wasteLanes: [lane] });

    expect(html).toContain('Enumeration incomplete');
    expect(html).toContain('cannot make an authoritative &quot;No matching resources&quot; claim');
    expect(html).not.toContain('No matching resources in scope.');
    expect(html).toContain('rejected because subscription scope or the ARM resource ID was inconsistent');
  });

  it('emits one <article class="rec rec--high"> per HIGH-priority recommendation with the id matching recommendation_id', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain('<article class="rec rec--high" id="rec-1"');
    expect(occurrences(html, '<article class="rec rec--high"')).toBe(1);
  });

  it('renders cited hypotheses and facts as anchor links to their cards', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain('<a class="citation" href="#hyp-1">Hypothesis hyp-1</a>');
    expect(html).toContain('<a class="citation" href="#fact-1">Fact fact-1</a>');
    // Hypothesis and Fact cards exist with matching anchor ids so the
    // links land somewhere when clicked.
    expect(html).toContain('id="hyp-1"');
    expect(html).toContain('id="fact-1"');
  });

  it('renders fact backlinks pointing at the citing recommendation / hypothesis', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    // The fact-1 card backlinks to both rec-1 (cites the fact directly)
    // and hyp-1 (supported_by_fact_ids: ['fact-1']).
    expect(html).toMatch(
      /<div class="backlinks">Referenced by:[\s\S]*?Recommendation rec-1[\s\S]*?<\/div>/,
    );
    expect(html).toMatch(
      /<div class="backlinks">Referenced by:[\s\S]*?Hypothesis hyp-1[\s\S]*?<\/div>/,
    );
  });

  it('includes trace_id and run_id verbatim in the Run Metadata section', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain(metadata.run_id);
    expect(html).toContain(metadata.trace_id);
  });

  it('escapes every interpolated value (XSS safety) — script payload in statement, & and " in resource names', () => {
    const xssReasoning: ReasoningOutput = {
      ...reasoning,
      recommendations: [
        {
          ...reasoning.recommendations[0]!,
          recommendation_id: 'rec-xss',
          statement: '<script>alert(1)</script> & "danger" </article>',
          recommendation_signature: 'xss-payload',
        },
      ],
    };
    const html = renderHtmlReport({
      scope,
      reasoning: xssReasoning,
      evidence,
      metadata,
    });
    // Raw script payload must NOT survive into the output as executable HTML.
    expect(html).not.toContain('<script>alert(1)</script>');
    // The escaped form must be present.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;&#x2F;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    // And the closing </article> wasn't smuggled into the body.
    expect(html).not.toContain('"danger" </article>');
  });

  it('marks retrieval-stage findings whose category was not echoed by the reasoner as dropped', () => {
    const droppedFinding: DataQualityFinding = {
      dq_id: 'dq-tagging-1',
      category: 'tagging_gap',
      affected_capability: 'amgmcp_query_resource_graph',
      affected_scope_subset: null,
      consequence_for_analysis: 'half the inventoried resources lack tags',
      impact_on_recommendations: [],
      actionable_hint: 'apply a tagging policy',
    };
    const html = renderHtmlReport({
      scope,
      reasoning, // data_quality has only missing_telemetry; tagging_gap is dropped
      evidence,
      metadata,
      inputDataQuality: [droppedFinding],
    });
    expect(html).toMatch(/<article class="dq dropped"[\s\S]*?dq-tagging-1/);
    expect(html).toContain('dropped by reasoner');
  });

  it('groups dq-synth-* schema_mismatch findings in a collapsed <details> cleanup block', () => {
    const synthFinding: DataQualityFinding = {
      dq_id: 'dq-synth-1',
      category: 'schema_mismatch',
      affected_capability: null,
      affected_scope_subset: null,
      consequence_for_analysis: 'reasoner dropped one hypothesis during post-process cleanup',
      impact_on_recommendations: [],
      actionable_hint: null,
    };
    const analyticalFinding: DataQualityFinding = {
      dq_id: 'dq-tag-1',
      category: 'tagging_gap',
      affected_capability: 'amgmcp_query_resource_graph',
      affected_scope_subset: null,
      consequence_for_analysis: 'tag coverage is incomplete',
      impact_on_recommendations: [],
      actionable_hint: null,
    };
    const html = renderHtmlReport({
      scope,
      reasoning,
      evidence,
      metadata,
      inputDataQuality: [analyticalFinding, synthFinding],
    });
    expect(html).toContain('Post-process cleanup');
    expect(html).toMatch(/<details class="cleanup-group">[\s\S]*?dq-synth-1/);
  });

  it('parity smoke test against markdown — same recommendation count, total cost figure, run_id', () => {
    const summaryScope: Scope = {
      subscription_ids: [subId],
      time_window: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
      analysis_type: 'cost_summary',
      effective_scope_summary: '1 subscription, 7-day cost summary',
    };
    const summaryEvidence: EvidenceRecord[] = [
      {
        evidence_id: 'ev-amgmcp_cost_analysis-aaaaaaaa',
        source_capability: 'amgmcp_cost_analysis',
        capability_version: '1.0.0',
        query_intent: 'cost_breakdown',
        scope_subset: { subscription_ids: [subId] },
        time_window: summaryScope.time_window,
        payload_ref: {
          kind: 'inline',
          data: {
            rows: [
              ['2026-05-01', 'App Service', 38.21, 'USD'],
              ['2026-05-01', 'Storage', 11.42, 'USD'],
              ['2026-05-04', 'App Service', 41.55, 'USD'],
              ['2026-05-04', 'Storage', 12.05, 'USD'],
              ['2026-05-07', 'App Service', 42.78, 'USD'],
              ['2026-05-07', 'Storage', 12.71, 'USD'],
            ],
            total: { cost: 158.72, currency: 'USD' },
          },
        },
        payload_summary: { total_cost: 158.72, currency: 'USD' },
        caveats: [],
      },
    ];
    const md = renderMarkdownReport({
      scope: summaryScope,
      reasoning,
      evidence: summaryEvidence,
      metadata,
    });
    const html = renderHtmlReport({
      scope: summaryScope,
      reasoning,
      evidence: summaryEvidence,
      metadata,
    });
    // Recommendation count
    expect(md).toContain('### Recommendation rec-1');
    expect(html).toContain('id="rec-1"');
    // Total-cost figure
    expect(md).toContain('158.72 USD');
    expect(html).toContain('158.72 USD');
    // run_id
    expect(html).toContain(metadata.run_id);
    expect(md).toContain(metadata.run_id);
    // The HTML inherits the cost-summary expansion for service names.
    expect(html).toContain('App Service');
  });

  it('renders the recommendation filter input on the Recommendations section', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain('id="rec-filter"');
    expect(html).toContain('id="rec-match-count"');
  });

  it('renders the table of contents with one entry per rendered section', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain('<aside class="toc"');
    expect(html).toContain('href="#scope"');
    expect(html).toContain('href="#executive"');
    expect(html).toContain('href="#recommendations"');
    expect(html).toContain('href="#hypotheses"');
    expect(html).toContain('href="#facts"');
    expect(html).toContain('href="#metadata"');
  });

  it('renders a sortable confidence-dimensions strip on each recommendation card', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    expect(html).toContain('class="dims"');
    expect(html).toContain('class="dim dim--strong"');
  });

  it('snapshot — a single rendered recommendation card', () => {
    const html = renderHtmlReport({ scope, reasoning, evidence, metadata });
    const start = html.indexOf('<article class="rec rec--high"');
    const end = html.indexOf('</article>', start) + '</article>'.length;
    const card = html.slice(start, end);
    expect(card).toMatchInlineSnapshot(`
      "<article class="rec rec--high" id="rec-1" data-search="rec-1 pg-deployment-investigation investigate the recent PostgreSQL deployment high high">
      <div class="card-head">
      <span class="badge badge--prio-high">high</span>
      <span class="badge badge--conf-high">high</span>
      <span class="badge badge--impact">impact: material</span>
      <span class="title">Recommendation <code>rec-1</code></span>
      <button type="button" class="copy-btn" data-copy="rec-1" aria-label="Copy recommendation id">copy</button>
      <span class="sig">signature: pg-deployment-investigation</span>
      </div>
      <p class="statement">investigate the recent PostgreSQL deployment</p>
      <p><strong>Confidence:</strong> high — aligned</p>
      <div class="dims"><div class="dim dim--strong"><div class="dim-label">evidence coverage</div><div class="dim-value">strong</div></div><div class="dim dim--strong"><div class="dim-label">signal quality</div><div class="dim-value">strong</div></div><div class="dim dim--strong"><div class="dim-label">signal agreement</div><div class="dim-value">aligned</div></div></div>
      <p><strong>Audience:</strong> platform engineer</p>
      <div class="subsec"><h4>Suggested human actions</h4><ul><li>review the deployment timeline</li><li>examine workload telemetry</li></ul></div>
      <div class="subsec"><h4>Validation steps</h4><ul><li>compare utilization week-over-week</li></ul></div>
      <div class="subsec"><h4>Assumptions</h4><ul><li>baseline is representative</li></ul></div>
      <div class="subsec"><h4>False-positive considerations</h4><ul><li>legitimate workload growth</li></ul></div>
      <div class="subsec"><h4>Cited hypotheses</h4><ul><li><a class="citation" href="#hyp-1">Hypothesis hyp-1</a>: a deployment caused the rise</li></ul></div>
      <div class="subsec"><h4>Cited facts</h4><ul><li><a class="citation" href="#fact-1">Fact fact-1</a>: cost on PostgreSQL rose 38% over baseline</li></ul></div>
      </article>"
    `);
  });
});

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}
