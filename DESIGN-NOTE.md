# DESIGN-NOTE — fix/no-silent-cost-failure

Scope: surgical UX / exit-code fixes around `pixiu analyze cost-summary`. Not a
rewrite. Companion to PR-thread; this file lives at the repo root for the
duration of the branch and is removed before final merge if undesired.

## Bugs confirmed

### Bug A (confirmed, primary): silent collapse when Cost Management retrieval fails

Reproducer in production: `runs/2026-06-02T02-11-13Z-e39be53f/` and
`runs/2026-06-02T02-17-17Z-61c39b32/`. Both runs:

1. exhausted retries on `amgmcp_cost_analysis` (3 attempts, 263–281s cumulative
   backoff, all 429s),
2. invoked the reasoner anyway over the residual evidence
   (`amgmcp_query_resource_graph` only — no cost rows),
3. saw the reasoner cite evidence IDs that did not exist (the cost rows it
   expected were not in the pool), which post-process (`src/reasoning/post-process.ts`)
   silently dropped — surfacing only as `dq-synth-N — schema_mismatch` rows
   buried in the Data Quality section,
4. exited 0.

The user has no signal that the analysis produced nothing. The "Run outcome"
state is hidden three sections deep in `report.md`.

### Bug B (investigated, not real): SIGPIPE truncating runs

The prior agent reported that `pixiu analyze cost-summary | tee out | head -25`
"exited cleanly but produced no run folder." User manually re-reproduced and
the run folder was created. Node's default for SIGPIPE is `SIG_IGN`, so a
broken pipe surfaces as an `EPIPE` error event on `process.stdout` — at worst,
this elevates `process.exitCode` after the run has already written its
artefacts (see `runAnalysis` in `src/run/orchestrator.ts:843–871` — the report,
HTML, and `run.json` are written inside `withSpan(ReportAssembly, …)` well
before the trailing stdout summary block). The prior agent likely misread an
exit code 1 from a tail-side EPIPE as "no run." Per the task brief: do not
change behavior. A short comment is added in `cli.ts` recording the
investigation so a future reader does not re-walk the same path.

## What this branch changes

### 1. Exit-code semantics (`src/cli.ts`)

Existing exit codes are preserved:

| code | meaning                                             |
|------|-----------------------------------------------------|
| 0    | run produced report + passed all rubrics            |
| 1    | config error (`ConfigError`)                        |
| 2    | usage error                                         |
| 3    | run produced report but rubric scoring failed       |
| 4    | run crashed before producing a report               |
| 5    | subscription discovery failed                       |
| **6**| **NEW: run wrote its report but cost-evidence retrieval failed across the entire scope** |
| 99   | unhandled main() rejection                          |

Exit code 6 is a deliberate **soft failure**: the run folder, `report.md`, and
`run.json` are all written so the trace is preserved and Langfuse still gets
the analysis. The non-zero code is the user-facing signal that the analysis is
not actionable.

### 2. Loud stderr on cost-retrieval failure

When `analysis_type ∈ {cost_summary, cost_surprise}` and every cost-analysis
call in the run finished with a non-success transport outcome (rate_limit,
timeout, etc.) and no cost evidence record landed:

```
[FAILED] cost-evidence retrieval failed across all subscriptions in scope.
  cause: rate_limit (3 of 3 cost-analysis calls)
  consequence: no recommendations could be grounded in cost data.
  remediation: re-run after the upstream throttle window; narrow scope
               (e.g. --max-subscriptions 1) to lower the call rate; or
               retry tomorrow.
  report: runs/<dir>/report.md   (preserved for trace continuity)
```

The detection lives in the orchestrator (see new helper
`classifyCostRetrievalOutcome` in `src/run/orchestrator.ts`), reading the
existing `transport_summary` rollup against the in-scope subscription set. The
orchestrator surfaces the outcome on `RunResult.cost_retrieval_outcome` (one of
`'success' | 'partial' | 'failed' | 'not_applicable'`); the CLI maps `'failed'`
to exit-code 6 + the stderr block above.

### 3. Loud stderr on schema-mismatch reasoner drops

`postProcessReasoning` already counts the drops as `PostProcessIssue` rows
(`src/reasoning/post-process.ts`); the orchestrator already exposes the count
via `RunResult.post_process_issues` but the breakdown was lost. This branch
adds `RunResult.reasoning_drops = { facts, hypotheses, recommendations,
total }`, and the CLI emits:

```
[warning] reasoner cited evidence not present in the pool. Output was
          truncated: 3 fact(s), 2 hypothesis/es, 2 recommendation(s) dropped.
          See "Data Quality" findings dq-synth-* in report.md.
```

`reasoning_drops` is computed from `PostProcessIssue.target` for the three
drop-causing issue kinds (`dangling_citation`, `fabricated_number`,
`imperative_language`). The warning prints regardless of exit code so the
operator sees it even when other findings still survived.

### 4. `Run outcome:` line in `report.md`

The Run Quality section now begins with one explicit line so the report is
self-explanatory when skimmed:

```
**Run outcome:** SUCCESS / PARTIAL / FAILED — <one-sentence reason>
```

This is rendered by `src/report/markdown.ts` from
`RunMetadata.status` + the computed cost-retrieval outcome carried through the
new `runOutcome` field on `RenderReportInput`.

### 5. `metadata.status` honestly reflects the outcome

The orchestrator was hard-coding `metadata.status = 'success'` regardless of
what happened. This branch sets:

- `'success'` — cost retrieval landed evidence for all in-scope subs **and**
  no reasoner drops happened.
- `'partial'` — at least one cost-analysis call succeeded but coverage was
  incomplete **or** the reasoner had drops.
- `'failed_analysis'` — `cost_retrieval_outcome === 'failed'`.

The schema (`RunStatusSchema` in `src/schemas/metadata.ts`) already permits all
three values; no schema change.

## Backwards compatibility

- `RunResult.cost_retrieval_outcome` and `RunResult.reasoning_drops` are
  additive — every existing caller continues to typecheck.
- `metadata.status` was already a discriminated enum permitting all three
  written values; downstream consumers (eval runner, langfuse publisher,
  history store) read it as opaque.
- Exit code 6 is new. No previous code path used it; no test asserts on its
  absence.
- `report.md` adds one line at the top of the existing `## Run Quality`
  section. Existing tests that assert on Run Quality content continue to
  match (the new line is additive).

## Out of scope

- The reasoner *should* refuse to fabricate citations when its evidence pool
  lacks cost data; that requires a prompt change against `reasoner.v2.md`
  (Phase 3 scope) and is the right long-term fix. This branch is the
  user-facing safety net while that lands.
- Auto-retry / auto-narrow-scope on cost-retrieval failure is intentionally
  *not* done. The agent is read-only and human-reviewed; surfacing the
  failure and letting the operator re-run is the correct behaviour.
