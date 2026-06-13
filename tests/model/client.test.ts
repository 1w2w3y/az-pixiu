import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MockModelClient } from '../../src/model/mock-client.js';
import { modelConfigHash } from '../../src/model/client.js';
import { isUnsupportedTemperatureError } from '../../src/model/openai-client.js';

const tiny = z.object({ greeting: z.string() }).strict();

describe('MockModelClient', () => {
  it('returns the constant response and validates it against the schema', async () => {
    const m = new MockModelClient({ responses: { greeting: 'hi' } });
    const out = await m.generateStructured({
      systemPrompt: 's',
      userPrompt: 'u',
      schema: tiny,
      schemaName: 'tiny',
    });
    expect(out.greeting).toBe('hi');
  });

  it('records every call', async () => {
    const m = new MockModelClient({ responses: { greeting: 'hi' } });
    await m.generateStructured({ systemPrompt: 's', userPrompt: 'u', schema: tiny, schemaName: 'tiny' });
    await m.generateStructured({ systemPrompt: 'x', userPrompt: 'y', schema: tiny, schemaName: 'tiny' });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]?.userPrompt).toBe('y');
  });

  it('serves a sequence of responses', async () => {
    const m = new MockModelClient({
      responses: [{ greeting: 'a' }, { greeting: 'b' }],
    });
    const r1 = await m.generateStructured({ systemPrompt: '', userPrompt: '', schema: tiny, schemaName: 't' });
    const r2 = await m.generateStructured({ systemPrompt: '', userPrompt: '', schema: tiny, schemaName: 't' });
    expect([r1.greeting, r2.greeting]).toEqual(['a', 'b']);
  });

  it('throws when sequence is exhausted', async () => {
    const m = new MockModelClient({ responses: [{ greeting: 'a' }] });
    await m.generateStructured({ systemPrompt: '', userPrompt: '', schema: tiny, schemaName: 't' });
    await expect(
      m.generateStructured({ systemPrompt: '', userPrompt: '', schema: tiny, schemaName: 't' }),
    ).rejects.toThrow(/exhausted/);
  });

  it('throws when canned data fails the schema (the mock checks itself)', async () => {
    const m = new MockModelClient({ responses: { wrong: 'shape' } });
    await expect(
      m.generateStructured({ systemPrompt: '', userPrompt: '', schema: tiny, schemaName: 't' }),
    ).rejects.toThrow(/schema/);
  });

  it('accepts a responder function with access to the call args', async () => {
    const m = new MockModelClient({
      responses: (args) => ({ greeting: `echo:${args.userPrompt}` }),
    });
    const out = await m.generateStructured({
      systemPrompt: 's',
      userPrompt: 'hello',
      schema: tiny,
      schemaName: 't',
    });
    expect(out.greeting).toBe('echo:hello');
  });
});

describe('modelConfigHash', () => {
  it('produces stable 8-char hex for the same inputs', () => {
    const a = modelConfigHash({ provider: 'foundry', name: 'gpt-5.4', temperature: 0 });
    const b = modelConfigHash({ provider: 'foundry', name: 'gpt-5.4', temperature: 0 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs when inputs differ', () => {
    const a = modelConfigHash({ provider: 'foundry', name: 'gpt-5.4', temperature: 0 });
    const b = modelConfigHash({ provider: 'foundry', name: 'gpt-5.4', temperature: 0.5 });
    expect(a).not.toBe(b);
  });

  it('is insensitive to property order', () => {
    const a = modelConfigHash({ provider: 'foundry', name: 'gpt-5.4', temperature: 0, seed: 7 });
    const b = modelConfigHash({ name: 'gpt-5.4', seed: 7, temperature: 0, provider: 'foundry' });
    expect(a).toBe(b);
  });
});

describe('OpenAIModelClient compatibility helpers', () => {
  it('recognizes provider errors for models that reject temperature=0', () => {
    expect(
      isUnsupportedTemperatureError(
        new Error(
          "400 Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
        ),
      ),
    ).toBe(true);
  });

  it('does not classify unrelated model errors as temperature compatibility issues', () => {
    expect(isUnsupportedTemperatureError(new Error('401 Access denied due to invalid token'))).toBe(
      false,
    );
  });
});
