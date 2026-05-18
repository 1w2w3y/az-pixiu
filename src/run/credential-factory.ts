import {
  AzureCliCredential,
  DefaultAzureCredential,
  type TokenCredential,
} from '@azure/identity';

/**
 * Credential factory (design §15.9). Phase 1 supports three modes:
 *   - 'azure-cli' — the default for local workstation use. Requires
 *     `az login` to have been run.
 *   - 'default' — DefaultAzureCredential, useful for CI / managed
 *     identity / env-var-driven contexts.
 *   - 'mock' — returns a fake token. Only for tests and dry-run modes.
 *
 * The chosen mode lands on RunMetadata.credential_source.implementation
 * so the run is attributable.
 */

export type CredentialMode = 'azure-cli' | 'default' | 'mock';

export interface CredentialIdentity {
  implementation: string;
  identity: string;
}

export function buildCredential(mode: CredentialMode): TokenCredential {
  switch (mode) {
    case 'azure-cli':
      return new AzureCliCredential();
    case 'default':
      return new DefaultAzureCredential();
    case 'mock':
      return {
        async getToken() {
          return { token: 'mock-token', expiresOnTimestamp: Date.now() + 3600_000 };
        },
      };
  }
}

export function describeCredential(mode: CredentialMode): CredentialIdentity {
  switch (mode) {
    case 'azure-cli':
      return { implementation: 'AzureCliCredential', identity: '<az cli account>' };
    case 'default':
      return { implementation: 'DefaultAzureCredential', identity: '<resolved-at-token-time>' };
    case 'mock':
      return { implementation: 'MockCredential', identity: 'mock' };
  }
}
