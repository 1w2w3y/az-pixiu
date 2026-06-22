# Local Billing Cache

> **Status (2026-06):** Proposal. This design plans a local, file-backed cache for historical Azure Cost Management data retrieved through AMG-MCP. It is not implemented yet. The goal is to reduce repeated calls to the rate-limited `amgmcp_cost_analysis` capability while preserving Az-Pixiu's local-first, read-only, AMG-MCP-bounded evidence contract.

## Context

Az-Pixiu currently retrieves cost evidence during each analysis run through AMG-MCP, usually by calling `amgmcp_cost_analysis` once per subscription and time window. That keeps the Azure boundary clean, but it has an operational cost: Azure Cost Management is strongly rate-limited, and repeated local analyses can spend scarce query budget re-reading historical billing periods that have already stabilized.

The existing `BillingProbeCache` solves a different problem. It remembers whether a subscription appears to have Cost Management read access, so auto-discovery can avoid repeatedly probing subscriptions that are likely to fail. It does not cache billing data itself. This design adds a separate cache for the historical billing evidence the agent reasons over.

The cache is deliberately local. It lives under the operator's filesystem, is never committed to the repository, and is treated as sensitive cloud cost data. It is a performance and resilience substrate, not a new source of truth outside the operator's environment.

## Goals

- Avoid re-querying AMG-MCP for historical full-month billing data that has already stabilized.
- Preserve the AMG-MCP boundary: the cache is populated only from AMG-MCP responses, not direct Azure SDK or Retail Prices API calls.
- Keep cached evidence auditable by preserving source capability, request parameters, retrieval time, and normalization metadata.
- Support cost-summary, cost-surprise, quarterly review, and future recurring cleanup workflows without turning every run into a live Cost Management fan-out.
- Make cache freshness explicit so reports can distinguish live, cached-final, and unavailable cost evidence.
- Keep the initial format simple enough to inspect, back up, delete, and regenerate locally.

## Non-goals

- The cache will not model invoices, reservations, savings plans, negotiated discounts, or finance-grade accruals beyond what AMG-MCP's Cost Management aggregate returns.
- The cache will not cache the current month or any month that has not passed the configured stabilization day.
- The cache will not become a shared hosted datastore.
- The cache will not bypass AMG-MCP with direct Azure billing APIs.
- The cache will not try to store every possible Cost Management grouping or multi-dimensional cube in the first implementation.
- The cache will not be silently authoritative when data is missing, stale, or outside its coverage.

## Maturity policy

The cache only writes **complete calendar months** that are considered billing-stable.

Default rule:

- A month `YYYY-MM` is cacheable only when the current date is on or after the **5th day of the following month**.
- Example: June 2026 can be written to cache on or after July 5, 2026.
- If today is July 1-4, June 2026 is still treated as not finalized and is not written as cached-final evidence.
- The current month is never written to the finalized cache.

The default should be configurable as `billing_cache.stabilization_day = 5`, but the first implementation should keep the rule conservative. Operators can still run live analyses for recent periods; those live results should either not be cached at all, or should be recorded only as transient run artifacts under `runs/`, not in the finalized billing cache.

Once a month is cached after the stabilization day, the default behavior is immutable-read: future analyses read it without refreshing it. A `--force-refresh` option can explicitly replace a finalized month if the operator believes Azure posted late adjustments.

## Cache layout

Default root:

```text
~/.az-pixiu/billing-cache/v1/
  manifest.json
  subscriptions/
    <subscription-id>/
      months/
        2026-01.json
        2026-02.json
        2026-03.json
```

Rationale:

- Subscription id is the natural partition for AMG-MCP cost calls and for cache invalidation.
- One JSON file per subscription per calendar month keeps files reviewable and makes partial refresh cheap.
- `manifest.json` indexes available subscriptions, months, schema version, cache root identity, and last successful warm operation.
- A custom root should be supported by config and CLI flags for operators who want the cache under an encrypted volume.

The cache directory must be gitignored by default. It contains sensitive cost data even when it contains no secrets.

## Cache record shape

Each monthly file stores both provenance and normalized summaries. A representative shape:

```json
{
  "schema_version": "billing-cache-v1",
  "subscription_id": "00000000-0000-0000-0000-000000000000",
  "month": "2026-05",
  "billing_period": {
    "start": "2026-05-01T00:00:00Z",
    "end": "2026-06-01T00:00:00Z",
    "granularity": "Daily"
  },
  "maturity": {
    "status": "finalized",
    "stabilization_day": 5,
    "became_cacheable_on": "2026-06-05",
    "retrieved_at": "2026-06-06T18:22:41Z"
  },
  "source": {
    "capability": "amgmcp_cost_analysis",
    "amg_mcp_endpoint_hash": "sha256:...",
    "parameters_digest": "...",
    "capability_version": "unknown"
  },
  "totals": {
    "currency": "USD",
    "month_total": 1234.56,
    "daily": [
      { "date": "2026-05-01", "cost": 39.12 },
      { "date": "2026-05-02", "cost": 41.07 }
    ]
  },
  "dimensions": {
    "service": {
      "monthly": [{ "name": "Azure Database for PostgreSQL", "cost": 500.12 }],
      "daily": [{ "date": "2026-05-01", "name": "Azure Database for PostgreSQL", "cost": 16.42 }]
    },
    "region": {
      "monthly": [{ "name": "westus2", "cost": 200.25 }],
      "daily": []
    },
    "resource_type": {
      "monthly": [{ "name": "microsoft.dbforpostgresql/flexibleservers", "cost": 510.77 }],
      "daily": []
    },
    "resource_group": {
      "monthly": [],
      "daily": [],
      "status": "not_supported_by_current_capability"
    }
  },
  "coverage": {
    "complete": true,
    "missing_dimensions": ["resource_group"],
    "warnings": []
  }
}
```

The exact shape should be refined against live AMG-MCP responses before implementation, but the intent is stable:

- Provenance is stored with the data so a report can cite cached evidence honestly.
- Monthly rollups make common reports fast.
- Daily rows are retained where available so a later analysis can compute week-over-week or month-to-date comparisons without another live call.
- Unsupported dimensions are recorded explicitly rather than omitted silently.

## Dimensions to cache

The first implementation should cache independent one-dimensional breakdowns, not a full multi-dimensional cube.

Required dimensions:

- `subscription_total`: total cost per subscription per month.
- `daily_total`: total cost per day within the month.
- `service`: monthly and, if available, daily cost by service name.
- `region`: monthly and, if available, daily cost by Azure region.
- `resource_type`: monthly and, if available, daily cost by resource type.

Strongly desired dimensions:

- `resource_group`: monthly and, if AMG-MCP supports it safely, daily cost by resource group.
- `meter_category` or equivalent Cost Management service category if AMG-MCP exposes it separately from service name.

Deferred dimensions:

- `resource_id`: useful but potentially very large and noisy; only add after proving the cost and payload size are acceptable.
- Tag dimensions such as owner, environment, and cost center. Today these are better joined from `query_resource_graph` inventory because tags can change independently from the historical billing aggregate.
- Full cross-products such as service x region x resource group. These multiply storage and query cost quickly. Add targeted cross-cuts only when an analysis or evaluation proves they are load-bearing.

This means the cache can answer questions like "which subscription, service, region, or resource type dominated May?" without re-reading AMG-MCP. It does not initially answer every question about "which service in which resource group in which region" from cache alone.

## Time granularity

The cache stores monthly files with daily internal granularity.

Why not only monthly totals:

- `cost_surprise` and recurring review workflows often need day-level shape to distinguish one-time spikes from sustained cost.
- Daily rows can be aggregated into weeks or months locally.
- Daily data for one closed month per subscription is still small compared with raw usage exports.

Why not arbitrary hourly or raw usage:

- AMG-MCP's current cost surface is aggregate Cost Management data, not raw billing export.
- Higher granularity increases payload size and rate-limit pressure.
- The product does not need finance-grade usage reconstruction.

Analysis-window behavior:

- If a requested window is made entirely of cached finalized months, read from cache only.
- If a requested window mixes finalized months and recent or partial periods, use cached months for the finalized portion and live AMG-MCP calls for the recent portion.
- If a requested window is not aligned to full months, the agent may still use daily cached rows for the overlapping finalized days, but it must label the evidence coverage precisely.
- Never fill a recent missing period by extrapolating from cached historical data.

## Warming workflow

Add a task-oriented CLI surface:

```bash
pixiu cache billing warm --months 6
pixiu cache billing warm --subscription <sub-id> --from-month 2026-01 --to-month 2026-05
pixiu cache billing status
pixiu cache billing refresh --subscription <sub-id> --month 2026-05 --force
pixiu cache billing prune --before-month 2025-01
```

Default warm behavior:

1. Discover or accept subscription ids.
2. Compute cacheable closed months using the maturity policy.
3. Skip months already present and valid unless `--force` is passed.
4. Query AMG-MCP one subscription-month at a time, with the existing retry/backoff and pacing substrate.
5. Write each month atomically: temporary file first, then rename.
6. Update `manifest.json` after successful writes.
7. Print a concise summary: months written, cache hits, skipped-not-mature, skipped-existing, failures by category.

The warmer should use low concurrency by default, ideally one live Cost Management call at a time. The point is to move query cost into an intentional maintenance command, not to create a faster rate-limit storm.

## Analysis workflow

The analyzer should gain a `CostEvidenceProvider` layer between playbooks and `EvidenceExecutor`.

Responsibilities:

- Decide whether a cost request is cache-eligible.
- Read matching finalized monthly files.
- Convert cached records into normal `EvidenceRecord`s with `source_capability = "az_pixiu_billing_cache"` or a similar explicit local capability name.
- Preserve original AMG-MCP provenance inside the cached evidence payload.
- Fall back to live AMG-MCP when the cache misses and the requested window is allowed to be live.
- Emit data-quality findings when the cache is missing, stale, corrupt, or outside the requested window.

Report behavior:

- Scope & Data Sources should list cached billing evidence separately from live AMG-MCP evidence.
- Run Quality should show cache hits, cache misses, live cost calls avoided, live cost calls made, and any skipped-not-mature months.
- Executive Summary should not hide when a recommendation is based on cached-final billing data.

The cache should be enabled by default only after the read path is well tested. Before that, add an explicit flag such as `--billing-cache read-through` or `--use-billing-cache` so operators can compare cached and live behavior.

## Freshness and correctness rules

- Cached-final means "retrieved after the configured stabilization day", not "financially audited invoice".
- Any cached month can be manually refreshed.
- Cache records with a schema version the current code does not understand are ignored with a Run Quality warning.
- A corrupt monthly file is treated as a cache miss plus a data-quality finding, not as fatal to the whole run.
- The agent must never blend cached and live evidence without making the boundary visible in report metadata.
- If AMG-MCP later exposes stronger billing-export semantics, this cache can add a new source version rather than changing the meaning of existing files.

## Privacy and storage

Billing cache files are sensitive. They include subscription ids, costs, services, regions, and potentially resource groups.

Requirements:

- Store under `~/.az-pixiu/` by default, not under the repository.
- Add repo-local ignore patterns for any optional local cache directory.
- Do not send raw cached payloads to Langfuse. Trace summaries can include counts, months, dimensions present, cache hit/miss status, and total cost only if the operator's existing observability mode already permits cost summaries.
- Provide a config knob for cache root so operators can place it on an encrypted disk.
- Do not include cache files in eval fixtures unless explicitly sanitized and copied under `fixtures/`.

## Evaluation and tests

Initial test surface:

- Unit tests for maturity policy: previous month is not cacheable before the 5th, becomes cacheable on the 5th, current month is never finalized.
- Unit tests for cache path derivation and atomic write/read.
- Unit tests for cache miss, corrupt file, schema mismatch, and force refresh.
- Integration test that warms a fixture-backed subscription-month, then runs `cost_summary` from cache with zero live `amgmcp_cost_analysis` calls.
- Report tests that verify Run Quality and Scope & Data Sources disclose cache hits and skipped recent months.

Dataset additions:

- `cost-summary-cache-001`: one subscription with three finalized months cached; analysis should use cache only.
- `cost-summary-cache-mixed-001`: two finalized months cached plus current partial month live; report should disclose mixed evidence.
- `cost-summary-cache-not-mature-001`: previous month before stabilization day; cache warmer skips it and analysis does not treat it as finalized.

Possible new rubric:

- `billing_cache_freshness_grounded`: any recommendation using cached billing evidence must cite cache metadata and must not describe not-yet-mature periods as finalized.

## Implementation sequencing

1. **Design and schema.** Add `BillingCacheRecord` and maturity-policy types under `src/billing-cache/`, with tests.
2. **File store.** Implement `FileBillingCacheStore` with atomic JSON writes, reads, manifest updates, and corruption handling.
3. **Warmer CLI.** Add `pixiu cache billing warm/status/refresh/prune`, fixture-backed tests first.
4. **Cost evidence provider.** Add a read-through provider that can satisfy full-month cost requests from cache and convert them into `EvidenceRecord`s.
5. **Analyzer integration behind a flag.** Add `--use-billing-cache` for analyze commands. Keep live behavior as the default until report and eval coverage are green.
6. **Report and run.json disclosure.** Add cache hit/miss summaries to Run Quality and persist cache metadata in `run.json`.
7. **Default-on for finalized months.** Once stable, make cache reads default for finalized full months while preserving `--no-billing-cache`.
8. **Dimension expansion.** Add resource-group cost if AMG-MCP supports the grouping reliably; defer resource-id and cross-product dimensions until an analysis proves they are necessary.

## Open questions

- Does AMG-MCP currently support cost grouping by resource group, or does that require an upstream capability addition?
- Should the default stabilization day be fixed at 5, or should it be configurable per tenant?
- Should finalized monthly files be immutable by default forever, or should they have a long refresh TTL to capture late adjustments?
- What is the maximum local disk budget before pruning should warn?
- Should cache records be optionally encrypted by Az-Pixiu, or should the project rely on operator-managed disk encryption?
- Should cache warming be manually invoked only, or should `pixiu analyze` opportunistically warm missing mature months after a run?

## Success criteria

- A cache warm over six finalized months and N subscriptions produces one inspectable JSON file per subscription-month.
- Re-running a cost-summary over cached finalized months makes zero live `amgmcp_cost_analysis` calls.
- The report clearly states that billing evidence came from local cached-final data and lists the months covered.
- The warmer refuses to finalize the previous month before the 5th day of the following month.
- Missing resource-group or other unsupported dimensions are visible as cache coverage gaps rather than silent omissions.
- All cache-derived recommendations remain evidence-cited and read-only.
