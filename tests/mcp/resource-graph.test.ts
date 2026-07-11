import { describe, expect, it } from 'vitest';

import { scopeResourceGraphQuery } from '../../src/mcp/resource-graph.js';

describe('scopeResourceGraphQuery', () => {
  it('inserts a supported KQL subscription predicate immediately after Resources', () => {
    const query = scopeResourceGraphQuery(
      'Resources | summarize count_=count() by type',
      [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    );

    expect(query).toBe(
      "Resources | where subscriptionId in~ ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222') | summarize count_=count() by type",
    );
  });

  it('deduplicates case-insensitively and Kusto-escapes string literals', () => {
    const query = scopeResourceGraphQuery('Resources', ["A'B\\C\nD", "a'b\\c\nd"]);
    expect(query).toBe("Resources | where subscriptionId in~ ('A\\'B\\\\C\\nD')");
  });

  it('adds optional resource-group and resource-type boundaries without unsupported wire parameters', () => {
    const query = scopeResourceGraphQuery('Resources | project id', ['sub-a'], {
      resourceGroupNames: ["rg-o'hare", "RG-O'HARE"],
      resourceTypes: ['microsoft.compute/virtualmachines'],
    });
    expect(query).toBe(
      "Resources | where subscriptionId in~ ('sub-a') | where resourceGroup in~ ('rg-o\\'hare') | where type in~ ('microsoft.compute/virtualmachines') | project id",
    );
  });

  it('rejects an empty scope or a query outside the Resources table', () => {
    expect(() => scopeResourceGraphQuery('Resources', [])).toThrow(/at least one subscription/i);
    expect(() => scopeResourceGraphQuery('ResourceContainers', ['sub-a'])).toThrow(/rooted at Resources/i);
    expect(() => scopeResourceGraphQuery('ResourcesExtra', ['sub-a'])).toThrow(/rooted at Resources/i);
    expect(() =>
      scopeResourceGraphQuery('Resources', ['sub-a'], { resourceGroupNames: ['   '] }),
    ).toThrow(/blank resource group/i);
  });
});
