# Az-Pixiu Phase 1 Design

## Context

Az-Pixiu is currently in Phase 0 — documentation only, no code. The repo states the project's intent clearly: a **local, read-only, observability-first** Azure FinOps agent that reaches Azure exclusively through AMG-MCP and produces evidence-backed recommendations for human review. The principles also say that languages, frameworks, model providers, storage, packaging, and deployment are deliberately undecided.

This design is the bridge from "Phase 0 docs" to "Phase 1 code." Its job is to:

1. Lock down the architectural choices that the docs leave to implementation (component decomposition, data shapes, reasoning flow, trace vocabulary, read-only enforcement) — the parts that are easy to get wrong and hard to change later.
2. Present 2–3 option sets per deliberately-open tech decision (language, framework, model, storage, packaging) with a recommended Phase 1 default, so the choices can be made deliberately rather than by accretion.
3. Scope Phase 1 narrowly enough to ship — a single analysis type, a single output depth, a single deployment target — while leaving the component boundaries and trace vocabulary suitable for Phase 2+ reuse.

Phase 2+ (Langfuse depth, broader analyses, multi-agent reuse) is explicitly **out of scope** for this design; notes about Phase 2 appear only where Phase 1 would otherwise foreclose them.

---

## Hard constraints recap

From [architecture principles](../architecture-principles.md), [goals](../goals.md), and the PRDs. The design honors each one:

- **Local-first.** No hosted Az-Pixiu service. The agent runs on the operator's workstation. Sensitive cloud telemetry stays in the operator's environment, including when it transits AMG-MCP and Microsoft Foundry — both are Azure-resident under the operator's Entra ID identity. The Foundry deployment SKU controls model-inference data residency and must be surfaced before each run. Any genuinely external dependency (e.g., Langfuse Cloud) is operator-opt-in.
- **Read-only against Azure.** No delete/scale/modify/restart, ever. Enforced in defense-in-depth (§12).
- **AMG-MCP is the Azure boundary.** No direct Azure SDK calls inside the agent for cost/resource/telemetry data.
- **Evidence over assertion.** Every recommendation cites resources, time windows, and metrics. Uncited = defect.
- **Observable by construction.** Langfuse instrumentation is part of the first commit, not a follow-up.
- **Calibrated uncertainty.** Facts, hypotheses, recommendations, and gaps are first-class output shapes.
- **Reversible decisions.** Components have stable contracts; implementation choices can be swapped without cascading changes.
- **Future multi-agent reuse.** The Phase 1 trace span vocabulary, data shapes, and MCP-boundary patterns are designed to be inheritable; the FinOps agent must still work standalone.

---

## Phase 1 scope decision

**Single analysis type: cost-surprise investigation.**

Justification:

- It is the first scenario listed in [use cases](../use-cases.md) and FR-8 of the [core agent PRD](../prd/core-agent.md).
- It exercises the richest evidence set: cost time-series + baseline comparison + management-plane activity log + resource utilization + (optionally) availability transitions. This puts every component in §4 under real load.
- [AMG-MCP capabilities](../amg-mcp-capabilities.md) lists a clean Phase-1 capability map for it (`cost_analysis`, `query_resource_graph`, `query_resource_metric`, `query_activity_log`, `query_resource_health`) with no overlap against the `pulse_check` open question, which can be deferred to Phase 2 alongside `idle_underused`.
- It produces hypotheses naturally ("cost on service X rose 38% — likely driver: deployment Y on date Z"), giving the facts/hypotheses/recommendations contract a real workout.

**Single output depth.** Engineering-detail markdown (one of the three depths flagged for the future in the [reporting and recommendations PRD](../prd/reporting-and-recommendations.md) FR-15). Executive summary and audit appendix variants are Phase 2.

**Single deployment target.** Local on operator workstation.

**Resource-type whitelist (Phase 1):** PostgreSQL flexible servers, Virtual Machines, App Service plans, AKS — the four cost-significant types with the strongest metric and activity-log coverage in AMG-MCP today.

---

## Component architecture

Ten components, each owning one architectural concern from the [architecture principles](../architecture-principles.md) (modular components with stable contracts). Each carries one or more PRD-level constraints. The component boundaries are the parts of the design intended to be stable across Phase 2+.

### 4.1 `config` — configuration and operator transparency

- **Purpose.** Resolve all run inputs and dependency endpoints from layered sources (flags > env > JSON); construct the `TokenCredential` (§15.9) used for both AMG-MCP and Foundry; tell the operator before each run what data and external services will be touched and which credential is in use.
- **Inputs / outputs.** Raw CLI args + env + config file → `RunConfiguration` (endpoints + resolved `TokenCredential`).
- **Hard constraints.** Operator transparency ([architecture principles](../architecture-principles.md)); [CLI experience PRD](../prd/cli-experience.md) FR-4, FR-9, FR-14 (no secrets logged — raw tokens never echoed or persisted). Credential source and resolved identity surfaced in `RunMetadata.credential_source` (§5.7).
- **Swappable.** Secret store, config file format, credential implementation (§15.9).

### 4.2 `scope` — scope intake and confirmation

- **Purpose.** Validate and normalize the user-supplied analysis scope; reject ambiguous or overly broad scopes early; echo effective scope before any retrieval.
- **Inputs / outputs.** `RunConfiguration` + raw scope inputs → `Scope` (§5.1) and a printed/logged "effective scope" line.
- **Hard constraints.** [Core agent PRD](../prd/core-agent.md) FR-1, FR-2, FR-10, FR-15.

### 4.3 `mcp_client` — AMG-MCP client and capability discovery

- **Purpose.** The only component that knows the MCP transport. Opens the AMG-MCP session, discovers capabilities, dispatches tool calls, enforces a static read-only allowlist of capabilities. Acquires AMG-resource-scoped Entra ID tokens through the injected `TokenCredential` (§15.9) and attaches them as `Authorization: Bearer <token>` on every request; token refresh is handled by the credential's internal cache.
- **Inputs / outputs.** Transport config + `TokenCredential` → `CapabilityCatalog` + invocation function.
- **Hard constraints.** AMG-MCP is the sole boundary ([AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-1); discovery before reliance (FR-2, FR-11); explicit read-only (FR-8 — `dashboard_update` denied; any future mutating tool denied by default); every call wrapped in a trace span (FR-7).
- **Swappable.** Transport (streamable HTTP / SSE) without touching upstream components.

### 4.4 `failure_taxonomy` — failure classifier

- **Purpose.** Translate every raw MCP error into one of eight stable failure classes with user-facing language.
- **Inputs / outputs.** Raw error → `DataQualityFinding` (§5.6) categorized as `auth`, `authz_gap`, `unsupported_capability`, `invalid_scope`, `timeout`, `rate_limit`, `schema_mismatch`, or `empty_result`.
- **Hard constraints.** [AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-6; [core agent PRD](../prd/core-agent.md) FR-13 (failures are first-class findings, never silently dropped).

### 4.5 `fixtures` — fixture and replay layer

- **Purpose.** Record real AMG-MCP responses to local files (sanitized); serve them back later so evaluations don't need live Azure.
- **Inputs / outputs.** `record | replay | off` switch → intercepted MCP responses.
- **Hard constraints.** [AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-12; [evaluation framework PRD](../prd/evaluation-framework.md) FR-4. Sanitization happens at record time; replay is deterministic for evaluation comparability.

### 4.6 `evidence` — evidence retrieval

- **Purpose.** Execute the validated `EvidencePlan` from the planner (§7.4) against `mcp_client`, with back-pressure awareness; produce normalized evidence records with full provenance.
- **Inputs / outputs.** `EvidencePlan` + `CapabilityCatalog` → `EvidenceRecord[]` (§5.2) + `DataQualityFinding[]`.
- **Hard constraints.** Provenance on every record ([core agent PRD](../prd/core-agent.md) FR-4; [AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-5); back-pressure (Cost Management QPU serialization, metric-call batching per [AMG-MCP capabilities](../amg-mcp-capabilities.md)); no fabrication on empty results (FR-10, FR-11).
- **Swappable.** The capability-to-evidence-request mapping is a "playbook" per analysis type — adding a new analysis type adds a playbook without changing the executor.

### 4.7 `reasoning` — reasoning engine

- **Purpose.** Two LLM calls (planner + reasoner) with deterministic glue between them. Produces typed lists of facts, hypotheses, recommendations, and data-quality findings.
- **Inputs / outputs.** `Scope`, `EvidenceRecord[]`, prompts → `ReasoningOutput`.
- **Hard constraints.** [Core agent PRD](../prd/core-agent.md) FR-5 (clean separation of fact/hyp/rec/missing); FR-6 (structured recommendations); FR-7 (no autonomous remediation); FR-9 (surfaced uncertainty); FR-15 (user context kept separate from evidence). Citation discipline: every recommendation cites at least one `EvidenceRecord` by ID.
- **Swappable.** Model provider, prompt source, the orchestration shape inside (subject to the planner/reasoner separation in §7).

### 4.8 `report` — report assembly

- **Purpose.** Render `ReasoningOutput` plus `Scope` and `RunMetadata` into the markdown artifact + a structured JSON sidecar.
- **Inputs / outputs.** Structured object → `report.md` + `run.json`.
- **Hard constraints.** [Reporting and recommendations PRD](../prd/reporting-and-recommendations.md) FR-1..15 (scope at top, executive summary, findings separate from recommendations, evidence references resolvable to trace, data-quality visible).
- **Design choice (recommended).** **Deterministic Jinja templating, no third LLM call.** Trade-off: less prose polish, perfectly reproducible, easy to lint and evaluate, no third place where evidence discipline can be violated. The structured object is the source of truth; the markdown is a view.

### 4.9 `observability` — Langfuse tracing

- **Purpose.** Build, populate, and finalize the Langfuse trace for each run. Manage prompt fetch and versioning. Tag every span with the shared vocabulary (§14).
- **Inputs / outputs.** Component-level events → Langfuse trace ID (or local JSON trace artifact when Langfuse is disabled).
- **Hard constraints.** [Langfuse observability PRD](../prd/langfuse-observability.md) FR-1, FR-2, FR-3, FR-5, FR-6, FR-15. Phase 1 default: local-only Langfuse + summarized tool outputs in spans; full payloads referenced by hash in the local `run.json` artifact.

### 4.10 `cli` — task-oriented CLI

- **Purpose.** Wire everything together as task-oriented commands. Phase 1 commands: `pixiu analyze cost-surprise`, `pixiu diagnose`.
- **Hard constraints.** [CLI experience PRD](../prd/cli-experience.md) FR-1..15.

---

## End-to-end flow

```
                +-----------------+
operator CLI -->| (4.10) cli      |
                +--------+--------+
                         v
                +-----------------+
                | (4.1) config    |  layered: flags > env > file
                +--------+--------+
                         v
                +-----------------+
                | (4.2) scope     |  validate + echo effective scope
                +--------+--------+
                         v
   +-----------------------------------------------------------+
   | (4.9) observability: open trace                           |
   |   span: run.root  metadata: scope, prompt_v, model_cfg    |
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  span: run.capability_discovery                           |
   |   (4.3) mcp_client.list_tools()                           |
   |    -> CapabilityCatalog (mutating tools denied)           |
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  span: run.evidence_planning   [LLM call #1: Planner]     |
   |   inputs: Scope + relevant slice of CapabilityCatalog     |
   |    (NO user free-text context)                            |
   |   output: EvidencePlan (capability + params + intent)     |
   |   deterministic validation against CapabilityCatalog      |
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  span: run.evidence_retrieval                             |
   |   (4.6) evidence.execute(plan):                           |
   |    for each EvidenceRequest:                              |
   |     span: evidence.tool_call.<capability>                 |
   |       (4.5) fixtures? record/replay                       |
   |       (4.3) mcp_client.invoke                             |
   |       (4.4) failure_taxonomy.classify                     |
   |     -> RawEvidence + optional DataQualityFinding          |
   |   normalize: RawEvidence[] -> EvidenceRecord[] + caveats  |
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  span: run.reasoning  [LLM call #2: Reasoner]             |
   |   inputs: Scope, EvidenceRecord[], user_context, DQ[]     |
   |   output: facts[], hypotheses[], recommendations[], DQ[]  |
   |   deterministic post: confidence derivation, citation     |
   |     check, read-only lint, DQ synthesis from discovery    |
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  span: run.report_assembly                                |
   |   (4.8) report: deterministic Jinja -> report.md + run.json|
   +-----------------------------------------------------------+
                         v
   +-----------------------------------------------------------+
   |  (4.9) observability: finalize                            |
   |   attach RunMetadata, recommendation<->evidence links     |
   +-----------------------------------------------------------+
                         v
              report.md  +  run.json  +  trace_id
```

---

## Data shapes (conceptual contracts)

Durable shapes across component boundaries. Types of values shown; serialization format deferred.

### 5.1 `Scope`

| Field | Value type |
|---|---|
| `subscription_ids` | list of Azure subscription GUIDs |
| `resource_group_names` | optional list (sub-RG scoping) |
| `time_window` | inclusive start/end (UTC) |
| `baseline_window` | start/end (required for `cost_surprise`) |
| `analysis_type` | enum: `cost_surprise` (Phase 1); reserve names for `idle_underused`, `quarterly_review`, `cost_telemetry_correlation`, `tagging_hygiene` |
| `resource_type_filter` | optional whitelist |
| `user_context` | optional free-text from operator — **stored separately**, never merged with evidence |
| `effective_scope_summary` | human-readable echo |

### 5.2 `EvidenceRecord`

| Field | Value type |
|---|---|
| `evidence_id` | local opaque ID, cited by findings/hypotheses/recommendations |
| `source_capability` | AMG-MCP tool name |
| `capability_version` | from discovery ([AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-7) |
| `query_intent` | enum: `cost_breakdown`, `inventory`, `utilization`, `activity`, `health`, `metric_definition` |
| `scope_subset` | sub IDs / RG / resource IDs covered |
| `time_window` | start/end |
| `data_freshness` | freshness as reported, when available |
| `payload_ref` | inline (small) or by hash to `run.json` (large) |
| `payload_summary` | normalized summary safe for Langfuse |
| `caveats` | per-record caveats: stale, partial, aggregated, etc. |

### 5.3 `Fact` (observed)

| Field | Value type |
|---|---|
| `fact_id` | local ID |
| `statement` | e.g., "cost on `Microsoft.DBforPostgreSQL` rose 38% vs baseline" |
| `evidence_ids` | non-empty list of `EvidenceRecord.evidence_id` |
| `scope_subset` | which slice |

### 5.4 `Hypothesis` (inferred)

| Field | Value type |
|---|---|
| `hypothesis_id` | local ID |
| `statement` | candidate explanation |
| `confidence` | structured (§9) |
| `supported_by_fact_ids` | list |
| `counter_evidence_fact_ids` | list (if any) |
| `missing_evidence_to_decide` | list of `DataQualityFinding.dq_id` |

### 5.5 `Recommendation`

| Field | Value type |
|---|---|
| `recommendation_id` | local; stable across reruns of same scope |
| `priority` | enum: `high`, `medium`, `low` |
| `confidence` | structured (§9) |
| `impact` | enum category: `material`, `moderate`, `minor`, `unknown` (no precise savings claim — [reporting and recommendations PRD](../prd/reporting-and-recommendations.md) non-goals) |
| `statement` | e.g., "review PostgreSQL flexible servers in RG `db-prod` with sustained CPU < 5% over 14 days" |
| `supported_by_hypothesis_ids` | list |
| `supported_by_fact_ids` | list (recommendations may cite facts directly too) |
| `assumptions` | bullet list |
| `validation_steps` | human-investigative steps, never commands the agent intends to run |
| `false_positive_considerations` | per [reporting and recommendations PRD](../prd/reporting-and-recommendations.md) FR-13 |
| `suggested_audience` | enum: `finops_engineer`, `platform_engineer`, `sre`, `engineering_manager`, `governance` |
| `suggested_human_actions` | plural, framed as proposals |

### 5.6 `DataQualityFinding`

| Field | Value type |
|---|---|
| `dq_id` | local ID |
| `category` | enum: `auth`, `authz_gap`, `unsupported_capability`, `invalid_scope`, `timeout`, `rate_limit`, `schema_mismatch`, `empty_result`, `stale_data`, `partial_coverage`, `tagging_gap`, `missing_telemetry` |
| `affected_capability` | tool name |
| `affected_scope_subset` | which slice was blocked |
| `consequence_for_analysis` | one-line statement |
| `impact_on_recommendations` | list of `recommendation_id` it weakened |
| `actionable_hint` | e.g., "grant Reader on RG X to fill telemetry gap" |

### 5.7 `RunMetadata`

| Field | Value type |
|---|---|
| `run_id` | UUID |
| `trace_id` | Langfuse trace or local-equivalent path |
| `prompt_versions` | `{planner: vN, reasoner: vM}` |
| `model_provider` / `model_name` / `model_config_hash` | strings/hash (e.g., provider=`foundry`, name=`gpt-5.4`) |
| `model_deployment_sku` | Foundry deployment type (`GlobalStandard` / `DataZoneStandard` / regional). Determines where prompts and responses are processed; required for the data-residency record. |
| `credential_source` | `TokenCredential` implementation in use (`AzureCliCredential` / `DefaultAzureCredential` / `ClientSecretCredential` / etc.) and the resolved identity (UPN or service-principal name) for audit. Raw tokens never recorded. |
| `experiment_variant` | optional string |
| `amg_mcp_endpoint` | URL of the remote AMG-MCP server |
| `capability_versions` | map of capability → version snapshot |
| `fixture_id` | when replaying |
| `started_at` / `ended_at` | timestamps |
| `status` | enum: `success`, `partial`, `failed_config`, `failed_analysis` |

---

## Reasoning loop

### 7.1 Execution model (the most important decision)

Three realistic options:

**A. Pure single-pass** — deterministic fetch of a fixed evidence set, then one LLM call to produce findings. Maximally predictable and evaluable; rigid; cannot adapt evidence selection to the requested scope; over-fetches on small scopes.

**B. Plan-then-fetch-then-reason** — LLM #1 proposes an `EvidencePlan` against the discovered capability catalog; deterministic executor runs it; LLM #2 reasons over the collected evidence. Two clean LLM spans; both independently evaluable; the plan is inspectable before any data is fetched (operator-transparency, [architecture principles](../architecture-principles.md)); deterministic executor enforces back-pressure ([AMG-MCP integration PRD](../prd/amg-mcp-integration.md) NFR); replay-friendly.

**C. Tool-using agent loop** — model is given AMG-MCP capabilities as tools and iterates. Maximum flexibility; fights every Phase 1 constraint — hard to bound, hard to evaluate (variable trajectories on the same dataset item, breaking [core agent PRD](../prd/core-agent.md) FR-14), hard to enforce evidence discipline, hard to back-pressure, hard to replay deterministically.

**Phase 1 default: B (plan-then-fetch-then-reason).** Rationale: separates "what evidence to seek" from "what conclusions to draw" — two responsibilities that should not collapse into one LLM call. Each step independently evaluable per [Langfuse observability PRD](../prd/langfuse-observability.md) FR-10. Deterministic between the LLM calls means back-pressure, fixtures, and read-only enforcement are all in code, not in prompt text. Option C is deferred to Phase 2+ once datasets and rubrics exist to detect "agent went shopping for evidence" failure modes.

### 7.2 Phases

Each phase is either deterministic code or an LLM call; the boundary is intentional.

| # | Phase | Kind | Inputs | Outputs |
|---|---|---|---|---|
| 1 | Scope intake | det. | CLI args + env + config | `Scope` |
| 2 | Scope confirmation | det. | `Scope` | printed effective-scope line + trace event ([core agent PRD](../prd/core-agent.md) FR-2) |
| 3 | Capability discovery | det. + MCP | `RunConfiguration` | `CapabilityCatalog`; **fail fast if required capabilities missing** |
| 4 | Evidence planning | LLM #1 | `Scope` + relevant subset of `CapabilityCatalog` (no `user_context`) | `EvidencePlan` (structured output, Zod-validated against `CapabilityCatalog`) |
| 5 | Evidence retrieval | det. | validated `EvidencePlan` + transport | `RawEvidence[]` + classified failures |
| 6 | Evidence normalization | det. | `RawEvidence[]` | `EvidenceRecord[]` with caveats |
| 7 | Reasoning | LLM #2 | `Scope`, `EvidenceRecord[]`, `user_context` (labeled), DQ observations | facts/hypotheses/recommendations/DQ (structured) |
| 8 | Confidence + DQ synthesis | det. | LLM output + capability gaps | finalized structured object with derived confidence headlines and synthesized DQ findings the LLM may have missed |
| 9 | Report assembly | det. | structured object + scope + metadata | `report.md` + `run.json` |
| 10 | Run metadata recording | det. | everything | trace ID written into report footer |

### 7.3 Why user free-text context goes to the reasoner only

The planner sees `Scope` + capabilities only. The reasoner additionally sees `user_context` as a **labeled, separate field**. This satisfies [core agent PRD](../prd/core-agent.md) FR-15 in code, not just in prompt text: the planner cannot have its evidence selection biased by free-text, and the reasoner has the context to interpret findings without confusing it with retrieved evidence. The reasoner's system message states explicitly: "`user_context` is hypothesis-shaping context. Never cite `user_context` as supporting evidence for a recommendation."

### 7.4 EvidencePlan validation

The planner returns a list of `EvidenceRequest{capability, parameters, intent, expected_role}`. Before retrieval:

- Every `capability` must exist in `CapabilityCatalog` ([AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-11 — no inferred capabilities).
- Every `parameters` payload must satisfy the discovered schema.
- Every `capability` must be in the static read-only allowlist (§12).

Validation failure triggers one repair pass: the planner is re-prompted with the validation error. A second failure is a hard `failed_analysis` exit with the bad plan captured in the trace for debugging.

### 7.5 Reasoner output enforcement

After LLM #2 returns its structured object, deterministic post-processing enforces:

- **Citation completeness.** Every recommendation has a non-empty `supported_by_hypothesis_ids ∪ supported_by_fact_ids`. Uncited recommendations are dropped and a `failed_analysis` DQ finding is emitted.
- **Citation validity.** Every cited ID exists in the LLM's own facts/hypotheses output. Dangling citations trigger one repair pass.
- **No fabricated numbers.** Any numeric figure in a fact's `statement` must appear in the cited `EvidenceRecord.payload`. Numbers without provenance are stripped and a DQ finding is emitted.
- **Read-only lint.** Recommendation prose is scanned for imperative commands ("run", "delete", "scale", "restart" in commanding voice without "consider/review/investigate" framing). Matches trigger a repair pass.
- **Confidence derivation.** The `confidence.level` headline is recomputed from the structured dimensions (§9), overriding what the LLM emitted. This prevents over-confidence drift.

---

## Prompt strategy

### 8.1 Two prompts, not one mega-prompt

Phase 1 ships two production prompts: `planner` and `reasoner`. Single-mega-prompt is rejected because it collapses two evaluable responsibilities into one span. Many-small-prompts (e.g., per-evidence-record reasoning then synthesis) is deferred to Phase 2 — adds token cost and trace complexity without a Phase 1 win.

### 8.2 System message contents (both prompts)

Encode architectural constraints as behavior:

- **Read-only rule.** "You may suggest human investigation steps. You may NOT propose commands that imply the agent will execute changes. You may NOT use imperative language that implies remediation has been performed."
- **Evidence discipline.** "Every claim must cite at least one EvidenceRecord by id. Numeric figures must come from cited records. Do not introduce resource names, metric values, or costs not present in the evidence."
- **Calibrated uncertainty.** "Use the confidence taxonomy in §9 exactly as defined. If evidence is insufficient for a recommendation, output a data-quality finding instead."
- **Scope honesty.** "Reason only about resources within the scope provided. Do not extrapolate."
- **User context separation** (reasoner only). "The `user_context` field contains user-supplied notes. Treat it as hypothesis-shaping context, never as evidence."

### 8.3 Structured output

Options:

- **A.** Freeform text + parser. Brittle. Rejected.
- **B.** JSON mode + manual schema check. Workable but lets shape drift.
- **C. (recommended)** Provider strict-JSON-Schema mode (`response_format: json_schema` with `strict: true` on Foundry-hosted GPT-5 family) + Zod validation. Belt-and-braces. The OpenAI SDK's `zodResponseFormat` helper accepts a Zod schema directly and emits the JSON Schema Foundry expects; the same Zod schema then validates the response client-side and produces a compile-time-typed value via `z.infer<>`. Anthropic tool-use schema is the equivalent if the provider is swapped.
- **D.** Function calling as schema carrier. Equivalent to C in practice.

**Phase 1 default: C.** Validation failure triggers one repair round; a second failure is captured as a first-class finding.

### 8.4 Few-shot vs zero-shot

- **Planner: zero-shot.** Output is highly schema-constrained; structured-output enforcement supplies the shape; few-shot mostly adds tokens.
- **Reasoner: 1–2 worked examples** showing evidence-citation discipline, the confidence taxonomy in use, and a well-stated DQ finding.

In Phase 2 those examples become dataset items ([Langfuse observability PRD](../prd/langfuse-observability.md) FR-7) — examples good enough to ship are good enough to grade against.

### 8.5 Prompt versioning

Options:

- **A.** Prompts as code in repo, no Langfuse linkage. Fails [Langfuse observability PRD](../prd/langfuse-observability.md) FR-6.
- **B.** Langfuse-managed only. Loses PR-review of prompt changes.
- **C. (recommended)** Prompts as files in repo; on agent startup or via a sync script, mirror to Langfuse; record the Langfuse prompt-version ID on every trace. Repo is source of truth; Langfuse provides trace linkage and experiment surface. Sync is one-way to avoid drift.

Phase 2 may move source-of-truth to Langfuse-managed once prompt experiments become a primary development activity.

---

## Confidence taxonomy

The [core agent PRD](../prd/core-agent.md) lists this as an open question. Options:

- **Numeric 0..1.** False precision; hard for humans to calibrate.
- **Three-tier categorical.** Easy for humans; hides the *why*.
- **Structured composite.** Rich; hard at a glance.
- **Hybrid (recommended).** Structured composite with a derived categorical headline.

**Phase 1 default:**

```
confidence:
  level: low | medium | high             # derived headline
  rationale: short prose explanation
  dimensions:
    evidence_coverage:  partial | adequate | strong
    signal_quality:     weak | mixed | strong
    signal_agreement:   conflicting | mixed | aligned
```

**Derivation rule (deterministic, post-LLM):**

- `high` if coverage = strong AND quality = strong AND agreement = aligned.
- `low` if any of (coverage = partial, quality = weak, agreement = conflicting).
- `medium` otherwise.

The headline serves humans ([reporting and recommendations PRD](../prd/reporting-and-recommendations.md) FR-12: calibrated terms). The dimensions are categorical and machine-comparable for evaluations ([Langfuse observability PRD](../prd/langfuse-observability.md) FR-11). The derivation is in code, so the LLM cannot label something "high" when its own dimensions say otherwise.

---

## Output and report structure

### 10.1 Fact / hypothesis / recommendation separation

Options: three flat lists; one list with a `kind` discriminator; hierarchical with citations.

**Phase 1 default: hierarchical with explicit citations.** Recommendations cite hypotheses and/or facts; hypotheses cite facts. The citation graph itself is captured in trace metadata ([Langfuse observability PRD](../prd/langfuse-observability.md) FR-3) and embedded in the report.

### 10.2 Markdown report layout

```
# Az-Pixiu Cost-Surprise Report

## Scope & Data Sources
  (from Scope + capability catalog)

## Executive Summary
  one paragraph; surfaces critical caveats (FR-2 reporting)

## Recommendations
  for each recommendation (sorted by priority then confidence):
    - title, severity, confidence headline + dimensions
    - suggested human actions (plural, plain-English)
    - validation steps
    - false-positive considerations
    - assumptions
    - cited evidence (hypothesis IDs + fact IDs, with one-line statements)

## Hypotheses
  for each hypothesis: statement, supporting facts, counter-evidence, confidence

## Observed Facts (appendix-like)
  for each fact: statement, evidence record IDs, trace span IDs

## Data Quality
  for each DQ finding: category, affected scope, consequence, actionable hint,
                       which recommendations it weakened

## Run Metadata Footer
  trace_id, prompt versions, model id, capability versions, fixture id
```

---

## Missing-evidence handling

Default posture across all cases: **produce bounded analysis with calibrated caveat**, via a `DataQualityFinding` that explicitly names which recommendations it weakened. Clean failure is reserved for cases where partial analysis would mislead regardless of caveat.

| Scenario | Phase 1 default |
|---|---|
| Cost data present, telemetry missing | Bounded: produce recommendations that depend only on cost + resource metadata; DQ `missing_telemetry`; `signal_agreement` capped at `mixed`. (Resolves an open question in [core agent PRD](../prd/core-agent.md).) |
| Capability unavailable (`authz_gap` / `unsupported_capability`) | Skip that evidence stream; recommendations that *required* that signal are not produced. Silence is better than speculation. |
| Stale or inconsistent data | Normalizer attaches caveat; deterministic step downgrades `signal_quality`; recommendations relying on the stale slice have their headline downgraded. |
| Tags missing for grouping | DQ `tagging_gap` quantifying untagged cost. Recommendations depending on owner/cost-center grouping include an explicit assumption; confidence reduced. |
| Scope too broad for budget | Surfaced at scope-confirmation (§4.2) before any retrieval. Refuse with a narrowing suggestion (e.g., "top 10 RGs by cost"); do not silently truncate. |
| Required capability absent | Fail fast at capability-discovery (§7.2 step 3). The exception to "always produce bounded analysis." |

---

## Read-only enforcement (defense in depth)

Read-only is architecturally load-bearing. Six layers:

1. **MCP capability allowlist (boundary).** Static list of capabilities the executor may call. Any capability whose name/schema indicates mutation is excluded — even if AMG-MCP advertises it. Phase 1 deny list: `dashboard_update`. Future mutating tools denied by default.
2. **Planner validation (LLM output).** Rejects any planner request that names a capability outside the allowlist.
3. **System message language (model).** Both prompts state the read-only contract with examples of disallowed phrasing.
4. **Output schema (reasoner).** The schema field is `suggested_human_actions[]` (plural, plainly for humans), not `actions_to_execute[]`. The schema name shapes LLM output.
5. **Output linter (post-hoc).** Deterministic scan for imperative-mode commands. Matches trigger repair or downgrade.
6. **No Azure SDK in the agent process.** Repo layout enforces the boundary; exceptions require explicit documentation per [AMG-MCP positioning](../amg-mcp-positioning.md).

---

## Replay / fixture seams

Two clean seams keep evaluation runs and live runs on the same code path:

- **`MCPTransport` interface.** `LiveMCPTransport` vs. `FixtureMCPTransport`. Fixtures keyed by `(capability_name, parameters_digest)`. Sanitization at record time per [Langfuse observability PRD](../prd/langfuse-observability.md) FR-5.
- **`ModelClient` interface.** Real provider vs. recorded-response replay (narrow tests where model nondeterminism must be removed).

A dataset item is `(ScopeRequest, fixture_id)`. `fixture_id` is recorded on the trace so eval runs are distinguishable from live runs.

---

## Failure mode taxonomy

| Class | Behavior | Output |
|---|---|---|
| `auth` | **Fail the run** with config-failure exit. | DQ + actionable hint to diagnostics. |
| `authz_gap` | **Bounded analysis** for accessible slices; mark the rest inaccessible. | DQ per scope; report notes reduced coverage. |
| `unsupported_capability` | **Bounded analysis;** skip that signal; warn confidence is lower. | DQ; routed to product backlog (FR-13). |
| `invalid_scope` | **Fail.** Scope intake should have caught most. | CLI exit non-zero; no recommendation. |
| `timeout` | One retry with smaller scope if possible; otherwise bounded. | DQ; report notes missing slice. |
| `rate_limit` | Backoff with jitter, capped retries; serialize across subs. | DQ noting QPU/rate-limit pressure. |
| `schema_mismatch` | Fail that call, continue overall. Treat downstream as `empty_result`. | DQ flagged for maintainer (version drift). |
| `empty_result` | Continue. Empty is legitimate. | DQ only if the playbook expected non-zero coverage. |

---

## AMG-MCP capabilities for Phase 1

Per [AMG-MCP capabilities](../amg-mcp-capabilities.md). The cost-surprise playbook calls:

| Capability | Use |
|---|---|
| `query_azure_subscriptions` | Verify scope is reachable. |
| `cost_analysis` | Cost breakdown for time window + baseline. Serialized per subscription. |
| `query_resource_graph` | Top cost-bearing resources by type in scope; tags; ownership signals. |
| `query_resource_metric_definition` | Confirm metrics exist for whitelisted resource types. |
| `query_resource_metric` | Batched utilization (FULL interval for sweep, finer intervals for top-N suspects). Batch up to 100 IDs × 20 metrics per call. |
| `query_activity_log` | Deployments, scale ops, RBAC changes overlapping the surprise window. |
| `query_resource_health` | Availability transitions that may explain the shift. |

**Explicitly excluded from Phase 1:** `pulse_check` (Phase 2, when `idle_underused` is added and the wrap/compose/duplicate question is resolved); `kusto_query`, `mssql_query`, `prometheus_*`, `query_resource_log`, `query_application_insights_trace`, `insights_*`, `datasource_list` (don't pay for themselves at Phase 1 scope; widen redaction surface); `dashboard_*` (read tools unused; `dashboard_update` denied).

---

## Trace span vocabulary (shared)

Designed to be the inheritable schema for future agents ([future multi-agent platform PRD](../prd/future-multi-agent-platform.md) FR-3; [Langfuse observability PRD](../prd/langfuse-observability.md) FR-15).

```
run.root                                  [trace]
  metadata:
    agent.name = az-pixiu
    agent.domain = finops
    analysis.type = cost_surprise
    scope.subscription_ids
    scope.time_window
    scope.baseline_window
    prompt.versions = {planner: vN, reasoner: vM}
    model.provider, model.name, model.config_hash, model.deployment_sku
    credential.source, credential.identity
    experiment.variant (optional)
    fixture.id (optional)
    capability.versions (object)
    status = success | partial | failed_*
│
├── run.config_resolution            [span]
├── run.scope_intake                  [span]   output: Scope
├── run.capability_discovery          [span]
│       event: mutating_capabilities_excluded
├── run.evidence_planning             [span]
│   └── reasoning.model_call          [generation]  attr: prompt.version, tokens
├── run.evidence_retrieval            [span]
│   ├── evidence.tool_call.cost_analysis            [span]
│   ├── evidence.tool_call.query_resource_graph     [span]
│   ├── evidence.tool_call.query_resource_metric    [span]
│   ├── evidence.tool_call.query_activity_log       [span]
│   └── evidence.tool_call.query_resource_health    [span]
├── run.reasoning                     [span]
│   ├── reasoning.prompt_fetch        [span]
│   ├── reasoning.model_call          [generation]
│   └── reasoning.normalize           [span]   output: counts of facts/hyp/rec/DQ
├── run.report_assembly               [span]
└── run.finalize                      [span]
      event: recommendations_evidence_links  (rec_id -> [fact_id|hyp_id])
```

The stable vocabulary points (future agents reuse exactly): `run.root`, `run.config_resolution`, `run.scope_intake`, `run.capability_discovery`, `run.evidence_planning`, `run.evidence_retrieval`, `run.reasoning`, `run.report_assembly`, `run.finalize`; `evidence.tool_call.<capability>`; `reasoning.prompt_fetch`, `reasoning.model_call`, `reasoning.normalize`. Future reliability/capacity/governance agents reuse every name above except the playbook contents inside `run.evidence_retrieval`.

---

## Option sets for deliberately-open tech decisions

For each, 2–3 realistic options with trade-offs and a recommended Phase 1 default. Recommendations are anchored in the constraints; alternatives are listed because the principles say these decisions should remain reversible.

### 15.1 Language

Neither AMG-MCP nor Microsoft Foundry constrains client language — both are language-agnostic over HTTP. The choice rests on client-side ecosystem fit against this design's specific shape.

| Option | Trade-offs |
|---|---|
| **TypeScript / Node** ✅ | Compile-time typing across §5's many data-shape contracts and the strictly-typed LLM IO boundaries in §7.4 / §7.5; Zod provides the runtime validation layer and the OpenAI SDK accepts Zod schemas directly for strict-JSON-Schema responses (`zodResponseFormat`), with `z.infer<>` yielding the compile-time type from the same source of truth; first-class MCP and OpenAI SDKs; `@azure/identity` handles Entra ID identically to Python's `azure-identity`. Trade-off: Langfuse TS SDK lags Python on day-to-day tracing ergonomics (`@observe`-style decorators, broader auto-instrumentation wrappers) — but for the evaluation surface that matters in Phase 2, most of Langfuse's value (LLM-as-judge templates, online evaluators, human annotation, score aggregation) lives server-side and is language-neutral. The tracing-ergonomics gap closes with one well-written tracing helper. |
| Python | Most feature-complete Langfuse SDK; Microsoft's documented Foundry pattern for strict-JSON-Schema outputs is Pydantic-native; broadest agent-framework ecosystem; `@observe` decorator gives nicer day-to-day tracing ergonomics. Trade-off: no compile-time typing on the structured-output and component-boundary contracts that dominate this design; relies entirely on runtime validation for safety. |
| .NET | Native Azure tooling fit. Trade-off: smallest MCP/Langfuse ecosystem in early 2026. |

**Phase 1 default: TypeScript.** The design has 10+ data-shape contracts (§5), two strictly-typed LLM IO boundaries (§7.4 planner output, §7.5 reasoner output), and many cross-component handoffs — compile-time typing pays for itself across that surface. The Langfuse SDK gap is real but concentrated in tracing ergonomics, not evaluation capability; closing it is straightforward glue work. Pydantic's asymmetric advantage on Foundry strict-JSON-Schema shrinks once Zod is the validation layer, since the OpenAI SDK accepts Zod schemas natively.

### 15.2 Agent framework / orchestration

| Option | Trade-offs |
|---|---|
| **Raw model SDK + manual orchestration** ✅ | Smallest dependency surface; exact control over spans, retries, schema. The two-LLM-call loop in §7 is small enough to write directly. Maximally reversible. |
| Mastra / OpenAI Agents SDK (TS) | TypeScript-native agent frameworks with tool-use, state, and OTEL hooks. Trade-off: opinionated abstractions for a two-LLM-call loop that's small enough to write directly; couples component shape to a framework before the loop has proved itself. |
| LangGraph | State machine; community examples. Trade-off: opinionated abstractions; risks coupling architecture to LangGraph idioms before Phase 1 has proved the loop shape. |
| Foundry Agents Service | Hosted agent runtime in the same Azure tenant; capability discovery, state, and tool wiring are server-side. Trade-off: orchestration moves out of the agent, which is incompatible with the §7.5 deterministic enforcement and the fixture-replay seam (§13); also not local-first in the strict sense. |

**Phase 1 default: raw model SDK.** Framework lock-in this early is a premature commitment ([architecture principles](../architecture-principles.md) *reversible decisions*). Affects only the `reasoning` component (§4.7).

### 15.3 Model provider

| Option | Trade-offs |
|---|---|
| **Microsoft Foundry — OpenAI gpt-5.4** ✅ | Same Azure tenant as AMG-MCP and the source data; one shared `TokenCredential` (§15.9) covers both boundaries — the `AzureOpenAI` client accepts the credential directly via `azureADTokenProvider` (scope `https://cognitiveservices.azure.com/.default`), and the same credential mints AMG-MCP tokens with the Managed Grafana resource scope; first-class strict JSON Schema (`response_format: json_schema`, `strict: true`) for the §8.3 structured-output pipeline, accepting Zod schemas directly through the OpenAI SDK; operator already has access through their Azure environment. Trade-off: data-residency depends on the deployment SKU — `GlobalStandard` may process anywhere, `DataZoneStandard` stays in US or EU, regional pins to one location ([Foundry deployment types](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/deployment-types)). The chosen SKU must be surfaced through `config` (§4.1) and recorded in `RunMetadata.model_deployment_sku` (§5.7) before each run. |
| Claude via Anthropic API | Strong tool-use and calibration-on-uncertainty behavior; established Langfuse integration. Trade-off: genuinely external — sensitive Azure telemetry summaries cross a tenant boundary; operator opt-in required and surfaced in CLI before each run. |
| Local model (Ollama / llama.cpp) | Strict-local — no model call leaves the workstation. Trade-off: Phase 1 quality on strict JSON Schema adherence and FinOps-domain reasoning is meaningfully below frontier; risks missing the "useful enough to act on" bar ([goals](../goals.md)). |

**Phase 1 default: Foundry-hosted gpt-5.4.** The combination of (a) the inference path staying in the operator's Azure tenant, (b) one Entra ID identity covering both AMG-MCP and the model endpoint, and (c) first-class strict-JSON-Schema support for the §8.3 enforcement layer is materially aligned with this project's constraints — meaningfully more so than the previous Anthropic-default recommendation. The `ModelClient` interface (§13) keeps the choice swappable; Claude or local is a single-component change.

**Do not use Foundry's built-in MCP tool plumbing.** Foundry's Responses API can call MCP servers as model-driven tools, but that is the tool-using agent loop (Option C in §7.1) — the loop this design explicitly rejected for Phase 1. In this architecture the model receives a `CapabilityCatalog` slice as **data** and emits an `EvidencePlan`; the agent dispatches MCP calls in deterministic code. That separation is what enables citation enforcement (§7.5), back-pressure (§4.6), fixture replay (§13), and the planner-validation read-only allowlist (§12 layer 2). Re-introducing model-driven MCP tool calls would erode all four.

### 15.4 MCP transport

AMG-MCP is a remote MCP server hosted by Azure Managed Grafana. Az-Pixiu connects to it over the network; there is no local subprocess to launch. The transport choice is therefore among the HTTP-based MCP transports the server exposes, not whether to run the server locally.

| Option | Trade-offs |
|---|---|
| **Streamable HTTP** ✅ | Current MCP spec direction; single endpoint; bidirectional. The expected primary transport for new remote MCP servers. |
| SSE | Earlier remote MCP transport. May remain available as a compatibility option but is superseded for new clients. |

**Phase 1 default: streamable HTTP**, falling back to whatever transport AMG-MCP currently exposes as primary. The choice is constrained by the server, not by Az-Pixiu. Swap is a single-component change in `mcp_client` (§4.3).

**Auth handoff.** Az-Pixiu authenticates *to* the MCP server using a Microsoft Entra ID bearer token, acquired from the shared `TokenCredential` (§15.9) with scope `ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default` (the Azure Managed Grafana app ID, per the [AMG-MCP server docs](https://learn.microsoft.com/azure/managed-grafana/grafana-mcp-server)). The token is attached as `Authorization: Bearer <token>` on every streamable-HTTP request. The server holds the Azure credentials it uses internally to reach Cost Management, Resource Graph, and Azure Monitor — the agent never holds those directly. The `auth` failure class in §11 covers failures at the agent→AMG-MCP boundary (no `az login`, expired CLI cache, identity has no Grafana RBAC role); downstream Azure auth issues surface as `authz_gap` or `unsupported_capability` from the server. The Grafana service-account-token (`glsa_xxx`) path is supported as a fallback (§15.9) but is not the default, since Entra ID keeps the credential surface unified with Foundry.

**Local-first implication.** AMG-MCP is a managed Azure resource that operators already own in their own tenant. The agent runs on the operator's workstation; sensitive cloud telemetry flows operator-tenant → operator-workstation, not through any Az-Pixiu-operated service. The local-first principle is preserved even though the MCP server is remote.

### 15.5 Prompt storage

| Option | Trade-offs |
|---|---|
| **Files in repo with Langfuse sync** ✅ | Prompts diff in PR review; reproducible; Langfuse gives trace-attribution and experiment surface. Sync is one-way (repo → Langfuse) to avoid drift. |
| Langfuse-managed only | Loses PR-review of prompt changes. |
| Inline strings | Violates [Langfuse observability PRD](../prd/langfuse-observability.md) FR-6. Rejected. |

**Phase 1 default: files in repo, sync to Langfuse.** Phase 2 (Langfuse depth) is when source-of-truth moves to Langfuse-managed.

### 15.6 Local storage

| Option | Trade-offs |
|---|---|
| **Plain JSON in `runs/`** ✅ | One folder per run holds `report.md`, `run.json` (`RunMetadata` + full evidence payloads), `trace.json` (when Langfuse local-equivalent). Easy to diff. No schema commitment ahead of need. |
| SQLite | Indexed cross-run queries. Trade-off: schema decision before data shapes are stable. Attractive in Phase 2 once evaluations need aggregation. |
| None / stateless | Cannot diff reruns ([core agent PRD](../prd/core-agent.md) FR-14 needs persistence). |

**Phase 1 default: plain JSON in `runs/`.**

### 15.7 Packaging

| Option | Trade-offs |
|---|---|
| **Repo-clone-and-run + `pnpm`** ✅ | Phase 1 audience is the project authors and AI-observability-learner persona ([use cases](../use-cases.md)) — both will clone the repo. CLI entry point ships as a `package.json` `bin`. |
| npm package (npm registry) | Standard distribution. Trade-off: distribution-readiness adds work without Phase 1 audience demand. |
| Container image | Reproducibility; isolates dependencies. Trade-off: heavier; adds packaging overhead before the Phase 1 audience needs it. Phase 3+. |

**Phase 1 default: repo-clone-and-run with `pnpm`.**

### 15.8 Configuration

| Option | Trade-offs |
|---|---|
| **Layered: flags > env > JSON > defaults** ✅ | Secrets in env; non-secret defaults in `az-pixiu.json`; per-run scope on flags. Matches [CLI experience PRD](../prd/cli-experience.md) FR-2 + FR-14. |
| Env vars only | Twelve-factor; poor for layered settings. |
| CLI flags only | Most explicit; noisy for common case. |

**Phase 1 default: layered.**

**File format: JSON.** Symmetric with the rest of the on-disk surface (`run.json`, `package.json`, fixture files) and zero-dependency in Node. The same Zod schema (§8.3, §15.1) that validates other structured shapes validates `az-pixiu.json` directly, with `z.infer<>` producing the typed `RunConfiguration`. A `$schema` pointer at the top of the file gives operators editor autocomplete and inline validation with no extension installed. The cost is the lack of inline comments — mitigated by a documented `az-pixiu.example.json` and per-field prose in the README. TOML was considered for the comment affordance but rejected because it adds a parser dependency, breaks the JSON-everywhere symmetry, and duplicates documentation that the example file and README already carry. If hand-edit comments later prove load-bearing, JSONC is a single-component swap in `config` (§4.1).

### 15.9 Azure credential and token acquisition

Both Azure-resident dependencies — AMG-MCP and Microsoft Foundry — accept Microsoft Entra ID bearer tokens. Az-Pixiu uses a single `TokenCredential` from `@azure/identity` (resolved in `config`, §4.1) to mint scope-specific tokens for each boundary. One credential, two scopes, one identity recorded on the trace.

| Option | Trade-offs |
|---|---|
| **`AzureCliCredential`** ✅ | Uses the `az` CLI's cached token; matches how operators interactively manage Azure access on a workstation; no secrets in env or config files. Trade-off: requires `az login` ahead of time; not suitable for headless/CI runs. |
| `DefaultAzureCredential` | Tries env vars, managed identity, Azure CLI, etc. in order. Right choice for headless runs. Trade-off: resolution-order surprises unless the chosen source is logged. |
| `ClientSecretCredential` / `ClientCertificateCredential` | Deterministic service-principal credential, suitable for CI. Trade-off: secret hygiene. |
| Grafana service account token (`glsa_xxx`) — AMG-MCP only | The fallback the AMG-MCP docs describe. Trade-off: AMG-MCP-only — does not authenticate Foundry; splits the credential surface. |

**Phase 1 default: `AzureCliCredential`.** The audience is local operators running against their own subscriptions; `az login` is already part of their workflow. Switching to `DefaultAzureCredential` or a service principal is a single-line change in `config`; the rest of the design depends on the `TokenCredential` interface, not the implementation.

**Token scopes** — one credential, two resource scopes:

| Boundary | Scope |
|---|---|
| AMG-MCP | `ce34e7e5-485f-4d76-964f-b3d2b16d1e4f/.default` (the Azure Managed Grafana app ID, per the [AMG-MCP server docs](https://learn.microsoft.com/azure/managed-grafana/grafana-mcp-server)) |
| Foundry OpenAI | `https://cognitiveservices.azure.com/.default` |

The `AzureOpenAI` client takes the credential directly via `azureADTokenProvider` (built with `getBearerTokenProvider(credential, scope)`), which handles refresh internally. The MCP client (§4.3) calls `credential.getToken(amgScope)` and attaches the bearer token as `Authorization: Bearer <token>` on the streamable-HTTP transport; the credential's internal cache prevents repeated CLI invocations across requests within a run.

**Operator transparency.** Before each run, the CLI (§4.10) prints the credential source and the resolved identity (UPN or service-principal name); raw tokens are never logged. The same identity is recorded on `RunMetadata.credential_source` (§5.7) and on the trace root span (§14) so runs are attributable.

---

## What Phase 1 deliberately leaves to later

- **Additional analysis types** (`idle_underused`, `quarterly_review`, `cost_telemetry_correlation`, `tagging_hygiene`). Wired up after Phase 1 validates the architecture.
- **`pulse_check` overlap decision.** Resolved when `idle_underused` is added in Phase 2 — wrap, compose, or duplicate. Phase 1 sidesteps by picking cost-surprise.
- **Evaluation datasets at scale.** Phase 1 produces fixtures from real runs ([AMG-MCP integration PRD](../prd/amg-mcp-integration.md) FR-12) so Phase 2 starts with material; curated datasets and human-review workflows wait.
- **Prompt experiments at scale.** Phase 1 has one prompt version per role; experiments-as-development-practice is Phase 2.
- **Cross-run comparison UI.** File-by-file diff in `runs/` suffices for Phase 1; SQLite-backed comparison is Phase 2.
- **Multiple report depths.** Engineering-detail only in Phase 1; executive and audit-appendix variants are Phase 2 ([reporting and recommendations PRD](../prd/reporting-and-recommendations.md) FR-15).
- **Reservation, savings plan, budget, forecast, Advisor coverage.** Not exposed by AMG-MCP today ([AMG-MCP capabilities](../amg-mcp-capabilities.md)); capability-gap findings only.
- **Interactive follow-up mode.** Out of scope for Phase 1 CLI.
- **OTEL integration alongside Langfuse SDK.** Phase 2+.
- **Human-disposition feedback loop.** Phase 2+.
- **Tool-using agent loop (Option C of §7.1).** Deferred until rubrics exist to detect "agent went shopping for evidence."
- **LLM-assembled prose for the report.** Deterministic templating in Phase 1; revisit if user feedback says output reads stilted.

---

## Implementation sequencing

Defensible build order; each step independently testable. Stages 1–6 require no live Azure dependency, honoring local-first / observable-by-construction from day one.

1. Zod schemas for `Scope`, `EvidencePlan`, `EvidenceRecord`, `ReasoningOutput`, `DataQualityFinding`, `RunMetadata`, with TypeScript types derived via `z.infer<>`. No logic.
2. `MCPTransport` interface + `FixtureMCPTransport`. Hand-author 1–2 fixtures from real AMG-MCP responses (sanitized).
3. Capability discovery + the static required-capability map for `cost_surprise`. `mcp_client` skeleton.
4. Deterministic executor (`evidence`) against fixtures; full failure classification (`failure_taxonomy`).
5. Evidence normalizer with caveats.
6. Reasoner prompt v1 + structured-output call + Zod validation + citation enforcement; runs end-to-end against normalized fixture evidence with a **hardcoded plan** (isolates reasoner quality from planner quality).
7. Planner prompt v1; replace the hardcoded plan with planner output; planner-output validation against capability catalog; one repair pass.
8. Confidence derivation + DQ post-processing + output linter for read-only enforcement.
9. Jinja markdown templating; `run.json` sidecar; trace_id in report footer.
10. Langfuse integration: spans (the §14 vocabulary), prompt sync, RunMetadata, redaction.
11. `LiveMCPTransport` against a real AMG-MCP instance. Smoke test on a controlled scope (single subscription, 7-day window, single RG).
12. First eval dataset (3–5 fixture-based items) + a minimal scoring rubric: structural correctness, evidence-citation completeness, confidence-derivation consistency, read-only language adherence.

---

## Verification

End-to-end checks to confirm Phase 1 is real:

- **Fixture-only run:** `pixiu analyze cost-surprise --fixture <id>` produces `report.md` + `run.json` + a local trace; all DQ findings expected by the fixture are present; recommendations cite evidence IDs that exist in `run.json`.
- **Live run on a controlled scope:** single subscription, narrow time window, an RG the operator knows. Confirm:
  - Effective scope is echoed before retrieval begins.
  - The trace shows the full §14 span tree with capability versions populated.
  - All seven Phase 1 AMG-MCP capabilities are exercised (or absent ones surface as DQ findings, not silent gaps).
  - Read-only lint: report contains no imperative remediation language; `dashboard_update` does not appear in the trace.
  - Citation integrity: every recommendation cites at least one fact or hypothesis; every cited ID resolves.
- **Repeat-run reproducibility** ([core agent PRD](../prd/core-agent.md) FR-14): running the same scope twice produces structurally consistent output; differences localize to non-deterministic prose, not facts/citations/DQ findings.
- **Capability-version drift:** force a `schema_mismatch` (e.g., via a doctored fixture); confirm a DQ finding is emitted and the report does not silently use the corrupt data.
- **Read-only enforcement:** add a hypothetical mutating capability to a fixture's tool list; confirm `mcp_client` denies it at discovery and emits the `mutating_capabilities_excluded` trace event.
- **One eval dataset item scores green** on structural correctness, evidence-citation completeness, confidence-derivation consistency, and read-only adherence.

---

## Critical files

There is no source code yet. Implementation begins from these documentation anchors:

- [architecture principles](../architecture-principles.md)
- [goals](../goals.md)
- [roadmap](../roadmap.md)
- [use cases](../use-cases.md)
- [AMG-MCP positioning](../amg-mcp-positioning.md)
- [AMG-MCP capabilities](../amg-mcp-capabilities.md)
- [Langfuse learning goals](../langfuse-learning-goals.md)
- [core agent PRD](../prd/core-agent.md)
- [AMG-MCP integration PRD](../prd/amg-mcp-integration.md)
- [Langfuse observability PRD](../prd/langfuse-observability.md)
- [reporting and recommendations PRD](../prd/reporting-and-recommendations.md)
- [CLI experience PRD](../prd/cli-experience.md)
- [evaluation framework PRD](../prd/evaluation-framework.md)
- [future multi-agent platform PRD](../prd/future-multi-agent-platform.md)

New files Phase 1 will create (proposed; subject to language/packaging choice in §15.1, §15.7):

- `src/config.ts`, `src/scope.ts`, `src/mcp-client.ts`, `src/failure-taxonomy.ts`, `src/fixtures.ts`, `src/evidence.ts`, `src/reasoning.ts`, `src/report.ts`, `src/observability.ts`, `src/cli.ts`
- `src/schemas.ts` (Zod schemas for §5 data shapes, with `z.infer<>` type exports)
- `prompts/planner.v1.md`, `prompts/reasoner.v1.md`
- `playbooks/cost-surprise.ts` (the capability-to-EvidenceRequest mapping)
- `fixtures/` (sanitized AMG-MCP responses, one folder per fixture id)
- `runs/` (per-run output directory; gitignored)
- `package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `az-pixiu.json` (default operator config) + `az-pixiu.example.json` (annotated example referenced from the README), `README.md` updates
