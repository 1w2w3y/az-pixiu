# Az-Pixiu

<p align="center">
  <img src="assets/logo.png" alt="Az-Pixiu logo" width="200" />
</p>

Az-Pixiu is a local, read-only Azure FinOps agent. It connects to your Azure environment through the [Azure Managed Grafana MCP server](docs/amg-mcp-positioning.md) (AMG-MCP), pulls cost, resource, and telemetry signals, and produces evidence-cited recommendations for reducing cloud spend.

The project is named after the **Pixiu (貔貅)**, a creature in Chinese mythology said to attract and protect wealth — a fitting mascot for a tool focused on understanding and reducing cloud spend.

## What it does

- Discovers Azure subscriptions and resources via AMG-MCP.
- Pulls cost, configuration, and telemetry signals over the same boundary.
- Identifies waste candidates (orphan public IPs, unattached disks, deallocated VMs, …) and other cost-relevant patterns.
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
- **`az login`** against a tenant that can reach an Azure Managed Grafana instance with MCP enabled
- An **LLM provider** — either an Azure AI Foundry deployment (Entra ID auth) or any OpenAI-compatible LiteLLM gateway. Pick one in `config.json` via the top-level `"provider"` field (`"foundry"` — the default — or `"litellm"`).

```bash
npm install
cp config.sample.json config.json    # edit endpoints + deployment / model name
npm run build                        # or `npm run dev` during development

# headline run: single-window cost breakdown for one subscription
npx pixiu analyze cost-summary --subscription <sub-id>

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

# environment sanity check (credentials, endpoint reachability, MCP capabilities)
npx pixiu diagnose
```

`npx pixiu --help` lists the full flag set. Each run writes its report, `run.json`, and intermediate artefacts to `runs/<run-id>/`.

## Project status

**Phase 2 — Langfuse depth — in progress.** Phase 1 (minimum viable agent) is complete: end-to-end runs against live AMG-MCP and Azure AI Foundry, evidence-cited Markdown reports, per-run `run.json`, a Langfuse trace for every invocation, a seeded eval dataset (`eval/phase-1.json`), and four scoring rubrics (structural correctness, citation completeness, confidence consistency, read-only adherence).

Recently shipped:

- **Phase 2.5 — cross-run continuity foundations.** `RunHistoryStore` over the existing `runs/` artefacts, deterministic `recommendation_signature`, `prior_run_context` evidence, and a first-class "Run Quality" report section.
- **Phase 3 — first waste lane.** The `cost-summary` analyzer now detects **orphan public IPs** with calibrated weekly impact estimates from an in-repo rate card.
- **Embedded rate-limit detection.** The agent recognizes 429s embedded in MCP tool payloads and retries with capped backoff plus jitter, separated from the pacing budget; per-attempt Langfuse span events make retries visible in traces.

Next up: the rest of the Phase 3 waste-lane group (unattached disks, deallocated VMs, stopped AKS, "restored-*" PostgreSQL servers, empty ACRs), naming-pattern clustering, and a `reasoner.v2` prompt with new scoring rubrics. See the [roadmap](docs/roadmap.md) and the [cost-summary depth design](docs/design/cost-summary-depth.md) for the full plan.

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

## License

MIT. See [LICENSE](LICENSE).
