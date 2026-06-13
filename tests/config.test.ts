import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, DEFAULT_CONFIG_PATH } from '../src/config.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'azp-config-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const validJson = JSON.stringify({
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-5.4',
  },
  amg: {
    endpoint: 'https://example.grafana.azure.com',
  },
});

describe('loadConfig', () => {
  it('loads and validates a well-formed config file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(path, validJson);
      const config = await loadConfig({ path });
      expect(config.foundry.deployment).toBe('gpt-5.4');
      expect(config.foundry.endpoint).toBe('https://example.openai.azure.com');
      expect(config.amg.endpoint).toBe('https://example.grafana.azure.com');
    });
  });

  it('loads optional observability settings from config file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(
        path,
        JSON.stringify({
          foundry: {
            endpoint: 'https://example.openai.azure.com',
            deployment: 'gpt-5.4',
          },
          amg: {
            endpoint: 'https://example.grafana.azure.com',
          },
          observability: {
            application_insights_connection_string:
              'InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://westus2-0.in.applicationinsights.azure.com/',
          },
        }),
      );
      const config = await loadConfig({ path });
      expect(config.observability?.application_insights_connection_string).toContain(
        'InstrumentationKey=',
      );
    });
  });

  it('resolves relative paths against cwd option', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'config.json'), validJson);
      const config = await loadConfig({ cwd: dir });
      expect(config.foundry.deployment).toBe('gpt-5.4');
    });
  });

  it('defaults to config.json when no path is given', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, DEFAULT_CONFIG_PATH), validJson);
      const config = await loadConfig({ cwd: dir });
      expect(config.foundry.deployment).toBe('gpt-5.4');
    });
  });

  it('throws ConfigError when the file is missing', async () => {
    await expect(
      loadConfig({ path: '/definitely/does/not/exist/config.json' }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('error message for missing file points operator to config.sample.json', async () => {
    try {
      await loadConfig({ path: '/definitely/does/not/exist/config.json' });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('config.sample.json');
    }
  });

  it('throws ConfigError when JSON is malformed', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(path, '{ this is not json');
      await expect(loadConfig({ path })).rejects.toBeInstanceOf(ConfigError);
    });
  });

  it('throws ConfigError when JSON is valid but schema does not match', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(path, JSON.stringify({ foundry: {} }));
      await expect(loadConfig({ path })).rejects.toBeInstanceOf(ConfigError);
    });
  });

  it('schema-mismatch error message includes field paths', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'config.json');
      await writeFile(
        path,
        JSON.stringify({ foundry: { endpoint: 'not-a-url', deployment: '' }, amg: { endpoint: 'also-not-a-url' } }),
      );
      try {
        await loadConfig({ path });
        throw new Error('expected loadConfig to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as ConfigError).message;
        expect(message).toContain('foundry.endpoint');
        expect(message).toContain('foundry.deployment');
        expect(message).toContain('amg.endpoint');
      }
    });
  });

  it('preserves the underlying error as cause', async () => {
    try {
      await loadConfig({ path: '/definitely/does/not/exist/config.json' });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).cause).toBeDefined();
    }
  });
});

describe('loadConfig against the repo-root config.sample.json', () => {
  it('rejects the sample template because the placeholder endpoints are not valid URLs', async () => {
    await expect(loadConfig({ path: 'config.sample.json' })).rejects.toBeInstanceOf(ConfigError);
  });
});
