# Az-Pixiu Phase 2 Design

> **Status (2026-05):** Phase 2 is in flight. The agent's *tracing* surface is wired (`src/observability/`, every run produces a Langfuse trace when configured). Langfuse Scores are now attached to ordinary `pixiu analyze` runs for the four structural rubrics, and `pixiu eval` can publish rubric and expectation scores, upsert local dataset items, and group per-item traces into a Langfuse Dataset Run / Experiment. Prompt management, Langfuse-sourced datasets, LLM-as-judge, human review, calibration, and configurable redaction remain planned work. This document records the path for moving the remaining surfaces into Langfuse without breaking offline operation.

## Context

Phase 1 delivered an end-to-end agent that runs against real AMG-MCP + Foundry, produces an evidence-cited report, lands a Langfuse trace per run, and scores its own reasoning against four structural rubrics ([phase-1 design](phase-1.md) §17). Phase 2 has started to make those local quality signals visible in Langfuse: analyze runs publish rubric scores when Langfuse is configured, and eval runs can publish scores and experiment grouping. The remaining surfaces — prompt versions, Langfuse-sourced datasets, judge scores, human review, calibration, and redaction policy — are still being moved out of the filesystem and in-process state. Phase 1 deliberately deferred that broader stack ([phase-1 design](phase-1.md) §"What Phase 1 deliberately leaves to later").

Phase 2's purpose is to make Langfuse load-bearing in day-to-day development, not a tracing sink. The bar set by the [Langfuse learning goals](../langfuse-learning-goals.md) is that "the project's day-to-day work genuinely depend on Langfuse." The bar set by the [Langfuse observability PRD](../prd/langfuse-observability.md) is the FR-6 through FR-12 cluster (prompt versioning, datasets, structural-plus-quality scoring, experiments, human review). The bar set by the [evaluation framework PRD](../prd/evaluation-framework.md) is FR-5 (eval results linked to Langfuse traces, prompts, model configs, experiments) plus FR-7 through FR-10 (grounding checks, multi-dimension scoring, baseline-vs-candidate comparison).

This document does *not* re-derive those requirements. It locks down the design choices that, between them, satisfy the requirements while staying compatible with the [hard constraints](../../CLAUDE.md#hard-constraints-architecturally-load-bearing) (local-first, read-only, AMG-MCP boundary, evidence over assertion, reversible decisions).

---

## Hard constraints recap

Two constraints shape every choice below. **Local-first** means Phase 2 must not turn Langfuse into a *required* dependency for running the agent — offline operation (fixture transport, mock model, noop observability) keeps working end-to-end, and Langfuse becomes a configurable surface. **Reversible decisions** means the Phase 2 layers (Langfuse Prompts, Datasets, Experiments) are wrapped in interfaces that can be swapped — same way the Phase 1 `ModelClient` and `MCPTransport` are. If Langfuse Cloud ever proves a bad fit for an enterprise operator, the path back to local artefacts is short.

The other constraints (read-only against Azure, AMG-MCP-as-boundary, calibrated uncertainty) are unchanged by anything in this design.

---

## Phase 2 scope decision

**In scope:**

1. **Langfuse Scores** — push every per-run rubric result, per-item expectation result, and selected aggregate metrics back as Langfuse Scores on the trace each run produces. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-9, FR-11.)
2. **Langfuse Prompts** — move `planner.v1` and `reasoner.v1` into Langfuse-managed prompts; preserve local-cache fallback so offline runs work. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-6.)
3. **Langfuse Datasets** — promote `eval/phase-1.json` items into a Langfuse Dataset; the local JSON file becomes a sync artefact rather than the source of truth. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-7; [evaluation-framework PRD](../prd/evaluation-framework.md) FR-2, FR-13.)
4. **Langfuse Experiments** — every `pixiu eval` invocation creates one Experiment that groups its per-item traces, identifiable by prompt version + model config + git SHA. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-10; [evaluation-framework PRD](../prd/evaluation-framework.md) FR-10.)
5. **LLM-as-judge scoring** — a second-pass evaluator that produces numeric scores for grounding, actionability, and clarity, run as part of `pixiu eval`. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-8, FR-11; [evaluation-framework PRD](../prd/evaluation-framework.md) FR-7, FR-8.)
6. **Human-review hook-in** — a documented and tooled way for humans to attach scores to traces after the fact, without conflicting with automated rubric scores. ([langfuse-observability PRD](../prd/langfuse-observability.md) FR-12; [evaluation-framework PRD](../prd/evaluation-framework.md) FR-9, FR-11.)
7. **Calibration loop** — periodic sampling of traces where automated scores disagree with human review, surfaced as a maintainer report. ([evaluation-framework PRD](../prd/evaluation-framework.md) Open Questions: "How should the project calibrate model-graded scores against human review?".)

**Out of scope (deferred to Phase 3 or later):**

- **Cross-org / multi-tenant prompt sharing.** Phase 2 assumes a single Langfuse project per operator.
- **Dataset-driven analysis expansion.** Adding new analysis types is Phase 3 ([roadmap](../roadmap.md) Phase 3 — Optimization breadth).
- **Custom Langfuse UI dashboards.** Phase 2 relies on Langfuse's built-in views, filtered by the trace metadata Phase 1 already emits.
- **Privacy-preserving trace sharing.** Listed in the [langfuse-observability PRD](../prd/langfuse-observability.md) Future Considerations; not load-bearing for development discipline.
- **Acceptance / rejection feedback loop from real recommendation outcomes.** Requires that the agent be used in a real FinOps process; Phase 2 cannot manufacture that signal.

---

## Eval architecture (the focus of Phase 2)

Phase 1's eval surface is two files (`src/evaluation/scoring.ts`, `src/evaluation/expectations.ts`) and one local dataset file (`eval/phase-1.json`). Phase 2's eval surface is **Langfuse-native** in three ways: scores live on traces, dataset items live in a Langfuse Dataset, and each invocation of `pixiu eval` is one Langfuse Experiment.

### Score taxonomy

Phase 1's rubric output is a typed `AggregateScore` with four boolean rubrics plus optional expectation results. Phase 2 maps that surface 1:1 onto Langfuse Scores, plus adds new dimensions. The mapping deliberately separates *who produced the score* and *what kind of value* it carries:

| Score name | Producer | Value type | Trigger |
|---|---|---|---|
| `rubric.structural_correctness` | orchestrator | boolean (0 or 1) | every run |
| `rubric.citation_completeness` | orchestrator | boolean | every run |
| `rubric.confidence_consistency` | orchestrator | boolean | every run |
| `rubric.read_only_adherence` | orchestrator | boolean | every run |
| `rubric.passed_all` | orchestrator | boolean | every run |
| `expectation.min_recommendations` | eval runner | boolean | eval items with this expectation |
| `expectation.expected_dq_categories` | eval runner | boolean | eval items with this expectation |
| `expectation.expected_capabilities_invoked` | eval runner | boolean | eval items with this expectation |
| `expectation.passed_all` | eval runner | boolean | eval items |
| `eval.passed_all` | eval runner | boolean | eval items |
| `judge.grounding` | LLM-as-judge | numeric (0.0–1.0) | eval items, optional |
| `judge.actionability` | LLM-as-judge | numeric (0.0–1.0) | eval items, optional |
| `judge.clarity` | LLM-as-judge | numeric (0.0–1.0) | eval items, optional |
| `human.<dimension>` | operator / reviewer | categorical or numeric | manual |

The `judge.*` and `human.*` namespaces are reserved so an aggregate view can show automated-vs-human disagreement at a glance. Adding new judge dimensions is an additive operation; the orchestrator is unaware of them.

**Trade-off rejected: cramming everything into one composite score.** A single 0–1 "quality" score loses the diagnostic value of seeing *which* rubric failed. The four boolean rubrics + N numeric judge dimensions preserve the diagnostic surface the [evaluation-framework PRD](../prd/evaluation-framework.md) FR-11 requires.

### Producer placement: orchestrator vs eval runner

The four Phase 1 rubrics already fire inside the orchestrator (`src/run/orchestrator.ts:506`) — they apply to *every* run, not just eval runs. Phase 2 keeps that placement; the orchestrator becomes the natural place to push rubric scores to Langfuse, so `pixiu analyze` runs get scored too. The eval runner *adds* expectation scores and (optionally) LLM-as-judge scores, but no longer owns the rubric layer.

**Trade-off accepted: every `pixiu analyze` run now writes Langfuse Scores, not just eval runs.** This is intentional. The maintainer journey "monitor agent quality over time" ([langfuse-observability PRD](../prd/langfuse-observability.md) §"Monitor Agent Quality Over Time") needs scores on real runs, not only on eval invocations. The cost is a small extra Langfuse write per run; the benefit is that the Langfuse "low-quality runs" filter (FR-13) is meaningful immediately.

### Dataset migration

**Source of truth shifts to Langfuse Datasets.** The local `eval/phase-1.json` becomes a sync artefact: a script reads the file, upserts each item into a Langfuse Dataset named `phase-1`, and is idempotent on re-run. The reverse direction is also supported (pull-from-Langfuse-into-local-JSON) so dataset edits in the UI flow back into the repo for review.

Two design choices worth naming:

1. **Item identity is the `id` field, not a Langfuse-assigned ID.** Phase 1's `cost-surprise-001` / `cost-surprise-002` / `cost-summary-001` keep being the stable identifiers. Langfuse-side IDs are an implementation detail. This keeps git history of dataset evolution readable, and lets a `pixiu eval` invocation refer to items by their human name.
2. **Fixture references stay in the dataset item.** `fixture_id` continues to point at a folder under `fixtures/`. Phase 2 does not try to push fixture bytes into Langfuse — fixtures are large and benefit from `git diff`. The Langfuse Dataset stores the scope + expectations; the fixture lives in the repo.

**Trade-off rejected: store fixtures in Langfuse blob attachments.** Tempting (a fully Langfuse-native dataset), but it makes dataset items hard to review in a PR, and Langfuse is not a content-addressable store. Fixtures stay in-repo.

### Experiment semantics

Each invocation of `pixiu eval` creates one Langfuse Experiment. The experiment is named `<dataset-id>@<config-hash>` where the config hash combines git SHA, prompt versions, and model config hash (the existing `modelConfigHash` from `src/model/client.ts`). Every per-item trace produced during the eval is tagged with the experiment ID, so the Langfuse UI's experiment view groups them automatically.

**Two questions this design closes:**

- *How are baseline vs candidate compared?* By running `pixiu eval` twice with different prompt versions (or model deployments), then opening both experiments side-by-side in Langfuse. No bespoke A/B harness — the comparison is "two experiments over the same dataset."
- *What if the dataset evolves mid-comparison?* Each experiment records the dataset *version* it ran against. If item `cost-surprise-001` changed between runs, the experiment-comparison view flags the diff. (Langfuse Datasets are versioned by item, not by collection — Phase 2 leans on this rather than maintaining its own dataset version field.)

**Trade-off rejected: a long-lived "main" experiment that accumulates runs.** Easier to set up but loses the baseline-vs-candidate framing the [evaluation-framework PRD](../prd/evaluation-framework.md) FR-10 requires. One experiment per invocation is the bound that makes comparison meaningful.

### LLM-as-judge layer

A second-pass evaluator runs after `pixiu eval` produces a `ReasoningOutput` for each dataset item. It calls a model with the trace's evidence and recommendations and asks for numeric scores on grounding, actionability, and clarity. The judge model is configurable; the judge prompt is itself a Langfuse-managed prompt (so it's versioned alongside the planner and reasoner).

Three guardrails make this useful rather than noisy:

1. **Judge runs only inside `pixiu eval`, not inside `pixiu analyze`.** Judges are an evaluation tool, not a production gate. Live runs do not pay the judge cost.
2. **Judge scores never overwrite rubric scores.** They live in the `judge.*` namespace. A run that passes all four rubrics can still get `judge.grounding = 0.4`, and that disagreement is the signal worth investigating.
3. **The judge sees only what the agent's recommendations cite.** Specifically, the judge prompt fences the cited evidence as data, the same way the reasoner prompt does (`src/reasoning/reasoner.ts:71-76`). The judge does not get raw payloads the reasoner did not use.

**Trade-off named, not resolved: which model judges?** Cheapest option is the same Foundry deployment; safest is a *different* model so judge and judged don't share failure modes; most expensive is a frontier model not available in the operator's tenant. Phase 2's default is "same deployment as the reasoner, single configurable override flag." Calibration data (next section) will tell us whether that's good enough.

### Human review surface

Humans don't write code to attach scores. The plan is two-fold:

1. **Document the manual path.** Operators or reviewers open a Langfuse trace and use Langfuse's built-in "Add Score" UI to attach a `human.<dimension>` score. The `human.` prefix is reserved by convention; the orchestrator and eval runner never write into it.
2. **Provide a thin batch tool.** A `pixiu review` CLI subcommand (new in Phase 2) pulls a sample of recent traces matching a filter (e.g., "every cost_surprise run from the past week with at least one judge score below 0.6") and opens them in the operator's browser, in order, with a structured prompt block to fill in. The scores still get written through Langfuse's API; the tool just curates the queue.

**Trade-off accepted: human review is asynchronous.** Phase 2 doesn't gate any run on human approval. The PRD's "human review for high-impact recommendations" (FR-12) is a *quality signal*, not a deployment gate — making it synchronous would conflict with local-first operation. Operators who want a gate can build one downstream of the trace.

### Calibration loop

The calibration loop is what keeps the LLM-as-judge honest. Periodically (manually triggered for now), a `pixiu calibrate` command samples N traces that have both a `judge.*` score and a corresponding `human.*` score in the same dimension, computes agreement (rank correlation, plus a confusion matrix for boolean dimensions), and writes a calibration report.

Two minimal commitments:

1. **The calibration report is a markdown file, not a Langfuse score.** It captures judgement, not measurement. Calibration history goes in the repo (`reports/calibration/<date>.md`) so it's diffable.
2. **A judge dimension below an agreement threshold is suspect, not blocked.** The maintainer reads the report and decides what to do — re-prompt the judge, swap models, drop the dimension entirely. There is no automatic disable.

This addresses the [evaluation-framework PRD](../prd/evaluation-framework.md) Open Question "How should the project calibrate model-graded scores against human review?" with a deliberately humble answer: measure, surface, decide manually.

### Open questions specific to eval

Carrying these into Phase 2 implementation, listed so they don't get silently decided:

- **Score-write resilience.** If the Langfuse write fails after the agent has already produced its report, the trace itself is fine but the scores aren't attached. Should the runner retry? Buffer? Persist a "scores pending" sidecar? Phase 1 already demoted trace-export failures to warnings (commit `cf9fe97`); scores should likely follow that same pattern, but the report+run.json are the operator's ground truth either way.
- **Dataset-item drift detection.** If a Langfuse-side edit changes a dataset item's expected DQ category and a subsequent eval run fails the expectation, is that a regression in the agent or in the dataset? The experiment view shows the dataset version, but the maintainer still needs a workflow.
- **Judge-prompt evaluation.** The judge prompt is itself a Langfuse-managed prompt and should be evaluated against its own dataset. Phase 2 ships an *initial* judge prompt without a curated judge-evaluation dataset; that's a Phase 3 input.

---

## Prompt management

The planner and reasoner prompts move into Langfuse-managed prompts named `planner` and `reasoner` (the version suffix in the current filenames disappears — Langfuse owns versioning). `RunMetadata.prompt_versions` continues to record the version actually used, sourced from Langfuse's response rather than parsed from a filename.

Three design choices:

1. **Local cache, opt-out.** The Langfuse Prompts SDK caches by default; Phase 2 keeps that on and ships a fallback to in-repo copies for offline runs. The fallback files (`prompts/planner.v1.md`, `prompts/reasoner.v1.md`) become *seed* artefacts — the source of truth for the very first Langfuse upload, but not consulted after that unless Langfuse is unreachable.
2. **Promotion semantics: label-driven.** Langfuse Prompts support labels (`production`, `staging`, etc.). The orchestrator reads the `production` label by default; `pixiu analyze --prompt-label staging` lets a maintainer test a candidate against live data without altering what production runs use.
3. **Compiled prompts vs raw templates.** Langfuse Prompts can be raw or templated. Phase 2 uses raw text for planner/reasoner (no per-call substitution); operator-supplied context (user_context, scope summary, evidence JSON) continues to be assembled in code rather than as a Langfuse template variable. This keeps the in-code prompt-injection fences (`<evidence_block>`, `<user_context_block>`) authoritative.

**Trade-off rejected: drop the local fallback entirely.** Faster to implement, but breaks offline operation — `pixiu eval --mock-model` and the integration tests would all need a live Langfuse, which would also make CI brittle. The cache + fallback is the local-first commitment expressed in code.

---

## Redaction & sensitive-data handling

Phase 1 keeps full payloads in `run.json` and ships only `payload_summary` objects through span attributes. That's the right boundary for *trace shape*; Phase 2 makes the choice explicit and configurable for trace *content*.

Concretely:

- **A `Redactor` interface** sits between the orchestrator and `LangfuseSpanProcessor`. Default redactor preserves subscription IDs, resource IDs, time windows, capability names, cost figures, and SKU strings, but redacts tag *values* (keys stay), activity-log `caller` fields, and any free-text user_context. Operators can swap the default for a stricter or looser redactor via config.
- **Redaction applies to scores' string fields too** (e.g., rubric `details`). A failure message that includes an evidence_id is fine; one that includes a tag value is not.
- **The local `run.json` is unaffected.** It's an operator-local artefact; the boundary is what leaves the operator's machine. The [langfuse-observability PRD](../prd/langfuse-observability.md) Non-Functional "Privacy" requirement is satisfied by making *what is shipped* deliberate.

This addresses [langfuse-observability PRD](../prd/langfuse-observability.md) FR-5 and the Open Question "What default redaction policy is appropriate for subscription identifiers, resource names, tag values, and cost figures?".

---

## Observability views

Phase 2 does not build a custom UI. It does, however, define the *saved views and tag conventions* that make Langfuse's built-in surfaces answer real questions:

- **"What runs failed a rubric in the last 7 days?"** Filter: `score.structural_correctness = 0 OR score.citation_completeness = 0 OR ... AND tags contains 'analysis:cost_surprise'`. The filter is documented in `docs/operations.md` (new in Phase 2).
- **"What does Foundry latency look like across analysis types?"** Filter on tag, group by analysis type. Existing trace attributes already support this (Phase 1 commit `2240ad8`).
- **"Which dataset items regressed since the last experiment?"** The experiment-comparison view, populated by §"Experiment semantics" above.
- **"What capabilities were attempted but produced no evidence?"** `mutating_capabilities_excluded` events are already emitted; Phase 2 adds a similar `capability_returned_no_evidence` event so the unsupported-scenario surfacing requirement (FR-14) becomes filterable.

The conventions are written down because the [langfuse-observability PRD](../prd/langfuse-observability.md) Non-Functional "Usability" requirement is "Langfuse views and artifacts should answer real engineering questions rather than showcasing generic dashboards" — and the way to honour that is to commit to specific questions.

---

## What Phase 2 deliberately leaves to later

- **Cross-experiment statistical rigor.** Phase 2 says "open both experiments side-by-side in Langfuse." It does *not* compute p-values or bootstrap confidence intervals. The [evaluation-framework PRD](../prd/evaluation-framework.md) Open Question "What level of statistical rigor is appropriate for early-stage experiments?" stays open; Phase 3 may answer it.
- **Auto-generated dataset items from production traces.** [evaluation-framework PRD](../prd/evaluation-framework.md) FR-14 calls for it. Manual curation remains the Phase 2 mode — pulling a trace into a dataset is a human review action, sanitization included.
- **Multi-judge ensemble.** Phase 2 ships one judge model and one judge prompt. Comparing two judges against the same dataset is a useful future experiment; Phase 2 does not prebuild the harness for it.
- **Acceptance/rejection telemetry.** Listed in the Phase 2 deferrals from [phase-1 design](phase-1.md) §"What Phase 1 deliberately leaves to later"; remains deferred because the agent isn't in a real FinOps workflow yet.

---

## Implementation sequencing

Each step independently shippable and independently revertible. Steps 1–3 unlock the rest; 4–6 fan out from there.

1. **Score-push from the orchestrator.** **Shipped.** The orchestrator publishes `rubric.*` scores for ordinary `pixiu analyze` runs when a Langfuse publisher is configured. Write failures are warnings only; reports and `run.json` remain the operator's ground truth.
2. **Score-push for expectations.** **Shipped for eval runs.** The eval runner writes per-rubric and per-expectation scores after each item. The local summary printout stays as a redundant convenience.
3. **Prompt move.** Initial upload of `prompts/planner.v1.md` and `prompts/reasoner.v1.md` to Langfuse Prompts (one-time script). Switch the orchestrator to read from Langfuse with local-fallback. `RunMetadata.prompt_versions` reads the Langfuse version.
4. **Dataset move.** **Partially shipped.** Eval runs can upsert local JSON items into a Langfuse Dataset. Still to do: read datasets from Langfuse as a source, retain a local-file override for offline operation, and add reverse-sync from Langfuse Dataset edits back to JSON for PR review.
5. **Experiments.** **Partially shipped.** Eval runs can group per-item traces under a Langfuse Dataset Run / Experiment name. Still to do: standardize the config-hash naming, enrich metadata with prompt versions and git SHA, and document the baseline-vs-candidate workflow in `docs/operations.md`.
6. **LLM-as-judge.** Add a judge step after each eval item's `ReasoningOutput`. Judge prompt is Langfuse-managed. Three judge dimensions land: `judge.grounding`, `judge.actionability`, `judge.clarity`. Add a `--no-judge` flag for fast iterations.
7. **Redactor.** Introduce the `Redactor` interface and a default policy. Apply to span attributes and score string fields before they leave the process.
8. **Human review tooling.** `pixiu review` subcommand that pulls a queue of traces by filter and opens each in the browser. Document the manual scoring path in `docs/operations.md`.
9. **Calibration.** `pixiu calibrate` command that samples traces, computes agreement, writes `reports/calibration/<date>.md`. Tiny — depends on enough human-review data existing to be useful.

Steps 1–5 are the "Langfuse-as-product-surface" deliverable. Steps 6–9 are the quality-development deliverable. Each step independently testable; each step can ship as its own PR.

---

## Verification

Phase 2 completes when every item below is met:

- **A `pixiu analyze` run produces a Langfuse trace with at least four rubric scores attached.** Verifiable in the Langfuse UI; the saved-view filter "score.structural_correctness exists" should return every recent run.
- **A `pixiu eval` invocation produces a Langfuse Experiment.** The experiment groups every per-item trace; the experiment name encodes git SHA + prompt version + model deployment.
- **Editing a prompt in Langfuse changes agent behaviour on the next run without a redeploy.** Promotion via label change; cached version expires; the new prompt takes effect on the next `pixiu analyze`.
- **Editing a dataset item in the Langfuse UI changes `pixiu eval`'s scope on the next run.** The reverse-sync command pulls the edit back into `eval/phase-1.json` so PR review is possible.
- **LLM-as-judge scores appear on eval items and are visible in the same trace as the rubric scores.** Disagreement between rubric scores (boolean) and judge scores (numeric) is filterable.
- **A human reviewer can attach a score via the Langfuse UI without writing code.** Documented in `docs/operations.md`.
- **A calibration report exists.** At least one calibration cycle has run against real `human.*` data.
- **Offline operation still works.** `pixiu eval eval/phase-1.json --use-playbook --mock-model --credential mock --observability noop --no-judge --dataset-file` produces the same `PASS: 3/3` it does today; no Langfuse network call required.

The Phase 1 verification list ([phase-1 design](phase-1.md) §Verification) continues to hold — Phase 2 does not regress any Phase 1 invariant.

---

## Critical files

The documents that ground every Phase 2 choice above:

- [Langfuse learning goals](../langfuse-learning-goals.md)
- [Langfuse observability PRD](../prd/langfuse-observability.md) — especially FRs 6–12
- [Evaluation framework PRD](../prd/evaluation-framework.md) — especially FRs 5–10
- [Roadmap](../roadmap.md) §Phase 2
- [Phase 1 design](phase-1.md) — Phase 2 builds on the existing component boundaries and the §14 trace vocabulary

The source surface Phase 2 will add or change:

- **Score producers.** `src/run/orchestrator.ts` (rubric writes), `src/evaluation/runner.ts` (expectation writes), `src/evaluation/judge.ts` (new — LLM-as-judge), `src/evaluation/calibration.ts` (new).
- **Prompt client.** `src/prompts/loader.ts` switches to a Langfuse-backed loader with a local fallback. `prompts/*.v1.md` become seed artefacts.
- **Dataset client.** `src/evaluation/dataset.ts` gains a Langfuse-backed path alongside the existing file-backed path. New script `scripts/sync-dataset.ts` (bidirectional).
- **Experiment wrapper.** `src/evaluation/experiment.ts` (new) — opens an experiment, tags item traces, closes the experiment.
- **Redactor.** `src/observability/redaction.ts` (new) sits between trace emission and the Langfuse processor.
- **Review + calibration CLIs.** `src/cli.ts` gains `review` and `calibrate` subcommands.
- **Operator docs.** `docs/operations.md` (new) records the saved-view filters, the human-review path, and the baseline-vs-candidate workflow.

Files Phase 2 does **not** touch: the `MCPTransport` interface and its implementations, the failure taxonomy, the read-only allowlist, the `Scope` and `EvidenceRecord` schemas. Phase 1's data shapes were designed to outlive Phase 1, and Phase 2 honours that.
