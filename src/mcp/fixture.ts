import { readFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import {
  CapabilityCatalogSchema,
  ToolCallResultSchema,
} from '../schemas/index.js';
import type { CapabilityCatalog, ToolCallResult } from '../schemas/index.js';
import type { MCPTransport } from './transport.js';
import { parameterDigest, shortDigest } from './digest.js';

export class FixtureError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FixtureError';
    this.cause = cause;
  }
}

/**
 * Thrown when a call's (capability, parameters) does not match any
 * recorded response. Distinct from FixtureError so callers can decide
 * whether to fail the run or fall back (e.g., record-then-replay mode).
 */
export class FixtureNotFoundError extends FixtureError {
  constructor(
    public readonly capability: string,
    public readonly parametersDigest: string,
    public readonly fixturePath: string,
  ) {
    super(
      `No fixture for capability "${capability}" with parameters_digest ${parametersDigest.slice(0, 16)}… in ${fixturePath}. ` +
        `Either record a new fixture or adjust the call parameters to match an existing one.`,
    );
    this.name = 'FixtureNotFoundError';
  }
}

export interface FixtureMCPTransportOptions {
  /** Path to a fixture directory. Absolute or relative to process.cwd(). */
  fixturePath: string;
}

interface FixtureResponseFile {
  capability: string;
  parameters: Record<string, unknown>;
  parameters_digest: string;
  response: unknown;
}

/**
 * MCPTransport implementation that reads recorded responses from a
 * fixture directory laid out as:
 *
 *   <fixturePath>/
 *     manifest.json
 *     capabilities.json
 *     responses/
 *       <capability>__<short-digest>.json
 *
 * The short digest in the filename is the first 8 hex of the SHA-256
 * over canonicalized parameters; the full digest is stored inside each
 * response file and verified on load (catches prefix collisions and
 * filename/content drift).
 */
export class FixtureMCPTransport implements MCPTransport {
  private readonly fixturePath: string;
  private capabilityCatalogCache: CapabilityCatalog | undefined;

  constructor(options: FixtureMCPTransportOptions) {
    this.fixturePath = isAbsolute(options.fixturePath)
      ? options.fixturePath
      : resolve(process.cwd(), options.fixturePath);
  }

  async listCapabilities(): Promise<CapabilityCatalog> {
    if (this.capabilityCatalogCache) return this.capabilityCatalogCache;

    const path = join(this.fixturePath, 'capabilities.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      throw new FixtureError(`Could not read capabilities at ${path}`, err);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new FixtureError(`capabilities.json at ${path} is not valid JSON`, err);
    }

    const result = CapabilityCatalogSchema.safeParse(parsed);
    if (!result.success) {
      throw new FixtureError(
        `capabilities.json at ${path} does not match CapabilityCatalogSchema: ${result.error.message}`,
        result.error,
      );
    }

    this.capabilityCatalogCache = result.data;
    return result.data;
  }

  async invoke(
    capability: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const digest = parameterDigest(parameters);
    const filename = `${capability}__${shortDigest(digest)}.json`;
    const path = join(this.fixturePath, 'responses', filename);

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      // The bare "file missing" case is the dominant one; surface a
      // dedicated error so tests and callers can distinguish it from
      // schema or corruption errors.
      throw new FixtureNotFoundError(capability, digest, this.fixturePath);
    }

    let parsed: FixtureResponseFile;
    try {
      parsed = JSON.parse(raw) as FixtureResponseFile;
    } catch (err) {
      throw new FixtureError(`Fixture at ${path} is not valid JSON`, err);
    }

    // Cross-check the recorded digest against the one we computed. Catches
    // editor mishaps (someone renamed a file without re-hashing) and the
    // rare short-prefix collision.
    if (parsed.parameters_digest !== digest) {
      throw new FixtureError(
        `Fixture at ${path} records parameters_digest "${parsed.parameters_digest}" but the call computed "${digest}". ` +
          `The fixture is stale or filename collides with a different parameter set.`,
      );
    }

    if (parsed.capability !== capability) {
      throw new FixtureError(
        `Fixture at ${path} records capability "${parsed.capability}" but was loaded for "${capability}".`,
      );
    }

    const result = ToolCallResultSchema.safeParse(parsed.response);
    if (!result.success) {
      throw new FixtureError(
        `Recorded response at ${path} does not match ToolCallResultSchema: ${result.error.message}`,
        result.error,
      );
    }

    return result.data;
  }

  async close(): Promise<void> {
    // No external resources to release.
  }
}
