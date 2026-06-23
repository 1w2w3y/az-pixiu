# Local Billing Cache

> **Status (2026-06):** Proposal. This design plans a local, file-backed cache for historical Azure Cost Management data retrieved through AMG-MCP. It is not implemented yet. The goal is to reduce repeated calls to the rate-limited `amgmcp_cost_analysis` capability while preserving Az-Pixiu's local-first, read-only, AMG-MCP-bounded evidence contract.

## Context

Az-Pixiu currently retrieves cost evidence during each analysis run through AMG-MCP, usually by calling `amgmcp_cost_analysis` once per subscription and time window. That keeps the Azure boundary clean, but it has an operational cost: Azure Cost Management is strongly rate-limited, and repeated local analyses can spend scarce query budget re-reading historical billing periods that have already stabilized.

The existing `BillingProbeCache` (`src/run/billing-probe-cache.ts`) solves a different problem. It remembers whether a subscription appears to have Cost Management read access, so auto-discovery can avoid repeatedly probing subscriptions that are likely to fail. It does not cache billing data itself. This design adds a separate cache for the historical billing evidence the agent reasons over, and deliberately reuses the probe cache's filesystem patterns — atomic temp-file-then-rename writes and degrade-to-miss on any filesystem failure — wherever they already work. It diverges on two points. First, the root: the billing cache defaults under `runs/billing-cache/` (alongside run output, gitignored), whereas the probe cache lives under `~/.az-pixiu`; either can be relocated. Second, partitioning: the probe cache partitions by endpoint *and* operator identity because a probe *outcome* (does this caller have Cost Management access?) is identity-dependent — but the billing *data* a cell holds is a property of the endpoint + subscription + month, not of the reader, so the billing cache partitions by **endpoint only** (see [cache layout](#cache-layout)).

The cache is deliberately local. It lives under the operator's filesystem, is never committed to the repository, and is treated as sensitive cloud cost data. It is a performance and resilience substrate, not a new source of truth outside the operator's environment.

One scope assumption is load-bearing and stated up front: this design assumes a billing period equals a calendar month. That holds for Enterprise Agreement (EA) and Microsoft Customer Agreement (MCA) first-party Azure usage at subscription scope, and the first implementation is scoped to those. It does **not** hold for CSP / New Commerce anniversary cycles, MCA marketplace invoicing, or pay-as-you-go cycles that run on a shifted day-of-month. The maturity and partitioning rules below are only correct under the calendar-month assumption, so the cache records the detected billing-account type and refuses (or loudly warns) before caching an account whose cycle it cannot treat as a calendar month.

## Goals

- Avoid re-querying AMG-MCP for historical full-month billing data that has already stabilized.
- Preserve the AMG-MCP boundary: the cache is populated only from AMG-MCP responses, not direct Azure SDK or Retail Prices API calls.
- Keep cached evidence auditable by preserving source capability, request parameters, cost view, currency mode, retrieval time, and normalization metadata.
- Support cost-summary, cost-surprise, and future recurring-review and recurring-cleanup workflows without turning every run into a live Cost Management fan-out.
- Make cache freshness explicit so reports can distinguish live, cached usage-stable, and unavailable cost evidence.
- Keep the initial format simple enough to inspect, back up, delete, and regenerate locally.

## Non-goals

- The cache will not model invoices, reservations, savings plans, negotiated discounts, or finance-grade accruals beyond what AMG-MCP's Cost Management aggregate returns.
- The cache will not model marketplace / third-party charges, credits, refunds, rebates, tax, or support as separate line items, and it will not represent net out-of-pocket spend. It stores the same gross, pre-credit, pre-tax, estimated amount Cost Management itself returns. See [what the cached total means](#what-the-cached-total-means).
- The cache will not cache the current month or any month that has not passed the configured stabilization window.
- The cache will not become a shared hosted datastore.
- The cache will not bypass AMG-MCP with direct Azure billing APIs.
- The cache will not try to store every possible Cost Management grouping or multi-dimensional cube in the first implementation.
- The cache will not be silently authoritative when data is missing, stale, or outside its coverage.
- The cache will not become a pricing / rate source for the calibrated weekly-impact estimator. Those estimates come exclusively from `PricingRateSource` list prices (`src/pricing/`, `src/run/waste-detection.ts`), never from observed billing dollars. The cache feeds cost-summary *evidence*; turning it into a rate source would be a separate, deliberate change that implements the `PricingRateSource` interface.
- The first implementation will not support billing accounts whose billing period is not a calendar month (CSP / New Commerce, MCA marketplace, shifted-cycle MOSP). Those are detected and skipped, not silently mis-cached.

## What the cached total means

A cached `month_total` is a gross, pre-credit, pre-tax, **estimated** Cost Management amount. It is the same number Cost Management would show for the period, with the same exclusions: credits, refunds, rebates, tax, and support are out of model, and figures remain estimated until an invoice is generated. It is suitable for trend and anomaly analysis and for framing cost movement, but it is not the operator's net spend. A recommendation that frames a cached number as "money saved" can materially overstate net impact for any subscription funded by Azure credits, a MACC commitment, or sponsorship. Scope & Data Sources echoes this caveat whenever an impact figure derives from a cached total.

The cost **view** also has to be explicit, because the same subscription-month returns different totals under different views:

- `ActualCost` records a reservation or savings-plan purchase as a lump charge on the day it was bought.
- `AmortizedCost` spreads that purchase across its term, reallocates the benefit onto the resources that consumed it, and introduces `UnusedReservation` / `UnusedSavingsPlan` line items that exist only in the amortized view.

The two views produce different `month_total`s, and per-dimension breakdowns under the amortized view do **not** sum to `month_total`, because unused-commitment cost is not attributable to any resource, region, or resource group. The cache therefore stores the residual explicitly (an `unattributed` bucket) and the coverage check carries a reconciliation flag rather than assuming the dimensions tie out.

For optimization and waste framing the natural default is `AmortizedCost` (effective per-resource cost); for raw daily-shape anomaly detection `cost_surprise` may prefer `ActualCost`. The first implementation picks one default (`amortized`), records it in `maturity.cost_view`, surfaces it in Scope & Data Sources, and folds it into the cache key so the two views never collide. Amortized totals for a past month are not permanently stable — a later reservation purchase, exchange, or refund re-spreads amortization onto already-stabilized months — so amortized files carry a shorter re-verification horizon than actual-cost files.

## Maturity policy

The cache only writes complete billing periods that are considered usage-stable, and it is honest that "usage-stable" is weaker than "invoiced".

Microsoft's own guidance is that usage and charges for a period can keep changing for several days after the period ends (commonly through about the fifth day, occasionally longer), and that rerating continues until the invoice closes. Marketplace charges, credits, refunds, amortization re-spreads, and tax can post or shift even later. So the policy distinguishes three states rather than a single "finalized" flag:

- `not_mature` — the period has not yet passed the stabilization window. Never written to cache.
- `usage_stable` — most first-party usage charges have stopped accruing. Cacheable, and readable by default, but still carries `late_adjustment_possible: true` until it is past the invoice-close horizon.
- `finalized` — reserved for an invoice-backed signal. The first implementation does not have a reliable source for this and will rarely set it; it exists so the schema does not have to change later.

The stabilization rule is expressed relative to the **billing-period end**, in **UTC**, with an **injected clock**, because a fixed civil day-of-month is only correct when the period ends on the last day of the month:

- A period is cacheable as `usage_stable` once the current instant is at or after `billing_period_end + stabilization_offset_days`, evaluated at `T00:00:00Z`.
- Default `stabilization_offset_days = 5`. For the calendar-month case this reproduces "the 5th day of the following month" (June 2026 becomes cacheable on `2026-07-06T00:00:00Z`, i.e. five days after the `2026-07-01T00:00:00Z` period end).
- `became_cacheable_on` is stored as the UTC date of that instant. The current period is never written.

Computing the boundary in UTC matters: `billing_period.start` / `billing_period.end` are already stored with a `Z` suffix, and the rest of the system (`freshness.ts`, the probe cache, ISO-8601 time windows) reasons in UTC epoch. A local-date computation would let a UTC-8 operator on the evening of July 4 already be "July 5", so two operators — or one travelling laptop — would disagree on the gate. The clock is injected exactly as `BillingProbeCache` accepts `now?: () => number`, so unit tests pin one minute either side of the boundary.

```ts
export type MaturityStatus = 'not_mature' | 'usage_stable' | 'finalized';

export interface MaturityPolicy {
  /** Days after billing_period_end before a period is usage-stable. */
  stabilizationOffsetDays: number; // default 5
  /** Months younger than this still allow late adjustments. */
  invoiceCloseHorizonMonths: number; // default 2
}

export interface MaturityDecision {
  status: MaturityStatus;
  cost_view: 'actual' | 'amortized';
  became_cacheable_on: string;       // UTC date, YYYY-MM-DD
  late_adjustment_possible: boolean; // true while inside the invoice-close horizon
}

export function evaluateMaturity(
  billingPeriodEndUtc: string, // ISO, UTC (Z)
  costView: 'actual' | 'amortized',
  policy: MaturityPolicy,
  now: () => number,           // injected; defaults to Date.now at the call site
): MaturityDecision;
```

This replaces the original "immutable forever once past the 5th" rule with a refresh posture: read freely once `usage_stable`, but re-verify the trailing few months (the invoice-close horizon) on the next warm or status run, then stop. A `--force-refresh` option still lets an operator replace a stabilized period explicitly when they believe Azure posted late adjustments. Live analyses for recent periods are unaffected; those results are not written to the cache at all, or are recorded only as transient run artifacts under `runs/`.

The default `stabilization_offset_days = 5` should be configurable, but the first implementation keeps it conservative and computes it from the period end, not from a civil date.

## Cache layout

Default root: `runs/billing-cache/v1/` — alongside the run output. It follows `--output-dir`, so it is a stable sibling of the timestamped `runs/<timestamp>/` folders, never nested inside one. `runs/` is already gitignored, so the cache is never committed.

```text
runs/billing-cache/v1/                          # follows --output-dir; override with billing_cache.root
  <endpoint-hash>/
    manifest.json
    subscriptions/
      <subscription-id>/
        months/
          2026-01.amortized-normalized_usd-<digest>.json
          2026-02.amortized-normalized_usd-<digest>.json
          2026-03.amortized-normalized_usd-<digest>.json
```

Rationale:

- The cache root is a **stable, run-independent** location — a sibling of the per-run `runs/<timestamp>/` folders, not nested inside any one of them. That is exactly what lets a later run read a month an earlier run warmed; nesting the cache under a per-run timestamped folder would make every cross-run read a guaranteed miss and defeat the cache. For fully out-of-tree storage (an encrypted volume, or one cache shared across checkouts) set `billing_cache.root`.
- The partition directory is the AMG-MCP endpoint hash (`hashEndpoint(endpoint)`) — and **only** the endpoint. The cache is deliberately *not* partitioned by the operator's credential, because the auth credential *mode* (`azure-cli` / `mock`) is not an identity: two operators share a mode, and one mode can carry different `az login` identities and tenants, so partitioning by it would give false isolation while the billing numbers are identical regardless of who read them. The real boundaries are OS file permissions (`0600`), the per-user run-output directory, and the `source.amg_mcp_endpoint_hash` stored in each record and validated on read. A caller that holds a genuinely *resolved* principal id may still pass it as `identityHint` to scope the partition further (folded in as a non-lossy digest); the CLI does not. What is **not** provided is isolation between two different Azure identities sharing one OS user and endpoint — set `billing_cache.root` per identity, or supply a resolved `identityHint`, when that matters.
- Subscription id is the natural partition for AMG-MCP cost calls and for cache invalidation.
- One JSON file per cached cell keeps files reviewable and makes partial refresh cheap. The filename encodes more than the month — see [cache cell identity](#cache-cell-identity).
- `manifest.json` indexes available cells, schema version, root identity, billing-account type, content checksums, and the last successful warm operation. It is a **rebuildable index, not a transaction log** — see [manifest as a rebuildable index](#manifest-as-a-rebuildable-index).

The default lives under `runs/`, which is gitignored, so the cache is never committed; for fully out-of-tree storage set `billing_cache.root`. As a planned safeguard, the store will refuse to write to a repository-relative root that is *not* gitignored (not yet enforced in the foundation slice — see [privacy and storage](#privacy-and-storage)).

## Cache cell identity

A subscription id and a calendar month do not uniquely identify a Cost Management number. The same `2026-05` for the same subscription returns different totals depending on the cost view (`ActualCost` vs `AmortizedCost`), how currency is normalized (billing currency vs Cost Management's automatic conversion to USD), the granularity requested, the scope the call was issued against (subscription vs invoice / billing-profile), and any filter applied to the underlying `amgmcp_cost_analysis` call. Two runs that differ on any of these would otherwise collide on one file and silently overwrite or serve each other's data — a confidently-cited but non-reproducible figure, which is exactly the "evidence over assertion" failure the project forbids.

The cache therefore keys a cell on the full tuple, not just subscription and month:

- `subscription_id`
- `month` (`YYYY-MM`)
- `cost_view` (`actual` | `amortized`)
- `currency_mode` (`billing` | `normalized_usd`)
- `granularity` (`Daily`)
- `scope` (the scope kind the call was issued against)
- `parameters_digest` (covers grouping and any filter)

The discriminating dimensions are promoted into the filename so distinct parameterizations coexist rather than overwrite:

```text
months/2026-05.<cost_view>-<currency_mode>-<digest>.json
```

The digest reuses the project's existing hashing idiom — `createHash('sha256').update(...).digest('hex').slice(0, 16)`, the same form as `hashEndpoint` and `computeScopeSignature`. This matters for the read path as much as the write path: the `CostEvidenceProvider` computes the same digest for the live request it stands in for and refuses a hit unless every dimension matches. A digest mismatch is a cache miss plus a data-quality finding, never a silent wrong-parameter hit. One cache file answers exactly one `(view, currency, scope, filter)` question.

## Cache record shape

Each cell file stores both provenance and normalized summaries. A representative shape:

```json
{
  "schema_version": "billing-cache-v1",
  "subscription_id": "00000000-0000-0000-0000-000000000000",
  "month": "2026-05",
  "billing_period": {
    "start": "2026-05-01T00:00:00Z",
    "end": "2026-06-01T00:00:00Z",
    "granularity": "Daily",
    "billing_account_type": "MCA"
  },
  "maturity": {
    "status": "usage_stable",
    "cost_view": "amortized",
    "stabilization_offset_days": 5,
    "became_cacheable_on": "2026-06-06",
    "late_adjustment_possible": true,
    "retrieved_at": "2026-06-06T18:22:41Z"
  },
  "source": {
    "capability": "amgmcp_cost_analysis",
    "capability_version": "unknown",
    "amg_mcp_endpoint_hash": "sha256:...",
    "scope": "subscription",
    "parameters_digest": "...",
    "currency_mode": "normalized_usd"
  },
  "totals": {
    "currency": "USD",
    "exchange_rate_date": null,
    "month_total": 1234.56,
    "unattributed": 0.0,
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
      "daily": [],
      "daily_status": "not_available_in_source"
    },
    "resource_type": {
      "monthly": [{ "name": "microsoft.dbforpostgresql/flexibleservers", "cost": 510.77 }],
      "daily": [],
      "daily_status": "not_available_in_source"
    },
    "resource_group": {
      "monthly": [],
      "daily": [],
      "status": "not_supported_by_current_capability"
    }
  },
  "coverage": {
    "complete": true,
    "dimensions_reconcile": true,
    "missing_dimensions": ["resource_group", "meter_category"],
    "included_charge_classes": ["first_party_usage"],
    "excluded_charge_classes": ["marketplace", "tax", "credits"],
    "warnings": []
  }
}
```

The exact shape should be refined against live AMG-MCP responses before implementation, but the intent is stable:

- Provenance — including cost view, currency mode, scope, and the endpoint hash — is stored with the data so a report can cite cached evidence honestly and the read path can validate identity.
- Monthly rollups make common reports fast. Daily rows are retained where available so a later analysis can compute week-over-week or month-to-date comparisons without another live call.
- `totals.unattributed` records the amortized residual (e.g. `UnusedReservation`) so per-dimension sums do not have to equal `month_total`; `coverage.dimensions_reconcile` flags whether they do.
- `coverage.included_charge_classes` / `excluded_charge_classes` make the marketplace/credits/tax exclusions explicit, because the cache tracks not only missing *dimensions* but missing *charge classes*. MOSP accounts exclude marketplace from the aggregate; EA/MCA include it on a separate, later cadence.
- Unsupported dimensions are recorded explicitly rather than omitted silently, and a dimension whose daily breakdown the source cannot provide is marked `daily_status` rather than implying an empty day.

When this record is converted into an `EvidenceRecord`, `capability_version` is set to the cache schema version `billing-cache-v1` (the schema requires a non-empty string, and this lets longitudinal eval distinguish cache formats); the original AMG-MCP `capability_version` is preserved inside `source`.

## Dimensions to cache

The first implementation should cache independent one-dimensional breakdowns, not a full multi-dimensional cube.

Required dimensions:

- `subscription_total`: total cost per subscription per month.
- `daily_total`: total cost per day within the month.
- `service`: monthly and, where the source provides it, daily cost by service name. (The agent today requests `grouping: ['ServiceName']` at daily granularity, so service is the one dimension with reliable daily rows.)
- `region`: monthly cost by Azure region; daily marked `not_available_in_source`.
- `resource_type`: monthly cost by resource type; daily marked `not_available_in_source`.

Strongly desired dimensions:

- `resource_group`: monthly and, if AMG-MCP supports the grouping safely, daily cost by resource group.

Explicitly not supported by the current capability (recorded as such, like `resource_group`):

- `meter_category` / Cost Management service category — `cost_analysis` groups by service, region, and resource type, not meter category. Recorded as `not_supported_by_current_capability` rather than left implicit.

Deferred dimensions:

- `resource_id`: useful but potentially very large and noisy; only add after proving the cost and payload size are acceptable.
- Tag dimensions such as owner, environment, and cost center. Today these are better joined from `query_resource_graph` inventory because tags can change independently from the historical billing aggregate.
- Full cross-products such as service × region × resource group. These multiply storage and query cost quickly. Add targeted cross-cuts only when an analysis or evaluation proves they are load-bearing.

This means the cache can answer "which subscription, service, region, or resource type dominated May?" without re-reading AMG-MCP. It does not initially answer "which service in which resource group in which region" from cache alone. Because per-dimension daily arrays are unfillable from the current source for region and resource type, they are coverage-gated: a `complete: true` immutable file must not imply that daily region data was withheld. Learning to populate a dimension's daily rows later is a source-version bump, not an in-place fill.

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

- If a requested window is made entirely of cached usage-stable months, read from cache only.
- If a requested window mixes usage-stable months and recent or partial periods, use cached months for the stable portion and live AMG-MCP calls for the recent portion.
- If a requested window is not aligned to full months, the agent may still use daily cached rows for the overlapping stable days, but it must label the evidence coverage precisely.
- Never fill a recent missing period by extrapolating from cached historical data.

## FileBillingCacheStore

`FileBillingCacheStore` mirrors `BillingProbeCache` for everything that already works there, and diverges only where billing data demands more: a file tree instead of one flat map, a manifest index, restrictive permissions, non-silent corruption handling, and a composite cell key.

```ts
export interface BillingCacheStoreOptions {
  root?: string;          // store fallback: ~/.az-pixiu/billing-cache/v1 (the CLI defaults to runs/billing-cache/v1)
  endpoint: string;       // the partition discriminator (hashed); cells never cross endpoints
  identityHint?: string;  // optional RESOLVED principal id, never the auth mode; CLI leaves unset
  enabled?: boolean;
  now?: () => number;     // injected clock for maturity + tmp naming
}

export interface CacheCellKey {
  subscriptionId: string;
  month: string;          // YYYY-MM
  costView: 'actual' | 'amortized';
  currencyMode: 'billing' | 'normalized_usd';
  granularity: 'Daily';
  scope: string;
  parametersDigest: string;
}

export interface FileBillingCacheStore {
  get(key: CacheCellKey): Promise<BillingCacheRecord | undefined>;
  set(record: BillingCacheRecord, onWarning?: (msg: string) => void): Promise<void>;
  list(subscriptionId?: string): Promise<CacheCellKey[]>; // directory scan, not manifest-trusting
  rebuildManifest(onWarning?: (msg: string) => void): Promise<void>;
  filePathFor(key: CacheCellKey): string;
}
```

Two things differ from the probe cache and both are deliberate:

- **Permissions.** `BillingProbeCache.writeAtomic` passes no `mode`, so files land at the process umask default (commonly `0644`) under a `0755` home directory — on a shared workstation any local user could read another operator's full Azure spend. There is no `chmod` handling anywhere in `src/` today, so secure permissions cannot be inherited; the store sets them explicitly. It creates the tree with `mkdir(dir, { recursive: true, mode: 0o700 })` and writes the temp file with `writeFile(tmp, data, { mode: 0o600 })`; `rename` preserves the temp inode's mode. On Windows the POSIX mode is advisory and the per-user `%USERPROFILE%\.az-pixiu` ACL is the real boundary — stated explicitly, with a POSIX-only test asserting the created modes.
- **Endpoint partitioning (no identity in the path).** The partition directory is the endpoint hash via `hashEndpoint`, and the credential mode is never placed in the path (a mode is not an identity; see [cache layout](#cache-layout)). The read path additionally validates `source.amg_mcp_endpoint_hash` inside the record against the current endpoint and rejects a mismatch as a miss rather than a wrong hit. An optional resolved `identityHint` is folded in as a non-lossy digest when a caller has a real principal id.

Everything else — atomic temp-file-then-rename, degrade-to-miss on any filesystem error — is copied from the probe cache.

## Manifest as a rebuildable index

`manifest.json` and the per-cell files are separate atomic writes, and `rename` gives no transaction across them. The contract that keeps this safe is to make the per-cell files the source of truth and the manifest a rebuildable index that is never authoritative:

- The read path resolves a cell by checking its file directly, not by trusting the manifest. If the manifest lists a cell whose file is absent, that is a miss; if a real cell file exists that the manifest omits, the read still finds it via directory scan.
- The write path writes the cell file first (temp + rename), then best-effort updates the manifest using the same read-load-merge-write-rename idiom the probe cache uses, so a concurrent manifest write can at worst lose an index entry, never corrupt the file. A failed manifest update is non-fatal; the next `warm` or `status` reconciles it.
- `pixiu cache billing status` (and an explicit `rebuild-manifest`) regenerates the manifest from the tree, matching only the strict `<YYYY-MM>.<view>-<currency>-<digest>.json` pattern so stray `*.tmp-*` files are never mistaken for cells.

This is the one place the design deliberately leaves the probe cache behind: a single flat file needs no manifest because `rename` is the only atomicity boundary. Introducing an index reintroduces a cross-file consistency problem that the index-is-derived rule resolves without a lock.

Concurrency follows from the same rule. Two concurrent warms, or a warm-while-analyze, interleave only at the manifest level, where the worst case is a lost — and self-healing — index entry; the cell files each commit atomically via their own rename. Interrupted warms can scatter orphan `*.tmp-*` siblings, so `warm`, `prune`, and `status` sweep stale temp files under the cache root. An advisory lock file is possible future work but is not required for the first implementation. Disk-budget enforcement is a documented warn-threshold with a config knob; `prune` removes cell files first, then reconciles the manifest, never deletes the manifest itself, tolerates a concurrent reader, and is recoverable from the directory if interrupted.

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

1. Discover or accept subscription ids, and detect the billing-account type; skip (with a warning) any account whose billing period is not a calendar month.
2. Compute cacheable periods using the maturity policy and the injected clock.
3. Skip cells already present and valid unless `--force` is passed.
4. Query AMG-MCP one subscription-month at a time, through `EvidenceExecutor`, with the existing retry / backoff and pacing substrate.
5. Apply the finalization gate (below) before writing anything other than `not_mature`.
6. Write each cell atomically: temp file first, then rename, then best-effort manifest update.
7. Print a concise summary: cells written, cache hits, skipped-not-mature, skipped-existing, skipped-not-finalized, failures by category.

The warmer uses low concurrency by default, ideally one live Cost Management call at a time. The point is to move query cost into an intentional maintenance command, not to create a faster rate-limit storm.

### Finalization gate (rejecting throttled and partial responses)

`amgmcp_cost_analysis` returns Cost Management throttling and RBAC failures as an HTTP 200-OK whose payload carries `subscriptions[*].error` text — which is exactly why `inspectToolCallResultForFailure` / the cost-analysis inspector exist in `src/evidence/payload-failure.ts`. Because a warmed cell is written as effectively durable (read by default until a forced refresh), a warmer that trusts `isError: false` would persist a throttled zero-cost or partially-covered response as authoritative billing data, and every later analysis would silently read it.

The warm path closes this by routing real serialized calls through `EvidenceExecutor` rather than the concurrent, observability-only `probeBillingAccess`. The executor is already sequential, applies `DEFAULT_RETRY_POLICY` with `computeBackoffMs`, paces per capability after a 429, and throws `EmbeddedPayloadFailure` so an embedded 429 flows through the same retry and transport-summary accounting as a wire 429. The warmer reuses the probe's parameter shape and classification helpers, not its worker pool, and mirrors `WasteDetectionExecutor`'s delegation structure (including the `executorOverrides` sleep/jitter seam so tests stay fast).

Before writing `maturity.status` as anything other than `not_mature`, the warmer runs `inspectToolCallResultForFailure('amgmcp_cost_analysis', result)` and the wrapped-error checks (`isWrappedError` / `classifyWrappedError`). On any `rate_limit`, `auth`, `authz_gap`, or `schema_mismatch` for a subscription — or a suspicious all-zero total — that subscription-month is not written: it is recorded as skipped-not-finalized, counted in the warm summary, and left uncached so a later warm retries it live. A test asserts that a throttled 200-OK response is never written as a stabilized cell, sibling to the force-refresh test.

## Analysis workflow

Playbooks and `EvidenceExecutor` are not directly coupled, so the cache does not sit literally between them. `selectPlaybook(scope)` produces an `EvidencePlan` and the orchestrator separately calls `EvidenceExecutor.execute(plan)`. The cache hooks that call site, mirroring how `WasteDetectionExecutor` is a wrapper executor invoked from a helper in the orchestrator whose `EvidenceRecord[]`, `transport_summary`, and `failures` are merged into the main lists.

A `CostEvidenceProvider` is injected via a new optional `RunOptions` field, following the `runHistoryStore` / `rateSource` convention, and spread conditionally into `runAnalysis(...)` from `cli.ts`. It returns an `ExecutionResult`-compatible shape (`{ raw_evidence, failures, transport_summary }`) so the downstream merges — `EvidenceNormalizer`, failure-to-data-quality, freshness, transport rollup — are untouched.

Responsibilities:

- Decide whether a cost request is cache-eligible (full, usage-stable months only).
- Resolve matching cells by the full cache-cell key and read them.
- Reconstruct `RawEvidence` from a hit — the decoded `amgmcp_cost_analysis` payload plus the request parameters and `capability_version` from the run's `DiscoveredCatalog` — and feed it back through `EvidenceNormalizer`, rather than minting `EvidenceRecord`s directly. This keeps normalization in one place and preserves `scopeFromCostPayload`, which rewrites `scope_subset.subscription_ids` from the payload; a provider that minted records directly would have to replicate that enrichment or risk over-claiming coverage.
- Fall back to live AMG-MCP when the cache misses and the requested window is allowed to be live.
- Emit data-quality findings when the cache is missing, stale, corrupt, identity-mismatched, or outside the requested window.

Provenance on a cache-served record follows the established synthetic-source convention. `source_capability` is `az_pixiu_billing_cache`, alongside `az_pixiu_waste_lane` and `az_pixiu_run_history` (see `src/schemas/common.ts`, `src/run/prior-run-evidence.ts`). This is **not** an MCP wire capability and must not be added to the read-only allowlist or required-capabilities set, which only gate `MCPClient.invoke` and the planner; it will not trip `isMutatingCapabilityName`. `data_freshness` on a cache-served record is set so that usage-stable cached months are exempt from the recent-window posting-lag caveat, consistent with excluding the cache capability from the freshness capability set (below).

Report behavior:

- Scope & Data Sources lists cached billing evidence separately from live AMG-MCP evidence, and names the cost view, currency mode, covered subscription-months, maturity status, retrieval timestamp, and any missing dimensions or charge classes.
- Run Quality shows cache hits, cache misses, live cost calls avoided, live cost calls made, and skipped-not-mature months.
- Executive Summary does not hide when a recommendation is based on cached usage-stable billing data.

The cache is **on by default** for `cost_summary` runs. `--no-billing-cache` opts a single run out and `billing_cache.enabled: false` disables it persistently; `--billing-cache` force-enables it when config disabled it (the flag pair matches the existing `--probe-billing` / `--no-probe-billing` convention). Default-on is low blast-radius: only a single-subscription request whose window is exactly one finalized full month is cache-eligible, so recent, partial, or multi-subscription windows still go live unchanged. Two known limitations apply while default-on: the stored `cost_view` is operator-asserted from config rather than read back from the wire call, and the invoice-close-horizon re-verification is not yet implemented, so a cached month is served until a `--force-refresh` (or manual deletion) rather than auto-revalidated.

### Making cached cost evidence visible to coverage and run-outcome

Cost-aware logic is gated on a hardcoded two-element set `{ amgmcp_cost_analysis, cost_analysis }` that is duplicated in three places: `computeCostCoverage` (`src/report/coverage.ts`), `checkFreshness` (`src/run/freshness.ts`), and `classifyCostRetrievalOutcome` (`src/run/orchestrator.ts`). With `source_capability = 'az_pixiu_billing_cache'`, cached cost evidence is silently excluded from every one of them: coverage skips the record so `covered_ids` stays empty, and the SUCCESS / PARTIAL / FAILED banner computes zero coverage — so a cache-only run that *fully answered* the question would render as a failed, zero-coverage run. This is the single most consequential code-versus-doc mismatch, and an implementer must address all three sites.

The fix is deliberate and asymmetric:

- Extract one shared, exported `COST_CAPABILITIES` set so the three sites cannot drift, and add `az_pixiu_billing_cache` to the **coverage** and **run-outcome classification** sets so cached evidence counts toward `covered_ids` and toward a successful outcome.
- Do **not** add it to the **freshness** set. Usage-stable cached months must not be treated as subject to posting lag, or the natural "add it everywhere" change would re-introduce false freshness findings on stable months.

There is a second gate. `classifyCostRetrievalOutcome` returns `not_applicable` when no cost-capability calls appear in `transport_summary`, and a successful cache-only run makes no wire calls at all. To keep the Run Quality banner honest, a cache hit should emit a synthetic `transport_summary` entry marked as cache-served (no wire attempt, success outcome). That single change lets the existing `rollupTransportSummary` and the outcome classifier produce both the banner and the "live cost calls avoided / made" counters from one path, rather than teaching the classifier to count evidence records separately.

## Freshness and correctness rules

- Usage-stable means "retrieved after the configured stabilization window", not "financially audited invoice". The schema reserves `finalized` for a stronger, invoice-backed signal the first implementation rarely sets.
- Any cached month can be manually refreshed, and the trailing few months inside the invoice-close horizon are re-verified on the next warm rather than trusted forever.
- The agent must never blend cached and live evidence without making the boundary visible in report metadata.
- If AMG-MCP later exposes stronger billing-export semantics, this cache adds a new source version rather than changing the meaning of existing files.

### Corruption and version state machine

`BillingProbeCache` degrades both a missing file and a corrupt file to an empty result and stays silent, because it is observability-only. The billing cache feeds the evidence stream, so a bad file is still non-fatal but is no longer silent — it becomes a cache miss plus a finding. The read path resolves each cell to exactly one state:

- `hit` — file present, JSON parses, `schema_version` recognized, key dimensions and `source.amg_mcp_endpoint_hash` match the request, integrity check passes. Reconstruct `RawEvidence` and serve.
- `miss` — file absent. Fall through to live when the window allows.
- `corrupt` — read or parse fails, or the envelope shape is wrong. Treat as a miss and emit a data-quality finding; the next warm rewrites a clean file.
- `schema_mismatch` — recognized envelope, unrecognized `schema_version`. Treat as a miss and emit a **Run Quality warning** (not a silent drop, unlike the probe cache's `version === 1` equality check). The warning is actionable — it names the count of skipped months and points at `cache billing refresh` — because "ignore and warn" over a large cache silently reintroduces the rate-limit pressure the cache exists to remove.
- `identity_mismatch` / `digest_mismatch` — well-formed but warmed under a different endpoint, identity, or parameter set. Treat as a miss; never a wrong hit.
- `integrity_mismatch` — the content checksum recorded out-of-band in `manifest.json` does not match the recomputed value. Treat as a miss plus a data-quality finding rather than trusting a possibly-tampered file.

Schema evolution rule: the per-cell record owns the canonical `schema_version`; the manifest version is advisory and a skew defers to the records. A version bump prefers in-place migration on read where the shape is forward-compatible, reserving the `schema_mismatch` / ignore-and-warn path for genuinely unreadable records, so an upgrade does not force a full re-warm — the exact rate-limit storm the cache prevents.

## Privacy and storage

Billing cache files are sensitive. They include subscription ids, costs, services, regions, and potentially resource groups. The data classification is "internal / sensitive cost and topology" — not customer PII by design, but organizationally sensitive and durable, and the deferred `resource_group` / `resource_id` / tag dimensions are a deliberate sensitivity escalation because they frequently embed project codenames, owners, and cost centers.

Requirements:

- Store under `runs/billing-cache/` by default — alongside the run artifacts and already gitignored, so the cache is never committed. This trades the strongest out-of-tree boundary for co-location with run output and per-checkout locality; set `billing_cache.root` to `~/.az-pixiu` or an encrypted volume when the data must live outside the working tree (and be shared across checkouts). Note `git clean -x` would remove a working-tree cache, where a `~/.az-pixiu` cache survives. As a planned safeguard (not yet enforced), the store will refuse a repository-relative root that is not gitignored, rather than relying on an unstated convention.
- **File permissions.** Directory mode `0700`, file mode `0600`, set on the temp file before rename (see [FileBillingCacheStore](#filebillingcachestore)). On Windows the per-user profile ACL is the boundary.
- **At-rest encryption.** The first implementation relies on operator-managed full-disk encryption, with the threat-model boundary stated: disk encryption protects against device or backup theft, not against another local user on the same host reading the files — which is why the `0600` permissions are still required, not optional. Application-level encryption is documented future work.
- **Integrity.** Each cell's content checksum is recorded out-of-band in `manifest.json` (optionally an HMAC keyed by a per-install secret under `~/.az-pixiu`) and recomputed on read; a mismatch demotes the cell to a miss plus a finding. This keeps a hand-edited or swapped file — whose self-attesting provenance block a tamperer can edit alongside the totals — from being cited as authoritative evidence, which would be worse than an uncited recommendation because it looks trustworthy. At minimum the cache is trusted to the level of OS file permissions plus disk encryption, which makes the permissions fix a prerequisite.
- **Observability.** Do not send raw cached payloads to Langfuse. See [trace vocabulary additions](#trace-vocabulary-additions) for the exact redaction boundary.
- Provide a config knob for cache root so operators can place it on an encrypted disk.
- Do not include cache files in eval fixtures unless explicitly sanitized: a sanitized fixture replaces subscription ids with synthetic GUIDs and strips resource-group / resource-id / tag names, copied under `fixtures/`.

## Trace vocabulary additions

Cache telemetry joins the existing §14 vocabulary rather than inventing names. There is direct precedent: `az_pixiu.discovery.cache_hits` and `az_pixiu.discovery.cache_misses` already exist in `src/observability/spans.ts`, rendered as a cache line in the Run Metadata footer.

New constants are registered in `spans.ts`, never passed as string literals:

- A span name for the standalone warm command, following the `run.<phase>` convention (for example `SpanNames.BillingCacheWarm = 'run.billing_cache'`).
- Attributes under the mandatory `az_pixiu.` prefix, mirroring the discovery names: `az_pixiu.billing_cache.hits`, `.misses`, `.skipped_not_mature`, `.live_calls_avoided`, `.live_calls_made`, `.source`.

Run-level rollups are set with `span.setAttribute(...)` and per-item detail via `emitEvent(span, ...)`, exactly as `runWasteDetection` opens one `withSpan` and emits per-lane events. The same counters persist into `run.json` as a `billing_cache` block on `RunMetadataSchema`, mirroring the `DiscoveryFunnel` `cache_hits` / `cache_misses` precedent and kept optional so older artifacts still parse.

The redaction boundary is concrete and enforced, because OTEL export is permissive (`shouldExportSpan` lets the full `az_pixiu.*` tree out, and existing waste spans already emit dollar figures). Only counts, month identifiers, dimension-names-present, hit/miss status, coarse age, and source are emitted. Per-dimension cost arrays (`byService` / `byRegion`) and any payload reference are never set as span attributes. A scalar `total_cost` is emitted only behind a named, real configuration gate — and the existing observability modes (`noop`, `memory`, `langfuse`, `ms-otel`) are backend selectors, not such a gate, so if cost summaries are to be conditional this design introduces that redaction setting rather than implying a pre-existing one.

## Config and CLI registration

`ConfigSchema` is `.strict()`, so a `billing_cache` key in `config.json` is rejected at load until the block is declared. Declaring it is therefore an early, gating step, not optional plumbing:

```ts
export const BillingCacheConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    stabilization_offset_days: z.number().int().min(0).max(28).optional().default(5),
    invoice_close_horizon_months: z.number().int().min(0).max(6).optional().default(2),
    cost_view: z.enum(['actual', 'amortized']).optional().default('amortized'),
    root: z.string().min(1).optional(),
  })
  .strict();
```

It attaches to `ConfigSchema` as `billing_cache: BillingCacheConfigSchema.optional()`, the same nested form as the existing `foundry` and `observability` blocks (not a flat dotted key), is read as `config.billing_cache?.stabilization_offset_days ?? 5`, and is documented in `config.sample.json`. The CLI defaults the cache root to `join(runsDir, 'billing-cache', 'v1')` — i.e. `runs/billing-cache/v1`, following `--output-dir` so the cache sits beside the run artifacts (and is gitignored with them). `FileBillingCacheStore`'s own fallback, when constructed without a root, remains `join(homedir(), '.az-pixiu', 'billing-cache', 'v1')` for programmatic callers; operators relocate the CLI cache via `billing_cache.root`.

The CLI is a hand-rolled `parseArgs` dispatcher with a single positional switch (`analyze` | `eval` | `diagnose`). The warm surface needs a two-level positional dispatch added: a `cache` arm routing on `positionals[1] === 'billing'` and `positionals[2]` in `{ warm, status, refresh, prune }`, a `runCacheCommand(values, positionals)` alongside the existing command functions (each loading config first and returning an exit code), the cache flags registered in the single `parseArgs({ options })` block, and the hand-maintained `USAGE` template extended with a `cache flags` section and a `pixiu cache billing warm/status/refresh/prune` synopsis. Standardize the opt-in on `--billing-cache` / `--no-billing-cache` and the refresh override on a single `--force`, dropping the inconsistent `--use-billing-cache` and `read-through`-value spellings.

## Evaluation and tests

Initial test surface:

- Unit tests for maturity policy with an **injected, frozen clock**: a period is not cacheable before the boundary, becomes cacheable at the boundary, and is tested one minute either side of the UTC stabilization instant; the current period is never written.
- Unit tests for cache-cell path derivation (the full composite key), atomic write/read, and the `0600`/`0700` modes (POSIX-only).
- Unit tests for cache miss, corrupt file, schema mismatch, identity mismatch, digest mismatch, integrity mismatch, and force refresh.
- A test that a throttled 200-OK `amgmcp_cost_analysis` response is never written as a stabilized cell, and that an interrupted write leaves no temp file visible to the reader.
- Integration test that warms a fixture-backed subscription-month, then runs `cost_summary` from cache with zero live `amgmcp_cost_analysis` calls — asserting `FixtureMCPTransport` records zero cost replays for the cache-only item.
- Report tests that verify Run Quality and Scope & Data Sources disclose cache hits, cost view, and skipped recent months.

Two seams are prerequisites and belong in sequencing step 1:

- **Clock injection.** The maturity decision depends on wall-clock now, but the orchestrator hardcodes `new Date().toISOString()` and `RunOptions` exposes no clock seam. Thread an injectable `now?: () => number` through `RunOptions` into the provider's maturity check, the warmer, and the eval runner, mirroring `BillingProbeCache`'s `now?` option, so maturity eval items can pin a frozen clock and reproduce.
- **Cache-root override.** A cache-only eval run needs two artifacts — fixture wire responses for the warm step and the resulting cache tree for the analyze step — and must not pollute the operator's home cache. The cache root must be overridable per-run so eval points at a temp dir or a sanitized `fixtures/<id>/billing-cache/` tree.

Dataset additions (mirroring the `az_pixiu_waste_lane` expectation precedent in `eval/phase-3-waste.json`, so cache-backed items expect `az_pixiu_billing_cache` rather than `amgmcp_cost_analysis`):

- `cost-summary-cache-001`: one subscription with three usage-stable months cached; analysis uses cache only and expects `['az_pixiu_billing_cache']`.
- `cost-summary-cache-mixed-001`: two stable months cached plus current partial month live; expects both capabilities and discloses mixed evidence.
- `cost-summary-cache-not-mature-001`: previous month before the stabilization boundary under a frozen clock; the warmer skips it and analysis does not treat it as stable.

Possible new rubric:

- `billing_cache_freshness_grounded`: any recommendation using cached billing evidence must cite cache metadata (cost view, month, maturity status) and must not describe not-yet-mature periods as stable.

## Implementation sequencing

1. **Design, schema, and seams.** Add `BillingCacheRecord`, the composite `CacheCellKey`, and maturity-policy types under `src/billing-cache/`, with tests. In the same step, land the two cross-cutting seams the rest depends on: thread an injectable clock through `RunOptions` and the eval runner, and extract the shared `COST_CAPABILITIES` set so coverage, freshness, and run-outcome stop duplicating it.
2. **Config block.** Declare `BillingCacheConfigSchema` and attach it to the strict `ConfigSchema`, with `config.sample.json` and docs, before any flag or command can reference it.
3. **File store.** Implement `FileBillingCacheStore` with the composite-key path, `0600`/`0700` modes, endpoint partitioning (no credential mode in the path), atomic writes, manifest-as-index, corruption handling, and rebuild.
4. **Warmer CLI.** Add `pixiu cache billing warm/status/refresh/prune`, routed through `EvidenceExecutor` with the finalization gate, fixture-backed tests first.
5. **Cost evidence provider.** Add a read-through `CostEvidenceProvider` that satisfies full usage-stable months from cache at the `RawEvidence` level and returns an `ExecutionResult`-compatible shape.
6. **Capability-set and outcome visibility.** Add `az_pixiu_billing_cache` to the coverage and run-outcome sets (not freshness), and emit the synthetic transport-summary entry for cache hits.
7. **Analyzer integration.** Add `--billing-cache` / `--no-billing-cache` for analyze commands and wire the `CostEvidenceProvider` into the cost_summary path.
8. **Report, run.json, and trace disclosure.** Add cache hit/miss/avoided summaries to Run Quality and Scope & Data Sources, persist the `billing_cache` metadata block in `run.json`, and register the trace constants.
9. **Default-on for stable months.** Cache reads/writes default ON for cost_summary (usage-stable full months only), preserving `--no-billing-cache` and `billing_cache.enabled: false` as opt-outs.
10. **Dimension expansion.** Add resource-group cost if AMG-MCP supports the grouping reliably; defer resource-id and cross-product dimensions until an analysis proves they are necessary.

## Open questions

- Does AMG-MCP currently support cost grouping by resource group, and does it expose the cost view (Actual vs Amortized), currency mode, and exchange-rate metadata, or do these require an upstream capability addition?
- Should the stabilization offset and invoice-close horizon be fixed, or configurable per tenant / agreement type?
- Should the default cost view differ by analysis type (amortized for cost-summary / waste framing, actual for cost-surprise daily shape)?
- What is the maximum local disk budget before pruning should warn?
- Should cache records be optionally encrypted by Az-Pixiu, or should the project rely on operator-managed disk encryption (the current v1 stance)?
- Should `pixiu analyze` opportunistically warm missing stable months after a run? This is in tension with the "intentional maintenance command" rationale and the AMG-MCP back-pressure NFR; if pursued it must stay bounded — at most one stable month per run, off by default — and never fan out post-run.

## Success criteria

- A cache warm over six usage-stable months and N subscriptions produces one inspectable JSON file per cache cell, with `0600` permissions and a reconcilable manifest.
- Re-running a cost-summary over cached usage-stable months makes zero live `amgmcp_cost_analysis` calls, and the run still classifies as SUCCESS (cached evidence counts toward coverage and outcome).
- The report clearly states that billing evidence came from local cached usage-stable data, names the cost view and the months covered, and distinguishes it from live AMG-MCP evidence and from recent periods intentionally left uncached.
- Under a frozen clock, the warmer refuses to stabilize a period before `billing_period_end + stabilization_offset_days`, evaluated in UTC.
- A throttled 200-OK response is never written as a stabilized cell.
- Missing resource-group / meter-category dimensions and excluded marketplace / credit / tax charge classes are visible as cache coverage gaps rather than silent omissions.
- All cache-derived recommendations remain evidence-cited and read-only.
