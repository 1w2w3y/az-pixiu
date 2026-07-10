import type { TokenCredential } from '@azure/identity';
import type { Config } from '../schemas/index.js';
import type { CredentialIdentity } from './credential-factory.js';
import type { LiveMCPAuthentication } from '../mcp/live.js';

export class AmgAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmgAuthConfigError';
  }
}

export function resolveAmgAuthentication(
  config: Config,
  credential: TokenCredential,
): LiveMCPAuthentication {
  const auth = config.amg.auth ?? { mode: 'entra' as const };
  if (auth.mode === 'entra') return { mode: 'entra', credential };

  const token = auth.token ?? (auth.token_env ? process.env[auth.token_env] : undefined);
  if (!token || token.trim().length === 0) {
    const source = auth.token_env ? `environment variable ${auth.token_env}` : 'config.amg.auth.token';
    throw new AmgAuthConfigError(`AMG service account token was not found in ${source}.`);
  }
  return { mode: 'service_account_token', token };
}

export function describeAmgAuthentication(
  config: Config,
  credentialIdentity: CredentialIdentity,
): CredentialIdentity {
  const auth = config.amg.auth ?? { mode: 'entra' as const };
  if (auth.mode === 'entra') return credentialIdentity;
  return {
    implementation: 'GrafanaServiceAccountToken',
    identity: auth.token_env ? `env:${auth.token_env}` : 'config.amg.auth.token',
  };
}
