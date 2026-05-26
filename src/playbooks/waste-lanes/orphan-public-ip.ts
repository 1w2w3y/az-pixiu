import type { EvidenceRequest, ToolCallResult } from '../../schemas/index.js';
import type { WasteCandidate, WasteLane, WasteLaneRunContext } from './types.js';

/**
 * Orphan public-IP waste lane (Phase 3 — design/cost-summary-depth.md
 * §Gap 1, first lane row).
 *
 * Classification predicate: a `microsoft.network/publicipaddresses`
 * resource whose `properties.ipConfiguration` is null is, by Azure's
 * own data model, not attached to anything — the IP accrues charges
 * with no associated workload. The lane carries the predicate text on
 * every candidate so the report can defend the classification with the
 * same KQL the agent actually ran, rather than free-form narrative.
 *
 * Scope of `microsoft.network/publicipaddresses` only — the design
 * table names only public IP addresses. `microsoft.network/publicipprefixes`
 * is a related but distinct resource (a contiguous IP block, billed
 * differently); broadening the lane to cover prefixes would silently
 * change what "orphan" means and is left as an explicit follow-up
 * decision for the operator.
 */

// Predicate text cited verbatim by the lane's evidence and the report.
// Kept as a chained `| where` form so it appears as a substring of the
// executed ARG query (the lane's buildRequest composes the query with
// the same chained-where shape) — that lets a reviewer match the cite
// against the wire payload character-for-character without re-derivation.
const PREDICATE = "where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration)";

/**
 * Form the SKU key the rate card is queried with. The ARG projection
 * names `skuName` (e.g. 'Standard', 'Basic') and `allocationMethod`
 * ('Static', 'Dynamic'); the SKU key joins them under a stable schema
 * so the rate card can be expanded without rewriting the lane. A row
 * missing either field collapses to the literal "unknown" — the rate
 * lookup will miss and the report renders "rate unavailable".
 */
export function formatPublicIpSku(skuName: string, allocationMethod: string): string {
  const safe = (s: string): string => (s && s.length > 0 ? s : 'Unknown');
  return `PublicIPAddress_${safe(skuName)}_${safe(allocationMethod)}`;
}

export const orphanPublicIpLane: WasteLane = {
  name: 'orphan_public_ip',
  title: 'Orphan public IPs',
  predicate_text: PREDICATE,

  buildRequest(ctx: WasteLaneRunContext): EvidenceRequest {
    // The ARG query body is the predicate text the report cites,
    // followed by a `project` of the fields needed to defend the
    // classification and to derive the SKU for impact estimation.
    // Subscription scoping rides through the `subscription_ids`
    // parameter on the capability — the resource-graph capability
    // already accepts it (the cost-summary playbook uses the same
    // shape).
    const query =
      "Resources " +
      "| where type =~ 'microsoft.network/publicipaddresses' " +
      "| where isnull(properties.ipConfiguration) " +
      "| project id, name, subscriptionId, resourceGroup, location, " +
      "skuName=tostring(sku.name), allocationMethod=tostring(properties.publicIPAllocationMethod)";
    return {
      capability: 'amgmcp_query_resource_graph',
      parameters: {
        subscription_ids: ctx.scope.subscription_ids,
        query,
      },
      intent: 'waste_candidate',
      expected_role: 'orphan public IP candidates (publicipaddresses with null ipConfiguration)',
    };
  },

  parseRows(result: ToolCallResult): { candidates: WasteCandidate[]; unparsed_row_count: number } {
    const candidates: WasteCandidate[] = [];
    let unparsed = 0;
    const content = result.content;
    const rows = extractRows(content);
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) {
        unparsed += 1;
        continue;
      }
      const r = row as Record<string, unknown>;
      const id = asString(r.id);
      const name = asString(r.name);
      const subscriptionId = asString(r.subscriptionId ?? r.subscription_id);
      const resourceGroup = asString(r.resourceGroup ?? r.resource_group);
      const location = asString(r.location);
      const skuName = asString(r.skuName ?? r.sku_name);
      const allocationMethod = asString(r.allocationMethod ?? r.allocation_method);
      if (!id || !subscriptionId) {
        // resource_id + subscription_id are load-bearing — without them
        // the EvidenceRecord cannot honestly scope the candidate.
        unparsed += 1;
        continue;
      }
      candidates.push({
        resource_id: id,
        name: name || lastSegment(id),
        subscription_id: subscriptionId,
        resource_group: resourceGroup || '(unknown)',
        location: location || '(unknown)',
        sku: formatPublicIpSku(skuName, allocationMethod),
        fields: {
          skuName: skuName || '(unknown)',
          allocationMethod: allocationMethod || '(unknown)',
        },
      });
    }
    return { candidates, unparsed_row_count: unparsed };
  },
};

/**
 * The ARG response shape used elsewhere in the codebase (see
 * `EvidenceNormalizer.summarize` for `amgmcp_query_resource_graph`)
 * surfaces rows under a top-level `data` array. Tolerant of both that
 * shape and a bare-array shape so the lane works against both fixture
 * conventions and real AMG-MCP output.
 */
function extractRows(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.rows)) return obj.rows;
  }
  return [];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
