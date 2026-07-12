import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';

/**
 * Load a prompt file from the repo's prompts/ directory. Each loaded
 * prompt carries its source path and a version label derived from the
 * filename (e.g., "planner.v1.md" → "planner.v1"), which lands on
 * RunMetadata.prompt_versions (§5.7) and the trace root span (§14).
 */

export interface LoadedPrompt {
  /** Filename without extension, used as prompt_versions entry. */
  version: string;
  /** Full SHA-256 digest of the exact UTF-8 prompt content sent to the model. */
  content_sha256: string;
  /** Raw markdown content. */
  content: string;
  /** Absolute path the prompt was read from. */
  path: string;
}

export interface LoadPromptOptions {
  filename: string;
  cwd?: string;
}

export async function loadPrompt(options: LoadPromptOptions): Promise<LoadedPrompt> {
  const cwd = options.cwd ?? process.cwd();
  const path = isAbsolute(options.filename)
    ? options.filename
    : resolve(cwd, 'prompts', options.filename);
  const content = await readFile(path, 'utf8');
  const version = options.filename.replace(/\.md$/, '');
  const content_sha256 = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
  return { version, content_sha256, content, path };
}
