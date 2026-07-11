# AMG-MCP capabilities

This document records what the Azure Managed Grafana MCP server exposes to Az-Pixiu today. It is a reference, not a position document; it describes the surface the agent can rely on rather than arguing for any particular use of it. The reasoning behind treating AMG-MCP as the Azure boundary lives in [AMG-MCP positioning](amg-mcp-positioning.md). The requirements that govern how the agent uses the boundary live in the [AMG-MCP integration PRD](prd/amg-mcp-integration.md).

Capability sets change. Treat this document as a snapshot, not a contract. When the underlying tools evolve, this document should be revised rather than worked around.

## How the surface is organized

The capabilities fall into a small number of categories that map naturally onto FinOps work. Each is described in its own section below.

- Cost — billed spend, broken down by service, region, and resource type.
- Inventory — Azure resource graph queries, accessible subscriptions, and Grafana data source discovery.
- Metrics — Azure Monitor metrics for individual or batched resources, with metric definition discovery.
- Logs and traces — resource logs, Application Insights traces, and aggregate failure insights.
- Activity and health — management-plane events and resource availability transitions.
- Data sources — passthrough query into Kusto/ADX, MSSQL, Prometheus, and a generic datasource layer.
- Dashboards — Grafana dashboard search, inspection, and update.
- Built-in checks — a multi-scenario operational health scanner that lives inside the MCP server.

## Wire results and effective scope

Every capability returns an MCP `ToolCallResult`, not its domain payload directly. A common successful wire shape is a `content` array containing one or more text blocks whose `text` field is JSON. Consumers must decode that envelope through the shared content decoder before interpreting arrays, counts, errors, or zero values. Tests that pass an already-decoded object are useful parser unit tests, but they do not replace at least one contract fixture with the real text-block shape.

Tool schemas are also capability-specific. A client must not add an intuitive scope parameter and assume the server honored it. In the current live surface, `amgmcp_cost_analysis` accepts `subscriptionId/startTime/endTime`, `amgmcp_query_activity_log` accepts ARM `scope/startTime/endTime`, and `query_resource_graph` carries subscription restriction in KQL because its schema exposes no separate subscription-list parameter. ARG queries should project `subscriptionId`, and consumers validate every returned row against the intended scope. Reports disclose intended, visible, cost-covered, and effectively queried scope separately whenever they differ. Shared parameter builders and fixture digests use these exact wire names so offline green runs cannot remain self-consistent with a schema the live server rejects.

A transport response therefore proves only that the tool returned. `ToolCallResult.isError` is checked before any domain parser, and an unflagged result still does not prove that the payload was completely decoded, that every row was parseable, that the effective scope matched the request, or that a zero means "none." Those properties are evidence-admission checks in Az-Pixiu. Decode failures, scope mismatches, and unparsed rows become Run Quality findings and prevent an authoritative no-match or complete-coverage claim.

## Cost

`cost_analysis` returns spend broken down by service category, region, and resource type for a time window, scoped either to all accessible subscriptions or to a single subscription. It uses the Azure Cost Management API under the configured Azure Monitor data source.

The single-subscription path is significantly more resilient to throttling than the fan-out path. Cost Management enforces a per-tenant QPU (query units) budget; a wide fan-out across many subscriptions can return 429s for every subscription rather than for some of them, even when each individual call would succeed. The agent should expect to serialize cost queries across subscriptions when the budget is uncertain.

Historical full-month cost data is a strong candidate for local caching because it is expensive to re-read and changes slowly after the billing posting window closes. The partially shipped [local billing cache](design/local-billing-cache.md) keeps this within the AMG-MCP boundary: cache files are populated from `cost_analysis` responses, stored only on the operator's disk, and used only for usage-stable full months whose billing period has passed a conservative stabilization day.

Cost Management can return a structurally successful all-zero window even when adjacent evidence makes that zero questionable, a successful envelope with no numeric aggregate, or a structured subscription set different from the one requested. Zero remains a valid value for a genuinely empty scope, so the agent does not replace it with a prior period or declare it false. It classifies the payload against returned scope, finite numeric dimensions, embedded errors, totals, and available comparable windows. `cost_zero_suspected`, `zero_unresolved`, and `cost_scope_mismatch` payloads are quarantined as partial evidence, excluded from reasoning, coverage, trend, and savings arithmetic, and never written to the local billing cache. The detailed state machine lives in [local billing cache](design/local-billing-cache.md) §"Cache admission gate".

## Inventory

`query_resource_graph` accepts an Azure Resource Graph (KQL) query and returns the resources that match. This is the primary way for the agent to enumerate resources by type, location, configuration, tags, or any other property that ARG exposes. When the discovered schema has no separate subscription-list input, subscription scope must be expressed in the KQL itself and projected back into every row for effective-scope validation.

`query_azure_subscriptions` lists the subscriptions reachable through the Grafana Azure Monitor data source. It is the natural starting point for any analysis that needs to know what scopes are visible before doing anything else.

`datasource_list` lists the Grafana data sources configured on the AMG instance, optionally filtered by type. It is what allows the agent to discover ADX clusters, Prometheus instances, MSSQL servers, and additional Azure Monitor data sources without being told about them in advance.

## Metrics

`query_resource_metric_definition` returns the metrics available for a specific Azure resource ID. The agent uses this to discover what is measurable for a resource before asking for values.

`query_resource_metric` returns values for one or more metrics across one or more resources. It accepts up to 100 resource IDs and up to 20 metric names in a single call, queries the resources in parallel, and supports time windows, aggregations (Average, Count, Maximum, Minimum, Total), intervals — including a special `FULL` interval for a single datapoint per resource — and optional OData filters.

The batched shape is significant. A subscription-wide fleet analysis — for example, CPU across every PostgreSQL flexible server — can usually be retrieved in one or two calls rather than dozens, which matters for both latency and for Azure Monitor API rate limits.

## Logs and traces

`query_resource_log` runs KQL against the resource's logs surface. For most Azure resources this means Log Analytics with `TimeGenerated`; for Application Insights components it means the trace schema with `timestamp` (lowercase). The tool's description records this distinction explicitly, which is the kind of detail that is easy to get wrong in agent prompts.

`query_application_insights_trace` retrieves a specific trace by operation ID and aggregates across multiple Application Insights components when the trace spans them.

`insights_get_failures` returns failure summary data — failed requests, failed dependencies, exceptions — from Application Insights for a time window. `insights_get_agents` returns equivalent agent-side summaries.

## Activity and health

`query_activity_log` queries the Azure Activity Log for management-plane operations on a subscription, resource group, or single resource. It surfaces creates, deletes, updates, RBAC changes, and deployments, with caller identity and correlation IDs preserved. This is the natural evidence source for "what changed" questions, including the kind that motivate cost surprise investigations.

`query_resource_health` returns the current availability state for a resource (or for every child resource at sub or RG scope). At single-resource scope it can return the historical transitions instead. `query_resource_health_events` returns the underlying availability events. Both can optionally expand recommended actions.

## Data sources

Beyond Azure Monitor, AMG-MCP exposes a small set of tools that talk to other data sources Grafana already connects to:

- `kusto_query` and `kusto_get_metadata` for Azure Data Explorer (ADX).
- `mssql_query` and `mssql_get_metadata` for SQL data sources.
- `prometheus_query`, `prometheus_query_histogram`, `prometheus_list_label_names`, and `prometheus_list_metric_names` for Prometheus.
- `query_datasource` as a generic passthrough.

These widen the agent's reach beyond Azure Monitor without requiring it to learn each backend's authentication and transport. They are also the natural places to look when cost data and Azure Monitor metrics are not the complete picture.

## Dashboards

`dashboard_search` finds Grafana dashboards by query string, returning title, UID, folder, tags, and URL. By default it excludes the AMG-provisioned out-of-the-box content. `dashboard_inspect` returns the details of a specific dashboard.

`dashboard_update` modifies a dashboard. This is the only mutating capability that AMG-MCP currently exposes, and it operates on Grafana state rather than Azure state. The integration PRD's read-only contract is written primarily in terms of Azure mutation; the implication for Az-Pixiu is that Grafana mutation should be treated the same way, and the agent should not call `dashboard_update`.

## Built-in checks

`pulse_check` is the most opinionated tool in the surface. It is an automated multi-scenario health scanner that runs inside the MCP server and returns a prioritized findings summary. The current scenario list covers PostgreSQL flexible servers (CPU, memory, storage, IOPS, bandwidth), Cosmos DB Mongo (RU, throttling, availability), AKS (node CPU, memory, disk, unschedulable pods, API server CPU), Virtual Machines (CPU, memory, data and OS disk IOPS and bandwidth), Azure SQL DB (CPU, memory, workers, sessions, storage, data I/O, log I/O, availability), App Service plans (CPU, memory), Redis (CPU, server load, memory), Logic Apps (failure rate), Storage account summaries, and Key Vault summaries.

The existence of `pulse_check` has direct implications for the core agent. Several of Az-Pixiu's intended scenarios — particularly idle and underused resource review — overlap with what `pulse_check` already does. For Phase 3, the boundary is conservative: `pulse_check` may generate or prioritize candidates, but its severity label and instantaneous peaks are not sufficient recommendation evidence. A selected service evidence pack confirms the hypothesis with raw metric definitions and time series, including aggregation, dimensions, observation window, distribution or p95-equivalent, maxima, and sample coverage. This composition keeps the server's useful screening logic without turning a threshold boundary, brief spike, or cluster-level average into unsupported rightsizing advice. The [AMG-MCP integration PRD](prd/amg-mcp-integration.md) retains the longer-term question of how much screening logic should live upstream.

## How these capabilities support the project's use cases

This mapping is a starting point, not an exhaustive plan. Each scenario in [use cases](use-cases.md) corresponds to a small set of capabilities that the agent is likely to rely on; an agent run should leave a trace that names the specific capabilities it actually exercised.

- Investigating a cost surprise. `cost_analysis` for the affected subscription and window; `query_resource_graph` to inventory the highest-cost resource types; `query_resource_metric` for the relevant utilization signals; `query_activity_log` to identify deployments, RBAC changes, or scaling operations that align with the cost change; `query_resource_health` where availability transitions may explain a shift.
- Finding idle and underused resources. `cost_analysis` to bound the search to material spend; `query_resource_graph` to enumerate candidates; `query_resource_metric` for utilization; `query_resource_metric_definition` to confirm the right metric exists for the resource type. `pulse_check` is a natural companion or starting point for the resource types it already covers.
- Preparing for a quarterly cost review. `cost_analysis` over the relevant comparison windows; `query_resource_graph` for ownership, tagging, and structural context; `query_activity_log` for major lifecycle events in the period.
- Correlating cost with reliability and performance. `query_resource_metric` for the resources whose cost has shifted; `query_resource_log` for deeper telemetry where Log Analytics is configured; `query_resource_health` for availability transitions; `insights_get_failures` and `query_application_insights_trace` where Application Insights is in use.
- Auditing tagging and ownership hygiene. `query_resource_graph` for tag coverage; `cost_analysis` to associate gaps with the spend they represent.

For `cost_summary`, this mapping is planned as a bounded two-pass design rather than an open-ended loop. The first pass establishes visible and cost-covered scope plus service materiality. The second selects only allowlisted service evidence packs with declared call budgets. The planned priority is PostgreSQL rightsizing first, then Log Analytics ingestion attribution, AKS node-pool efficiency, Cosmos DB throughput and test-collection lifecycle, and ACR inactivity or over-replication. Each pack is defined in [cost-summary depth](design/cost-summary-depth.md) and remains constrained to the capabilities above; a missing child-resource surface becomes an explicit upstream gap rather than a direct Azure SDK workaround.

## What is not exposed

Some categories of work commonly associated with FinOps are not present in the AMG-MCP surface that Az-Pixiu sees today:

- Reservations, savings plans, and other discount instruments. No tool currently surfaces reservation utilization, recommendation engines, or commitment shapes.
- Budgets and forecasts. No tool currently surfaces Cost Management budgets or native forecast values.
- Advisor recommendations. Azure Advisor's right-sizing and idle-resource suggestions are not currently exposed.
- Detailed billing exports. The cost surface is the aggregate Cost Management API, not raw usage or billing exports.

These absences are not defects; they are the natural shape of an early MCP surface. Where they limit the agent's analysis, the [AMG-MCP integration PRD](prd/amg-mcp-integration.md) requires the integration to make the limitation visible rather than to hide it.
