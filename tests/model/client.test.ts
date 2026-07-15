import { afterEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { MockModelClient } from '../../src/model/mock-client.js';
import { modelConfigHash } from '../../src/model/client.js';
import { isUnsupportedTemperatureError } from '../../src/model/openai-client.js';
import { buildLiteLLMHttpTransport } from '../../src/model/litellm-client.js';

const tiny = z.object({ greeting: z.string() }).strict();

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

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

describe('LiteLLMModelClient HTTP transport', () => {
  it('applies the configured model timeout to Undici response headers', async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      }, 1_500);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    const short = buildLiteLLMHttpTransport(500);
    await expect(
      short.fetch(url, short.fetchOptions as RequestInit),
    ).rejects.toMatchObject({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    await short.fetchOptions.dispatcher.close();

    const long = buildLiteLLMHttpTransport(3_000);
    const response = await long.fetch(url, long.fetchOptions as RequestInit);
    expect(response.status).toBe(200);
    await long.fetchOptions.dispatcher.close();
  });
});
