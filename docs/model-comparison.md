# model comparison — phase 1

A snapshot comparison of OpenAI-family chat-completion models available on
the project's LiteLLM gateway, evaluated against the project's real
`cost-summary` analysis (`pixiu analyze cost-summary --subscription-name-filter
GrafanaDevRP`). The intent is not a benchmark — it's to inform which model
the default `config.json` should point at, and to flag models that should be
avoided.

## headline

- Default to **`gpt-5.4`**. It produced the most facts, the most hypotheses,
  the most recommendations, and the only high/high top recommendation that
  also kept the data-quality complaints minimal. It is the strongest model
  on this workload of those tested.
- For a faster, cheaper default, **`gpt-4o`** is competitive: ~34 s per run
  (about half of gpt-5.4), still high/high on its one recommendation.
  Reasonable choice when latency or token cost matters more than the breadth
  of recommendations.
- **Do not use any `-pro` variant** (confirmed: `gpt-5.4-pro`, `gpt-5-pro`).
  Both are slow enough to exceed the LiteLLM gateway's response timeout:
  each run sat for ~17 minutes before the gateway returned a 504 Gateway
  Time-out and the agent run failed. The models themselves may be fine;
  the deployment pipeline is not. Unless and until the gateway timeout
  is raised (or pro models are hosted somewhere with longer-lived
  connections), they are unusable end-to-end and should not be selected
  in `config.json`.

## methodology

- One pass per model. Same scope (`GrafanaDevRP` subscription filter),
  same time window (auto-discovered, default last 7 days), same analysis
  type (`cost_summary`).
- Normal mode — both planner LLM and reasoner LLM active. The planner
  decides which AMG-MCP capabilities to call; the reasoner synthesizes
  evidence into facts, hypotheses, and recommendations. This exposes the
  end-to-end behavior of the model against real evidence, including the
  model's own choices about which MCP tools to invoke.
- `--observability noop` (no Langfuse export for sweep runs).
- `temperature=0` request body. Reproducibility comes from the same scope,
  the same model id, and the same temperature; the planner does still hit
  Azure live for evidence, so cost numbers drift across runs.
- Models excluded from the sweep:
  - `-transcribe`, `-fine-tune-2510` (special-purpose).
  - `-codex` variants (tuned for code completion, mis-fits an analytic
    structured-JSON workload).
  - `gpt-oss-120b` (not an OpenAI chat-completion model).
- Run artefacts land in `runs-compare/<model>/<run_id>/`; the sweep
  driver script is `runs-compare/sweep.sh`.

## results

Successful runs that produced recommendations, ordered by recommendation
count then by top-recommendation confidence:

| Model | sec | evidence | facts | hyps | recs | dq | top rec priority/confidence | top recommendation gist |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `gpt-5.4` (default) | 71 | 4 | 10 | 3 | **3** | 1 | high/high | Focus FinOps review on sub-1; PostgreSQL/Cosmos/compute |
| `gpt-5.2` | 66 | 7 | 10 | 2 | 3 | 2 | high/low ⚠ | Deeper cost-driver review for PostgreSQL in sub-1 |
| `gpt-4.1` | 42 | 3 | 4 | 1 | 2 | 1 | high/high | Review PostgreSQL flex-server config / util / scaling |
| `gpt-chat-latest` (self-id `gpt-5.5`) | 42 | 7 | 5 | 2 | 2 | 1 | high/high | Investigate Cost Management 429 patterns first |
| `gpt-5.1-chat` | 39 | 3 | 4 | 1 | 2 | 0 | medium/high | Review PostgreSQL flex-server config in sub-1 |
| `gpt-4o` | 34 | 3 | 5 | 1 | 1 | 0 | high/high | Investigate PostgreSQL cost + utilization in sub-1 |
| `gpt-4o-mini` | 34 | 3 | 3 | 1 | 1 | 0 | high/medium | Review cost drivers in sub-1 |
| `gpt-4.1-mini` | 35 | 3 | 3 | 1 | 1 | 0 | medium/high | Review cost drivers in sub-1 |
| `gpt-5.4-mini` | 65 | 6 | 4 | 1 | 1 | 5 | medium/medium | Confirm whether sub-3's minimal spend is intentional |
| `gpt-5.3-chat` | 67 | 3 | 5 | 1 | 1 | 2 | medium/medium | Review DDoS / Defender configs (off-topic side-quest) |
| `gpt-5-mini` | 126 | 6 | 3 | 1 | 1 | 8 | low/high | "No immediate action for sub-3" — low-priority commentary |
| `gpt-5` (after fix) | 219 | 3 | 6 | 0 | 2 | 6 | medium/medium | Investigate PostgreSQL / Cosmos drivers in sub-1 |

`gpt-chat-latest` is an alias that self-identifies as `gpt-5.5` — a model
not otherwise exposed by name. It is interesting to try but a moving
pointer; do not pin evals to it.

Successful runs that produced **zero recommendations** (the reasoner walked
away citing data-quality concerns instead of committing):

| Model | sec | evidence | facts | hyps | recs | dq | observation |
|---|---:|---:|---:|---:|---:|---:|---|
| `gpt-4.1-nano` | 73 | 0 | 0 | 0 | 0 | 1 | Planner produced an empty plan — could not decide what to ask for |
| `gpt-5-chat` | 35 | 3 | 2 | 0 | 0 | 3 | Bailed on data-quality findings |
| `gpt-5.1` | 93 | 3 | 10 | 0 | 0 | 10 | Drowned in dq complaints (10 facts + 10 dq, no synthesis) |
| `gpt-5.2-chat` | 41 | 3 | 2 | 0 | 0 | 4 | Same — bailed on dq |
| `gpt-5.4-nano` | 70 | 6 | 7 | 0 | 0 | 8 | Too small to commit |
| `gpt-5-nano` (after fix) | 115 | 1 | 1 | 0 | 0 | 4 | Single fact, no synthesis |

This is mostly a prompt-shape problem, not a model problem — the reasoner
prompt currently lets the model off the hook too easily when it sees any
imperfect evidence. The bigger or chat-tuned variants in the same family
all produced recommendations from comparable evidence. Worth a Phase-2
prompt experiment.

Models that could not run end-to-end:

| Model | seconds | failure mode | notes |
|---|---:|---|---|
| `gpt-5.4-pro` | 1000 | 504 Gateway Time-out (LiteLLM) | **Do not use.** Gateway hangs up before the model can finish. |
| `gpt-5-pro` (after temperature fix) | 1056 | 504 Gateway Time-out (LiteLLM) | **Do not use.** Same pattern as `gpt-5.4-pro` — `-pro` variants exceed the gateway's response timeout. |
| `gpt-5`, `gpt-5-nano` (originally) | ~10 each | LiteLLM 400: `temperature=0` rejected | **Resolved** by passing `drop_params: true` in the request body (LiteLLM proxy then silently drops unsupported request params instead of returning 400). After the fix both models run; their results are listed above. See `src/model/litellm-client.ts`. |

## findings and follow-ups

- The reasoner gives up too easily on imperfect evidence. Five different
  models with the same input chose "report data-quality concerns, emit no
  recommendation" over "make a calibrated suggestion." That's a property
  of `prompts/reasoner.v1.md`, not the model. A Phase-2 prompt experiment
  should test whether changing the data-quality / recommendation balance
  in that prompt unlocks usable recommendations from the cautious models.
- Several gpt-5-family models reject `temperature=0` outright. The
  workaround in this codebase is `drop_params: true` on the LiteLLM proxy.
  An equivalent fix would be model-id pattern matching in the client, but
  the proxy approach is one line and self-explanatory in the request body.
- Nano-class models (`gpt-4.1-nano`, `gpt-5.4-nano`) underperform on this
  workload — small enough to either skip the planner entirely or refuse
  to commit. They are not viable defaults today, even for cost reasons.
- `gpt-5.4-pro` is the only model with a deployment-pipeline failure (504
  gateway). Treat it as unsupported until the gateway timeout is raised.

## reproducing the sweep

```bash
bash runs-compare/sweep.sh   # writes runs-compare/<model>/<run-id>/ and a log.txt
```

The driver edits `config.json` per model, runs `cost-summary`, restores
nothing at the end (the calling shell should restore the original model
after the sweep). All artefacts land under `runs-compare/`.
