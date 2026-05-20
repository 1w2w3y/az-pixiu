import { randomUUID } from 'node:crypto';

/**
 * Pushes per-run rubric / expectation results into Langfuse as Scores
 * and registers each run as a member of a Langfuse Dataset Run (which
 * Langfuse renders as an "Experiment"). Used by the eval runner when
 * `--observability langfuse` is active.
 *
 * The Langfuse Public API is the boundary: we use plain `fetch` against
 * the documented endpoints rather than the auto-generated SDK because
 * the API surface we need (ingestion batch + dataset-items +
 * dataset-run-items) is small and stable. Calls are best-effort: a
 * Langfuse 4xx/5xx surfaces as a {@link LangfusePublishError} that the
 * caller chooses how to handle — eval runs prefer to log a warning and
 * keep going rather than fail the whole sweep because the trace store
 * was momentarily unhappy.
 */

export interface ScorePayload {
  /** OpenTelemetry trace ID (32 hex chars), as captured from RunResult.otel_trace_id. */
  traceId: string;
  name: string;
  /** For BOOLEAN: 1 or 0. For NUMERIC: any number. For CATEGORICAL: a string. */
  value: number | string;
  dataType: 'BOOLEAN' | 'NUMERIC' | 'CATEGORICAL';
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface DatasetRunItemPayload {
  /** Operator-meaningful run/experiment name (e.g. "phase-1-gpt-5.4-2026-05-20"). */
  runName: string;
  /** Langfuse-side dataset item id — same as our local item.id when upserted via {@link LangfusePublisher.upsertItem}. */
  datasetItemId: string;
  /** OpenTelemetry trace ID of the agent run that consumed this item. */
  traceId: string;
  metadata?: Record<string, unknown>;
}

export interface LangfusePublisherConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export class LangfusePublishError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, public readonly statusCode?: number, cause?: unknown) {
    super(message);
    this.name = 'LangfusePublishError';
    this.cause = cause;
  }
}

export class LangfusePublisher {
  private readonly auth: string;

  constructor(private readonly cfg: LangfusePublisherConfig) {
    this.auth =
      'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64');
  }

  /**
   * Build a publisher from the LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
   * LANGFUSE_BASE_URL environment variables, the same set the OTel
   * processor uses. Returns undefined when any are missing so callers
   * can no-op cleanly in tests or non-langfuse modes.
   */
  static fromEnv(): LangfusePublisher | undefined {
    const baseUrl = process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    if (!baseUrl || !publicKey || !secretKey) return undefined;
    return new LangfusePublisher({
      baseUrl: baseUrl.replace(/\/+$/, ''),
      publicKey,
      secretKey,
    });
  }

  /**
   * Idempotent dataset creation. 409 (already exists) is swallowed so
   * repeated eval runs against the same dataset name don't fail.
   */
  async ensureDataset(name: string, description?: string): Promise<void> {
    try {
      await this.post(
        '/api/public/v2/datasets',
        { name, ...(description ? { description } : {}) },
        [200, 201],
      );
    } catch (e) {
      if (e instanceof LangfusePublishError && e.statusCode === 409) return;
      throw e;
    }
  }

  /**
   * Upsert a single dataset item. Langfuse upserts on `id` (project-level
   * unique per docs), so passing our local item id preserves the mapping
   * between local JSON and the Langfuse-side record without a separate
   * lookup. The `input` / `expectedOutput` payload mirrors the dataset
   * item's local representation; we keep it minimal (scope + expectations)
   * rather than dumping the whole local record to avoid drift if the
   * local schema grows fields Langfuse doesn't expect.
   */
  async upsertItem(
    datasetName: string,
    item: {
      id: string;
      input: unknown;
      expectedOutput?: unknown;
      metadata?: unknown;
    },
  ): Promise<void> {
    await this.post(
      '/api/public/dataset-items',
      {
        datasetName,
        id: item.id,
        input: item.input,
        ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
        ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
      },
      [200, 201],
    );
  }

  /**
   * Attach a trace to a dataset run, making it visible in Langfuse's
   * Experiment UI under the supplied run name.
   */
  async createRunItem(payload: DatasetRunItemPayload): Promise<void> {
    await this.post(
      '/api/public/dataset-run-items',
      {
        runName: payload.runName,
        datasetItemId: payload.datasetItemId,
        traceId: payload.traceId,
        ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      },
      [200, 201],
    );
  }

  /**
   * Push one or more scores in a single batched ingestion call. Scores
   * reference traces by OTel trace ID; Langfuse links them when the
   * trace lands (so order between scores and trace export does not
   * matter).
   */
  async pushScores(scores: ScorePayload[]): Promise<void> {
    if (scores.length === 0) return;
    const batch = scores.map((s) => ({
      id: randomUUID(),
      type: 'score-create',
      timestamp: new Date().toISOString(),
      body: {
        id: randomUUID(),
        traceId: s.traceId,
        name: s.name,
        value: s.value,
        dataType: s.dataType,
        ...(s.comment !== undefined ? { comment: s.comment } : {}),
        ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      },
    }));
    await this.post('/api/public/ingestion', { batch }, [200, 207]);
  }

  private async post(path: string, body: unknown, okStatuses: number[]): Promise<void> {
    const url = `${this.cfg.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.auth,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LangfusePublishError(
        `Langfuse POST ${path} failed before getting a response: ${describe(err)}`,
        undefined,
        err,
      );
    }
    if (!okStatuses.includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new LangfusePublishError(
        `Langfuse POST ${path} returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      );
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
