import { describe, expect, it } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import type { Config } from '../../src/schemas/index.js';
import {
  AmgAuthConfigError,
  describeAmgAuthentication,
  resolveAmgAuthentication,
} from '../../src/run/amg-auth.js';

const credential: TokenCredential = {
  async getToken() {
    return { token: 'entra-token', expiresOnTimestamp: Date.now() + 3600_000 };
  },
};

function config(auth: Config['amg']['auth']): Config {
  return {
    provider: 'litellm',
    litellm: {
      endpoint: 'https://litellm.example.com',
      model: 'gpt-test',
    },
    amg: {
      endpoint: 'https://example.grafana.azure.com',
      auth,
    },
  };
}

describe('AMG authentication resolution', () => {
  it('uses Entra credentials by default', () => {
    const resolved = resolveAmgAuthentication(config({ mode: 'entra' }), credential);
    expect(resolved.mode).toBe('entra');
  });

  it('resolves a service account token from token_env', () => {
    process.env.AZ_PIXIU_TEST_GRAFANA_TOKEN = 'glsa-from-env';
    try {
      const resolved = resolveAmgAuthentication(
        config({
          mode: 'service_account_token',
          token_env: 'AZ_PIXIU_TEST_GRAFANA_TOKEN',
        }),
        credential,
      );
      expect(resolved).toEqual({ mode: 'service_account_token', token: 'glsa-from-env' });
    } finally {
      delete process.env.AZ_PIXIU_TEST_GRAFANA_TOKEN;
    }
  });

  it('does not expose direct service account token values in the credential identity', () => {
    const identity = describeAmgAuthentication(
      config({ mode: 'service_account_token', token: 'glsa-secret' }),
      { implementation: 'AzureCliCredential', identity: '<az cli account>' },
    );
    expect(identity).toEqual({
      implementation: 'GrafanaServiceAccountToken',
      identity: 'config.amg.auth.token',
    });
  });

  it('fails when token_env is configured but unset', () => {
    delete process.env.AZ_PIXIU_TEST_MISSING_GRAFANA_TOKEN;
    expect(() =>
      resolveAmgAuthentication(
        config({
          mode: 'service_account_token',
          token_env: 'AZ_PIXIU_TEST_MISSING_GRAFANA_TOKEN',
        }),
        credential,
      ),
    ).toThrow(AmgAuthConfigError);
  });
});
