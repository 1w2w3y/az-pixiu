import type { EvidenceRequest, ToolCallResult } from '../../schemas/index.js';
import { extractText, tryParseJson } from '../../mcp/content.js';
import { scopeResourceGraphQuery } from '../../mcp/resource-graph.js';
import type { WasteCandidate, WasteLane, WasteLaneRunContext } from './types.js';

/**
 * Orphan public-IP waste lane (Phase 3 — design/cost-summary-depth.md
 * §Gap 1, first lane row).
 *
 * Classification predicate: a `microsoft.network/publicipaddresses`
 * resource whose `properties.ipConfiguration` and `properties.natGateway`
 * are both null is not currently associated through either supported
 * attachment shape. This makes it a human-review candidate, not proof of
 * waste: deployment pools and reserved capacity can be intentionally idle.
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
const PREDICATE =
  "where type =~ 'microsoft.network/publicipaddresses' | where isnull(properties.ipConfiguration) | where isnull(properties.natGateway)";

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
  resource_types: ['microsoft.network/publicipaddresses'],
  title: 'Unassociated public IP review candidates',
  predicate_text: PREDICATE,

  buildRequest(ctx: WasteLaneRunContext): EvidenceRequest {
    // The ARG query body is the predicate text the report cites,
    // followed by a `project` of the fields needed to defend the
    // classification and to derive the SKU for impact estimation.
    // Live AMG-MCP exposes no subscription_ids argument for ARG. Scope
    // therefore lives in supported KQL and subscriptionId is projected
    // so the executor can validate every returned row before admitting it.
    const query = scopeResourceGraphQuery(
      "Resources " +
      `| ${PREDICATE} ` +
      "| project id, name, subscriptionId, resourceGroup, location, " +
      "skuName=tostring(sku.name), allocationMethod=tostring(properties.publicIPAllocationMethod), " +
      "ipConfigurationId=tostring(properties.ipConfiguration.id), natGatewayId=tostring(properties.natGateway.id)",
      ctx.scope.subscription_ids,
      {
        resourceGroupNames: ctx.scope.resource_group_names,
        resourceTypes: ctx.scope.resource_type_filter,
      },
    );
    return {
      capability: 'amgmcp_query_resource_graph',
      parameters: {
        query,
      },
      intent: 'waste_candidate',
      expected_role:
        'unassociated public IP review candidates (no IP configuration or NAT Gateway association)',
    };
  },

  parseRows(result: ToolCallResult): { candidates: WasteCandidate[]; unparsed_row_count: number } {
    const candidates: WasteCandidate[] = [];
    const text = extractText(result);
    const parsed = tryParseJson(text);
    const decoded = parsed ?? (text.length > 0 ? text : result.content);
    const extracted = extractRows(decoded);
    let unparsed = extracted.contract_issue_count;
    const rows = extracted.rows;
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
      const ipConfigurationProjection = Object.hasOwn(r, 'ipConfigurationId')
        ? r.ipConfigurationId
        : r.ip_configuration_id;
      const natGatewayProjection = Object.hasOwn(r, 'natGatewayId')
        ? r.natGatewayId
        : r.nat_gateway_id;
      const hasIpConfigurationProjection = typeof ipConfigurationProjection === 'string';
      const hasNatGatewayProjection = typeof natGatewayProjection === 'string';
      const ipConfigurationId = asString(ipConfigurationProjection);
      const natGatewayId = asString(natGatewayProjection);
      if (
        !id ||
        !subscriptionId ||
        !hasIpConfigurationProjection ||
        !hasNatGatewayProjection
      ) {
        // resource_id + subscription_id are load-bearing — without them
        // the EvidenceRecord cannot honestly scope the candidate.
        unparsed += 1;
        continue;
      }
      if (ipConfigurationId || natGatewayId) {
        // A row that contradicts the lane predicate is never admitted as
        // evidence even if an upstream ARG implementation returned it.
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
          ipConfigurationId: '(none)',
          natGatewayId: '(none)',
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
function extractRows(content: unknown): { rows: unknown[]; contract_issue_count: number } {
  // Preserve bare-array rows for diagnostics, but treat the missing count
  // envelope as incomplete. This prevents a bare empty array from becoming
  // an authoritative clean no-match if the upstream contract drifts.
  if (Array.isArray(content)) return { rows: content, contract_issue_count: 1 };
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    const rows = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.rows) ? obj.rows : undefined;
    if (rows) {
      if (typeof obj.count !== 'number' || !Number.isInteger(obj.count) || obj.count < 0) {
        return { rows, contract_issue_count: 1 };
      }
      if (obj.count !== rows.length) {
        return {
          rows,
          contract_issue_count: Math.max(1, Math.abs(obj.count - rows.length)),
        };
      }
      return { rows, contract_issue_count: 0 };
    }
  }
  // Unknown envelope means one contract-level parse failure, never a
  // clean zero-match result.
  return { rows: [], contract_issue_count: 1 };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
