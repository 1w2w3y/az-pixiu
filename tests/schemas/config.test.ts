import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  FoundryConfigSchema,
  AmgConfigSchema,
} from '../../src/schemas/index.js';

const validConfig = {
  foundry: {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-5.4',
  },
  amg: {
    endpoint: 'https://example.grafana.azure.com',
  },
};

describe('ConfigSchema', () => {
  it('accepts a well-formed config', () => {
    expect(ConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('produces a strongly-typed value when parsing succeeds', () => {
    const result = ConfigSchema.safeParse(validConfig);
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.foundry.deployment).toBe('gpt-5.4');
    expect(result.data.amg.endpoint).toBe('https://example.grafana.azure.com');
  });

  it('rejects when foundry.deployment is missing', () => {
    const { foundry, ...rest } = validConfig;
    const { deployment: _unused, ...foundryMinusDeployment } = foundry;
    const result = ConfigSchema.safeParse({ ...rest, foundry: foundryMinusDeployment });
    expect(result.success).toBe(false);
  });

  it('rejects an empty deployment name', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      foundry: { ...validConfig.foundry, deployment: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL foundry endpoint', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      foundry: { ...validConfig.foundry, endpoint: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL amg endpoint', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      amg: { endpoint: 'amg-not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict mode catches typos)', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      foundrey: validConfig.foundry,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown nested keys in foundry section', () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      foundry: { ...validConfig.foundry, sku: 'GlobalStandard' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects when amg section is omitted', () => {
    const { amg: _amg, ...withoutAmg } = validConfig;
    expect(ConfigSchema.safeParse(withoutAmg).success).toBe(false);
  });
});

describe('FoundryConfigSchema (standalone)', () => {
  it('parses standalone foundry config', () => {
    expect(FoundryConfigSchema.safeParse(validConfig.foundry).success).toBe(true);
  });
});

describe('AmgConfigSchema (standalone)', () => {
  it('parses standalone amg config', () => {
    expect(AmgConfigSchema.safeParse(validConfig.amg).success).toBe(true);
  });
});
