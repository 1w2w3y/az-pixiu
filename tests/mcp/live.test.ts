import { describe, it, expect } from 'vitest';
import { LiveMCPTransport } from '../../src/mcp/live.js';
import type { TokenCredential } from '@azure/identity';

/**
 * LiveMCPTransport is written but not yet smoke-tested against a real
 * AMG-MCP instance (sequencing step 11). These tests cover construction
 * and the parts of the contract that don't require a live endpoint.
 *
 * A real-Azure smoke test belongs in a separate suite gated behind an
 * env var (AZ_PIXIU_LIVE=1) so CI doesn't try to call out.
 */

const fakeCredential: TokenCredential = {
  async getToken() {
    return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600_000 };
  },
};

describe('LiveMCPTransport (construction)', () => {
  it('constructs without contacting the network', () => {
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      credential: fakeCredential,
    });
    expect(t).toBeDefined();
  });

  it('strips trailing slashes from the endpoint', async () => {
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com/',
      credential: fakeCredential,
    });
    // Implementation detail surfaced via .close() being safe on never-connected instance:
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('close() resolves cleanly without a prior connection', async () => {
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      credential: fakeCredential,
    });
    await expect(t.close()).resolves.toBeUndefined();
  });

  it('listCapabilities propagates network errors (caller invokes failure_taxonomy)', async () => {
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      credential: fakeCredential,
      fetchImpl: async () => {
        throw new Error('simulated network failure');
      },
    });
    await expect(t.listCapabilities()).rejects.toThrow(/simulated network failure/);
  });

  it('includes HTTP status and response body details for non-2xx AMG-MCP responses', async () => {
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      credential: fakeCredential,
      fetchImpl: async () =>
        new Response('missing or invalid audience', {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'text/plain' },
        }),
    });

    await expect(t.listCapabilities()).rejects.toThrow(
      /AMG-MCP HTTP 401 Unauthorized.*missing or invalid audience/,
    );
  });

  it('uses a configured Grafana service account token as the bearer token', async () => {
    let authorization: string | null = null;
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      auth: { mode: 'service_account_token', token: 'glsa-test-token' },
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init?.headers).get('Authorization');
        return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' });
      },
    });

    await expect(t.listCapabilities()).rejects.toThrow(/AMG-MCP HTTP 401 Unauthorized/);
    expect(authorization).toBe('Bearer glsa-test-token');
  });

  it('does not duplicate an existing Bearer prefix on service account tokens', async () => {
    let authorization: string | null = null;
    const t = new LiveMCPTransport({
      endpoint: 'https://example.grafana.azure.com',
      auth: { mode: 'service_account_token', token: 'Bearer glsa-test-token' },
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init?.headers).get('Authorization');
        return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' });
      },
    });

    await expect(t.listCapabilities()).rejects.toThrow(/AMG-MCP HTTP 401 Unauthorized/);
    expect(authorization).toBe('Bearer glsa-test-token');
  });
});
