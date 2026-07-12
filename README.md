# Az-Pixiu

<p align="center">
  <img src="assets/logo.png" alt="Az-Pixiu logo" width="200" />
</p>

Az-Pixiu is a local, read-only Azure FinOps agent. It connects to your Azure environment through the [Azure Managed Grafana MCP server](docs/amg-mcp-positioning.md) (AMG-MCP), pulls cost, resource, and telemetry signals, and produces evidence-cited recommendations for reducing cloud spend.

The project is named after the **Pixiu (貔貅)**, a creature in Chinese mythology said to attract and protect wealth — a fitting mascot for a tool focused on understanding and reducing cloud spend.

## What it does

- Discovers Azure subscriptions and resources via AMG-MCP.
- Pulls cost, configuration, and telemetry signals over the same boundary.
- Identifies cost-relevant patterns and, for `cost-summary` today, the first structural review lane: public IPs with neither an IP configuration nor a NAT Gateway association, with calibrated weekly list-price exposure. The match is a review candidate, not proof that the address should be deleted.
- Writes a human-readable Markdown report where every claim cites the underlying tool call.
- Records the full reasoning trace — planner steps, tool calls, model output, scores — to [Langfuse](https://langfuse.com) for review and evaluation.

Everything runs locally. Cloud telemetry never leaves the machine the agent runs on, except for the trace metadata you choose to ship to Langfuse.

## Why it exists

Two reasons, equally weighted:

1. **A useful FinOps tool.** Understanding Azure spend today means hopping between Cost Management, Azure Monitor, Resource Graph, and a stack of Grafana dashboards. Az-Pixiu does that legwork in one command and explains what it found.
2. **An open study of AI observability.** Az-Pixiu is built on Langfuse from day one — tracing, evaluations, datasets, prompt management, and experiments are first-class concerns, not afterthoughts. The codebase and docs are written so other engineers can learn how to instrument and evaluate an LLM agent without reverse-engineering a closed product.

## Getting started

Az-Pixiu is a CLI (`pixiu`) you clone and run locally. Requirements:

- **Node.js 22+**
- Access to an Azure Managed Grafana instance with MCP enabled. By default AMG-MCP auth uses Entra ID via `az login`; alternatively, configure a Grafana service account token in `config.json`.
- An **LLM provider** — either an Azure AI Foundry deployment (Entra ID auth) or any OpenAI-compatible LiteLLM gateway. Pick one in `config.json` via the top-level `"provider"` field (`"foundry"` — the default — or `"litellm"`).

```bash
npm install
cp config.sample.json config.json    # edit endpoints + deployment / model name
npm run build                        # or `npm run dev` during development

# headline run: single-window cost breakdown — no subscription id needed.
# With no --subscription flag the agent auto-discovers your top 3
# subscriptions by resource count via AMG-MCP and analyzes those.
npx pixiu analyze cost-summary

# scope it explicitly to one or more subscriptions instead (--subscription repeats),
# or filter by one or more display-name substrings (comma-separated OR terms)
npx pixiu analyze cost-summary --subscription-name-filter prod,shared

# baseline-comparison flow: surface what changed vs. the prior window
npx pixiu analyze cost-surprise --subscription <sub-id> --resource-group <rg>

# fully-offline eval against the seeded fixtures (no LLM, no Azure calls)
npx pixiu eval eval/phase-1.json --use-playbook --mock-model \
    --credential mock --observability noop

# compare multiple models on the same dataset, push results to Langfuse
# (each model becomes one Langfuse Experiment; scores attach to each trace)
LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… LANGFUSE_BASE_URL=… \
    npx pixiu eval eval/phase-1.json --use-playbook \
        --models gpt-5.4,gpt-4o,gpt-chat-latest \
        --observability langfuse

# focused model comparison for the two Phase 3 cost-judgment cases
npm run eval:compare:cost-reasoning

# compare a candidate local prompt tree. Start from the complete tree because
# every eval loads planner.v1 and cost-summary loads reasoner.v2.
mkdir -p prompt-candidate
cp -R prompts prompt-candidate/prompts
# edit prompt-candidate/prompts/reasoner.v2.md, then run:
npx pixiu eval eval/phase-3-cost-reasoning.json --use-playbook \
    --models gpt-5.4,gpt-4o --prompts-dir ./prompt-candidate \
    --observability langfuse --experiment-name cost-reasoning-prompt-candidate

# environment sanity check (credentials, endpoint reachability, MCP capabilities)
npx pixiu diagnose
```

AMG-MCP authentication defaults to Entra ID:

```json
{
  "amg": {
    "endpoint": "https://<your-amg-instance>.grafana.azure.com",
    "auth": { "mode": "entra" }
  }
}
```

To use a Grafana service account token instead, prefer referencing an environment variable:

```json
{
  "amg": {
    "endpoint": "https://<your-amg-instance>.grafana.azure.com",
    "auth": {
      "mode": "service_account_token",
      "token_env": "GRAFANA_SERVICE_ACCOUNT_TOKEN"
    }
  }
}
```

The token may also be supplied directly as `amg.auth.token` for local-only configs. The token value is used as the AMG-MCP HTTP `Authorization: Bearer ...` credential and is not printed by the CLI.

`npx pixiu --help` lists the full flag set. Each run writes `report.md`, `report.html`, and `run.json` to a timestamped subdirectory under `runs/`.
Prompt versions and full content SHA-256 digests are recorded in `run.json`, trace attributes, and eval Dataset Run Item metadata. The resolved local prompt path is printed for reproducibility but is not exported to Langfuse.

## Project status

**Phase 2 — Langfuse depth — in progress; Phase 2.5 shipped; Phase 3 started.** Phase 1 (minimum viable agent) is complete: end-to-end runs against live AMG-MCP and Azure AI Foundry, evidence-cited reports, per-run `run.json`, Langfuse traces when configured, seeded fixture-backed eval datasets, and six active automated rubrics (structural correctness, citation completeness, confidence consistency, read-only adherence, plus `estimated_impact_calibrated` and `waste_classification_grounding`).

Recently shipped:

- **Phase 2.5 — cross-run continuity foundations.** `RunHistoryStore` over the existing `runs/` artefacts, deterministic `recommendation_signature`, `prior_run_context` evidence, and a first-class "Run Quality" report section.
- **Phase 2 — Langfuse eval publishing.** Eval runs can publish rubric and expectation scores, upsert local dataset items, group traces into Langfuse Dataset Runs / Experiments, and sweep multiple models.
- **Phase 2/3 — cost-judgment experiments.** `eval/phase-3-cost-reasoning.json` tests high spend without utilization evidence and list-price exposure above observed billing. Both semantic expectations publish independently to Langfuse, require exact reconciled quantities rather than boilerplate, and `--prompts-dir` makes the same cases reusable for content-addressed local baseline-versus-candidate prompt experiments.
- **Phase 3 — first waste lane plus evidence-contract gate.** The `cost-summary` analyzer enumerates unassociated public-IP review candidates with calibrated weekly impact estimates from an in-repo rate card. Complete non-empty lanes emit a citable aggregate summary in addition to per-candidate evidence; partial enumeration withholds the summary. Both deterministic analyzers send the discovered live wire shapes for Cost Analysis and Activity Log, keep ARG scope inside supported KQL, and preserve intended scope outside the wire payload. The waste lane decodes real MCP text envelopes, rejects returned rows outside effective scope, and refuses a clean no-match claim when parsing is incomplete. This is the only enabled waste lane today.
- **Cost evidence quarantine.** Cost responses distinguish `valid_zero`, `cost_zero_suspected`, `zero_unresolved`, and `cost_scope_mismatch`. Contradictory zeros, malformed/missing numeric totals, unrecognized successful payloads, and structured responses whose returned subscription set differs from the request remain visible as partial provenance but are excluded from reasoning, coverage, arithmetic, and local billing-cache admission.
- **Transport resilience.** The agent recognizes wire-level and payload-embedded 429s from AMG-MCP cost analysis, retries with capped backoff plus jitter, separates pacing from retry budget, records `transport_summary`, and makes retries visible in Run Quality and trace events.

Next up: a bounded cost-guided second pass, beginning with PostgreSQL rightsizing and followed by Log Analytics ingestion, AKS node-pool efficiency, Cosmos DB throughput/lifecycle, and ACR inactivity/replication evidence packs. Additional waste lanes, naming-pattern clustering, continuity markers, uniform-drop freshness detection, and the remaining Phase 2 Langfuse surfaces remain planned. See the [roadmap](docs/roadmap.md) and the [cost-summary depth design](docs/design/cost-summary-depth.md) for the full plan.

## Audience

Az-Pixiu is written for two readers. The first is an engineer or operator who wants to understand their own Azure spend without manually piecing together Cost Management, Azure Monitor, and a Grafana dashboard. The second is an engineer learning how to build, instrument, and evaluate an LLM agent in a disciplined way. The code, docs, and eval artefacts are kept legible for both.

## Documentation

**Direction and scope**

- [Vision](docs/vision.md) — long-term direction.
- [Goals and non-goals](docs/goals.md) — what is and isn't in scope.
- [Architecture principles](docs/architecture-principles.md) — the philosophy shaping the system.
- [Use cases](docs/use-cases.md) — the scenarios the agent is built to support.
- [Roadmap](docs/roadmap.md) — phased plan.
- [Langfuse learning goals](docs/langfuse-learning-goals.md) — the Langfuse capabilities the project intends to demonstrate.
- [AMG-MCP positioning](docs/amg-mcp-positioning.md) — why AMG-MCP sits at the Azure boundary.
- [AMG-MCP capabilities](docs/amg-mcp-capabilities.md) — what AMG-MCP exposes today and how it maps to use cases.
- [Model comparison](docs/model-comparison.md) — Phase 1 sweep of OpenAI chat-completion models on the cost-summary workload.

**Product requirements**

- [Core agent](docs/prd/core-agent.md)
- [Langfuse observability](docs/prd/langfuse-observability.md)
- [AMG-MCP integration](docs/prd/amg-mcp-integration.md)
- [Reporting and recommendations](docs/prd/reporting-and-recommendations.md)
- [Evaluation framework](docs/prd/evaluation-framework.md)
- [CLI experience](docs/prd/cli-experience.md)
- [Future multi-agent platform](docs/prd/future-multi-agent-platform.md)

**Design**

- [Phase 1 design](docs/design/phase-1.md) — minimum viable agent: components, data shapes, reasoning loop, trace vocabulary.
- [Phase 2 design](docs/design/phase-2.md) — Langfuse depth: scores, datasets, prompt management, experiments, LLM-as-judge, human review, calibration.
- [Cost-summary depth](docs/design/cost-summary-depth.md) — Phase 2.5 + Phase 3 analyzer extensions: waste lanes, naming-pattern clustering, calibrated impact, freshness checks, continuity markers.
- [Local billing cache](docs/design/local-billing-cache.md) — partially shipped local cache for usage-stable full-month billing evidence, including conservative zero/missing-total admission rules.

## License

MIT. See [LICENSE](LICENSE).
