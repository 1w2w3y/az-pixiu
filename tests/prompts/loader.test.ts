import { describe, it, expect } from 'vitest';
import { loadPrompt } from '../../src/prompts/loader.js';

describe('loadPrompt', () => {
  it('loads planner.v1.md and reports the version', async () => {
    const p = await loadPrompt({ filename: 'planner.v1.md' });
    expect(p.version).toBe('planner.v1');
    expect(p.content).toMatch(/Az-Pixiu — Planner/);
    expect(p.path).toMatch(/planner\.v1\.md$/);
  });

  it('loads reasoner.v1.md and reports the version', async () => {
    const p = await loadPrompt({ filename: 'reasoner.v1.md' });
    expect(p.version).toBe('reasoner.v1');
    expect(p.content).toMatch(/Az-Pixiu — Reasoner/);
  });

  it('throws on a missing prompt file', async () => {
    await expect(loadPrompt({ filename: 'does-not-exist.md' })).rejects.toBeDefined();
  });
});
