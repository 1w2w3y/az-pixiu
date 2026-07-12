import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompt } from '../../src/prompts/loader.js';

describe('loadPrompt', () => {
  it('loads planner.v1.md and reports the version', async () => {
    const p = await loadPrompt({ filename: 'planner.v1.md' });
    expect(p.version).toBe('planner.v1');
    expect(p.content).toMatch(/Az-Pixiu — Planner/);
    expect(p.path).toMatch(/planner\.v1\.md$/);
    expect(p.content_sha256).toBe(
      `sha256:${createHash('sha256').update(p.content, 'utf8').digest('hex')}`,
    );
    expect(p.content_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('loads reasoner.v1.md and reports the version', async () => {
    const p = await loadPrompt({ filename: 'reasoner.v1.md' });
    expect(p.version).toBe('reasoner.v1');
    expect(p.content).toMatch(/Az-Pixiu — Reasoner/);
  });

  it('keeps the reasoner prompt explicit about exact evidence_id copying', async () => {
    const p = await loadPrompt({ filename: 'reasoner.v1.md' });
    expect(p.content).toContain('Each value must be copied exactly');
    expect(p.content).toContain('<evidence_block role="data">');
  });

  it('throws on a missing prompt file', async () => {
    await expect(loadPrompt({ filename: 'does-not-exist.md' })).rejects.toBeDefined();
  });

  it('keeps the digest stable for identical content and changes it after an edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azp-prompt-hash-'));
    try {
      await mkdir(join(root, 'prompts'));
      const path = join(root, 'prompts', 'reasoner.v2.md');
      await writeFile(path, 'candidate prompt v1\n');
      const first = await loadPrompt({ filename: 'reasoner.v2.md', cwd: root });
      const repeated = await loadPrompt({ filename: 'reasoner.v2.md', cwd: root });
      expect(repeated.content_sha256).toBe(first.content_sha256);

      await writeFile(path, 'candidate prompt v2\n');
      const edited = await loadPrompt({ filename: 'reasoner.v2.md', cwd: root });
      expect(edited.content_sha256).not.toBe(first.content_sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
