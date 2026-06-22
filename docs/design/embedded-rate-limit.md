# Embedded Rate-Limit Detection

> **Status (2026-06):** Implemented in Az-Pixiu; retained as design rationale and upstream-cleanup notes.  
> **Scope:** Sub-problem under [cron-comparison-improvements §Gap 7](cron-comparison-improvements.md#gap-7--429--rate-limit-handling-mostly-implemented).  
> **Empirical anchor:** [`runs-modelcompare/gpt-5_4/98bda740-…/run.json`](../../runs-modelcompare/) — a `pixiu analyze cost-summary` run against 3 Grafana subscriptions where every `amgmcp_cost_analysis` call returned a 200-OK envelope wrapping an embedded `"Cost Management API rate limit (429)"` string, and yet `transport_summary.final_outcome` reported `"success"` for all three. Run Quality stated `"full cost-scope coverage (3 of 3 subscription(s) returned cost evidence)"`. Total observed cost: `0.00`. The report was self-contradicting.

## Problem

§Gap 7 in [cron-comparison-improvements](cron-comparison-improvements.md) named retry-with-backoff as the answer to AMG-MCP 429 responses. The retry substrate exists today in `src/evidence/executor.ts` and `src/evidence/retry-policy.ts` — backoff, jitter, per-call pacing, per-run budgets, and `transport_summary` rollup are all wired. The original design assumed AMG-MCP would surface upstream Cost Management 429s as **wire-level transport failures** — thrown exceptions, non-2xx HTTP status, or MCP protocol errors that `client.invoke()` propagates as exceptions and `classifyFailure()` resolves to `category: 'rate_limit'`.

The live AMG-MCP does not behave this way. For `amgmcp_cost_analysis`, the upstream Cost Management 429 is wrapped into a schema-valid JSON success payload:

```json
{
  "periodStart": "2026-05-17",
  "periodEnd":   "2026-05-24",
  "subscriptions": [{
    "subscriptionId": "3e61f926-…",
    "totalCost": 0,
    "byService":     [],
    "byRegion":      [],
    "byResourceType":[],
    "error": "Cost Management API rate limit (429) hit for subscription '…' through data source 'azure-monitor-oob'. See https://learn.microsoft.com/…"
  }]
}
```

The MCP envelope is HTTP 200 with `isError: false`. The payload validates against the cost-analysis schema. As a result, **none of the existing failure-detection paths fire**:

| Detection surface | Why it misses |
|---|---|
| `client.invoke()` exception → `classifyFailure()` | No exception was thrown. The MCP call is "successful". |
| `isWrappedError()` in `mcp/content.ts` | Matches text envelopes like `"An error occurred invoking …"`. This payload is valid JSON, not a text envelope. |
| `isEmptyResult()` in `failure/taxonomy.ts` | The payload has `periodStart`, `periodEnd`, and a non-empty `subscriptions` array. Not empty. |
| `summarize()` cost-analysis branch in `normalizer.ts` | Iterates `subscriptions[*]`, sums `totalCost`, counts `byService.length`. Both are 0 across the board. Outputs `row_count: 0, total_cost: 0` and stops. Does not read `subscriptions[i].error`. |
| `EvidenceExecutor` retry loop | Only retries on classified failures. The call never enters the failure branch. |

The downstream effect is that the deterministic pipeline records *false success* end-to-end:

- `transport_summary[i]`: `attempt_count=1, retry_count=0, final_outcome="success", pacing_applied=false`
- `rollupTransportSummary()` returns `rate_limit_seen=false, exhausted_count=0`, run outcome `"success"`
- Run Quality renders `0 transport error(s), 0 retry attempt(s)`
- Cost-scope coverage helper reads `evidence[*].scope_subset.subscription_ids` and reports 3 of 3 subscriptions covered
- Langfuse trace attributes set `az_pixiu.transport.final_outcome=success`, polluting any cross-run continuity (Gap 5) heuristic that wants to flag "this capability has been 429 for N consecutive runs"

The reasoner does see the embedded `error` string — it gets the full payload inline — and historically writes a `rate_limit` data-quality finding from it. But this is **incidental, not load-bearing**: any model with poor instruction-following may drop the finding, and even when it lands the retry window has already closed. The reference cron's empirical 12-week record (60–180s backoff recovered every 429) is unreachable from this path.

§Gap 7's design is correct; its **trigger surface is one detection layer too narrow**.

## Design

Detection of embedded rate-limit signals now lives at the same lifecycle point as wire-level failure classification: **inside `EvidenceExecutor`, between `client.invoke()` returning a `ToolCallResult` and `raw_evidence.push()`**. The output type matches the existing classifier: a `ClassifiedFailure` whose `category` is one of the retriable categories (`rate_limit`, `timeout`). The downstream substrate — backoff, jitter, budget, pacing, `transport_summary` rollup, Run Quality footer, Langfuse spans — is reused unchanged.

### Detection contract

A new module `src/evidence/payload-failure.ts` exports a pure function:

```ts
function inspectPayloadForFailure(
  capability: string,
  payload: unknown,
): ClassifiedFailure | undefined
```

The function is **per-capability conservative**:

- It only runs against known capability names (initially `amgmcp_cost_analysis`).
- It only inspects known field paths (initially `subscriptions[*].error`).
- It only matches well-known patterns:
  - `/\b429\b/i`, `/rate.?limit/i`, `/throttl/i` → `category: 'rate_limit'`
  - `/\bunauthor/i` → `category: 'auth'` (not retriable; classified for visibility)
  - `/forbidden|access denied/i` → `category: 'authz_gap'` (not retriable)
- If a known field contains a non-empty error string that matches **no** pattern *and* the corresponding data fields are empty (`totalCost === 0 && byService.length === 0`), it returns `category: 'schema_mismatch'`. This is "unknown payload-embedded error" and is not retriable; the operator gets a DQ finding, not a silent zero.

For capabilities that have no registered inspector, the function returns `undefined` and the executor behaves exactly as today.

### Insertion point

`EvidenceExecutor.executeOne()` currently has the shape:

```ts
try {
  const result = await this.client.invoke(request, ctx);
  raw_evidence.push(toRecord(result));
  return { outcome: 'success', … };
} catch (err) {
  const failure = classifyFailure(err, request);
  // existing retry / backoff / pacing logic
}
```

The change is one block inside the `try`:

```ts
try {
  const result = await this.client.invoke(request, ctx);
  const embedded = inspectPayloadForFailure(request.capability, result.payload);
  if (embedded) throw new EmbeddedPayloadFailure(embedded, result);
  raw_evidence.push(toRecord(result));
  return { outcome: 'success', … };
}
```

`EmbeddedPayloadFailure` is a new exception type; `classifyFailure()` short-circuits when it sees one (returning the already-classified failure instead of re-running heuristics). The catch block, retry oracle, backoff schedule, pacing, and budget accounting are all unchanged.

### Retried-success vs exhausted

When a retried embedded failure eventually returns a clean payload, the success path runs normally — `raw_evidence.push()`, normal `transport_summary` row with `retry_count >= 1`, `recovered_failure_categories: ['rate_limit']`, `final_outcome: 'success'`. The cost data is real.

When retries are exhausted, the existing exhausted path applies: no `raw_evidence` row is written for the failed attempt, a `DataQualityFinding` of category `rate_limit` is emitted, `transport_summary` row records `final_outcome: 'rate_limit'`, and `cost_coverage` correctly reports the subscription as *not* covered. The last attempt's payload may be stashed in the DQ finding's diagnostic field for operator forensics; it must not be promoted to evidence.

### Proactive pacing (deferred — observe-first)

**Not part of the minimal fix.** The original draft of this design included a `preCallPaceByCapability: { amgmcp_cost_analysis: 60_000 }` rule borrowed from the reference cron. After review, that rule was deferred: it pre-pays the worst-case backoff cost on every run regardless of whether 429s actually happen, and the reactive retry described above (already in `retry-policy.ts`: 30s → 60s → 120s backoff, 3 retries) recovers within the reference cron's empirical 60–180s window. Adding proactive pacing now would be insurance against a failure mode that the retry path is expected to handle on its own.

The trigger to revisit proactive pacing is **observational**, not architectural: if a representative live run (e.g. 8+ Grafana subscriptions, where the original cron experience comes from) shows retries that go all the way to `exhausted_count > 0` for `amgmcp_cost_analysis`, *then* the proactive pacing PR moves from "deferred" to "required". Until then, the reactive path is the contract.

If and when it lands, the shape is unchanged from the original draft: a new optional `RetryPolicy.preCallPaceByCapability` field with a per-capability default, honoured by the executor before dispatching the second and later calls of the same capability in a plan, recorded in `transport_summary[i].pacing_applied`, and injectable for tests. That work becomes its own PR; it does not block PR 1 or PR 2.

### Reporting

Three surfaces gain truth-telling, in priority order:

1. **`transport_summary` rows** — automatically correct once detection routes through retry. No new schema needed.
2. **`rollupTransportSummary()`** — already aggregates the right fields; `rate_limit_seen` becomes `true` for affected runs.
3. **Run Quality footer** in `report/markdown.ts` — already renders `retry_count`, `recovered_failure_categories`, and `exhausted_count`. Wording should read like the reference cron's: `amgmcp_cost_analysis: 3 calls, 1× recovered after 60s backoff, 1× exhausted` rather than the current `0 transport error(s), 0 retry attempt(s)`.
4. **`cost_coverage` helper** in `report/coverage.ts` — must read `transport_summary` for `final_outcome != 'success'` and demote those subscriptions from `covered` to `unavailable`. Today's helper only checks whether evidence records exist for a subscription; with embedded-429-as-failure that check stops being load-bearing (no evidence is pushed for an exhausted call), but coverage helper should not silently rely on absence.
5. **Executive Summary** — reasoner prompt (separate work, §S2 coverage disclosure) should explicitly state coverage gaps when `transport_rollup.exhausted_count > 0`. This is a prompt rule, not a code rule; outside the scope of this document beyond noting the dependency.

### Langfuse

The `retry_scheduled` and `backoff_started` span events already exist on the retry path. They light up automatically once detection routes through retry. The `transport.rate_limit_seen`, `transport.cumulative_backoff_ms`, and `transport.final_outcome` attributes correspondingly become honest, which is the prerequisite for any cross-run continuity (Gap 5) heuristic that wants to track "this capability has been 429 for N consecutive runs".

### Failure modes

| Risk | Mitigation |
|---|---|
| Inspector over-matches a legitimate payload (e.g. a resource literally named `"app-429"`) | Inspector only looks at well-known field paths, not free-text scan of the whole payload. `subscriptions[*].error` is a contract, not a search. |
| Inspector under-matches new AMG-MCP error wording | Patterns are deliberately broad (`/rate.?limit/i`, `/throttl/i`). Unknown error strings on known field paths still produce `schema_mismatch` DQ, never silent zero. |
| Inspector becomes spaghetti as more capabilities accrue payload-embedded errors | The registry is one switch; each capability gets its own inspector function. No global string scan. |
| Embedded 429 in a multi-subscription bulk call (partial success) | Out of scope for Phase 3. Today's `cost-summary` playbook is per-subscription. If bulk calls return later, the inspector contract extends to a richer return type (`{ retriable: [...], permanent: [...], success: subsetPayload }`). The interface is shaped to allow this without breaking. |
| Retry never recovers because Cost Management quota window is longer than `maxAttempts * maxDelayMs` | Existing path: retries exhaust, DQ finding emitted, coverage demoted. Operator sees the truth. Trigger to add proactive pacing (deferred section above). |
| AMG-MCP later changes its error shape | Inspector is one file with explicit field paths; a contract test against a recorded payload (committed under `tests/fixtures/cost-analysis-embedded-429.json`) breaks loudly. |

### Upstream cleanup

The AMG-MCP server should eventually surface upstream Cost Management 429s as a protocol-level error or as structured partial-failure metadata (`isError: true` on the `ToolCallResult`, or a typed `partial_failures` field on the payload). When that lands, az-pixiu's inspector becomes unreachable code that can be deleted. The inspector module header should carry a `// TODO: remove after AMG-MCP issue #NNN ships` comment with the upstream link.

The az-pixiu side will not depend on the upstream fix happening. The inspector is a bridge, not a contract.

## Out of scope

- Partial-success payloads (bulk multi-sub calls).
- QPU-budget awareness ahead of 429 emission — AMG-MCP does not expose remaining-budget headers today; if it does later, pacing becomes adaptive without changing the inspector interface.
- Adaptive pacing (auto-reducing the 60s default after N quiet runs). Useful but premature; depends on Phase 2.5 cross-run continuity data which is being collected now.
- Reasoner-side §S2 coverage-disclosure prompt rule. Tracked separately under §S2 in `cron-comparison-improvements.md`.

## Implementation sequencing

Four PRs that ship now, plus one observational gate that may become a fifth PR later. PR 1–2 are the **minimal correctness fix** and unblock everything else. PR 3 is the **coverage truth-telling**. PR 4 is the **upstream cleanup**, parallel and non-blocking. The deferred proactive-pacing work waits on the observational gate described in the *Proactive pacing (deferred)* section above.

### PR 1 — Payload-failure inspector framework

**Status:** Shipped.

**Goal.** Introduce the `PayloadInspector` type, the `inspectPayloadForFailure()` dispatch function, the `EmbeddedPayloadFailure` exception type, and the executor hook. No specific inspector is registered. No behaviour change for any existing capability.

**Files.** `src/evidence/payload-failure.ts` (new), `src/evidence/executor.ts` (one block in `executeOne()`), `src/failure/taxonomy.ts` (short-circuit `EmbeddedPayloadFailure`).

**Verification.** Full test suite passes unchanged. New unit test injects a stub inspector that always returns `rate_limit`; executor with a mock client returns success on attempt 3 → assert `attempt_count=3, retry_count=2, recovered_failure_categories=['rate_limit'], final_outcome='success'`.

### PR 2 — `amgmcp_cost_analysis` inspector

**Status:** Shipped.

**Goal.** Register the cost-analysis inspector. Match `subscriptions[*].error` for 429 / rate-limit / throttle wording (→ `rate_limit`), unauthorized (→ `auth`), forbidden (→ `authz_gap`), and unknown error on empty data (→ `schema_mismatch`).

**Files.** `src/evidence/payload-failure.ts` (cost-analysis inspector + registry entry), `tests/evidence/payload-failure.test.ts` (new), `tests/fixtures/cost-analysis-embedded-429.json` (anonymized recording of the live payload).

**Verification.** Against the fixture, inspector returns `{ category: 'rate_limit', message: <upstream string>, source: 'payload-embedded' }`. End-to-end: a `pixiu analyze cost-summary` run with a fixture transport that returns embedded-429 twice and then success once produces a Run Quality footer reading `amgmcp_cost_analysis: 1/1 subscription recovered after 1 retry`.

### PR 3 — Coverage helper reads `transport_summary`

**Status:** Shipped.

**Goal.** `cost_coverage` helper in `report/coverage.ts` reads `transport_summary` rows and demotes any subscription whose cost-analysis call has `final_outcome != 'success'` from `covered` to `unavailable`. This is correctness defense even after PR 1–2: the helper should not silently rely on "no evidence record → not covered". In the shipped path, exhausted embedded failures do not get promoted into cost evidence; the transport summary is still the durable source for why the subscription is unavailable.

**Files.** `src/report/coverage.ts`, tests in `tests/report/coverage.test.ts`.

**Verification.** Replay the live `runs-modelcompare/gpt-5_4/...` `run.json` *after* PR 1–2 land (so transport rows reflect retry exhaustion). Coverage helper reports `0 of 3 subscriptions covered, 3 unavailable`. Executive Summary input clearly shows the gap.

### PR 4 — Upstream AMG-MCP issue

**Status:** Still pending / external.

**Goal.** Open an issue against AMG-MCP requesting that `amgmcp_cost_analysis` surface upstream Cost Management 429s as either `isError: true` on the `ToolCallResult` or a typed structured-partial-failure field. Reference this design document and the inspector module as the workaround.

**Files.** None in az-pixiu beyond a TODO comment in `src/evidence/payload-failure.ts` linking to the upstream issue once it has a number.

**Verification.** Issue exists; the inspector module header cites it.

## Document conventions

- `cron-comparison-improvements.md` §Gap 7 now points here with the framing that the §Gap 7 retry substrate handles wire-level rate limits and payload-embedded rate limits through the same retry/backoff path.
- `cost-summary-depth.md` §Gap 6 (Run Quality surface) needs no change; the new pacing line is one more row of the same shape.
- The `phase-1.md` failure-taxonomy table line for `rate_limit` ("Backoff with jitter, capped retries; serialize across subs") becomes truthful once these PRs ship; no edit required.

## Critical references

- [`src/evidence/executor.ts`](../../src/evidence/executor.ts) — retry loop insertion point
- [`src/evidence/retry-policy.ts`](../../src/evidence/retry-policy.ts) — backoff / pacing schema
- [`src/failure/taxonomy.ts`](../../src/failure/taxonomy.ts) — classifyFailure path
- [`src/mcp/content.ts`](../../src/mcp/content.ts) — existing wrapped-error detection (a sibling of the new payload inspector)
- [`src/evidence/normalizer.ts`](../../src/evidence/normalizer.ts) — `summarize()` cost-analysis branch that today ignores `subscriptions[*].error`
- [`src/schemas/transport.ts`](../../src/schemas/transport.ts) — `TransportSummaryEntry`, `rollupTransportSummary()`, `runOutcomeFromRollup()`
- [`docs/design/cron-comparison-improvements.md` §Gap 7](cron-comparison-improvements.md#gap-7--429--rate-limit-handling-mostly-implemented) — parent design
- [`docs/prd/amg-mcp-integration.md`](../prd/amg-mcp-integration.md) lines 17, 85, 88 — rate-limit handling requirement
- [`~/repos/claw-context/cron-azure-cost-analysis/cron-definition.md`](https://github.com/1w2w3y/claw-context/blob/main/cron-azure-cost-analysis/cron-definition.md) "Key Constraints" — empirical 60s pacing rationale
- `runs-modelcompare/gpt-5_4/98bda740-5b36-4a28-96fe-0388b4b3c2dd/run.json` — empirical anchor for this design
