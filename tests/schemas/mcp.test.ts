import { describe, it, expect } from 'vitest';
import {
  CapabilityDescriptorSchema,
  CapabilityCatalogSchema,
  ToolCallResultSchema,
} from '../../src/schemas/index.js';

describe('CapabilityDescriptorSchema', () => {
  it('accepts a minimal descriptor', () => {
    expect(CapabilityDescriptorSchema.safeParse({ name: 'cost_analysis' }).success).toBe(true);
  });

  it('accepts a fully-populated descriptor', () => {
    const result = CapabilityDescriptorSchema.safeParse({
      name: 'cost_analysis',
      description: 'Cost breakdown',
      version: '1.0.0',
      inputSchema: { type: 'object' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(CapabilityDescriptorSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects an empty version string', () => {
    expect(
      CapabilityDescriptorSchema.safeParse({ name: 'a', version: '' }).success,
    ).toBe(false);
  });

  it('preserves unknown fields (passthrough — for AMG-MCP forward-compat)', () => {
    const result = CapabilityDescriptorSchema.safeParse({
      name: 'a',
      annotations: { mutating: false },
    });
    if (!result.success) throw new Error('expected parse');
    expect((result.data as { annotations?: { mutating: boolean } }).annotations?.mutating).toBe(
      false,
    );
  });
});

describe('CapabilityCatalogSchema', () => {
  it('accepts an empty capability list', () => {
    expect(CapabilityCatalogSchema.safeParse({ capabilities: [] }).success).toBe(true);
  });

  it('accepts a multi-capability catalog', () => {
    expect(
      CapabilityCatalogSchema.safeParse({
        capabilities: [{ name: 'a' }, { name: 'b', version: '1.0' }],
      }).success,
    ).toBe(true);
  });

  it('rejects when capabilities array is missing', () => {
    expect(CapabilityCatalogSchema.safeParse({}).success).toBe(false);
  });

  it('rejects when a descriptor in the list is malformed', () => {
    expect(
      CapabilityCatalogSchema.safeParse({ capabilities: [{ name: '' }] }).success,
    ).toBe(false);
  });
});

describe('ToolCallResultSchema', () => {
  it('accepts a typical tool result', () => {
    expect(
      ToolCallResultSchema.safeParse({ content: { rows: [] }, isError: false }).success,
    ).toBe(true);
  });

  it('accepts a result with isError omitted', () => {
    expect(ToolCallResultSchema.safeParse({ content: 'text' }).success).toBe(true);
  });

  it('accepts arbitrary content shape (z.unknown())', () => {
    expect(ToolCallResultSchema.safeParse({ content: null }).success).toBe(true);
    expect(ToolCallResultSchema.safeParse({ content: [1, 2, 3] }).success).toBe(true);
  });

  it('rejects a non-object input', () => {
    expect(ToolCallResultSchema.safeParse(42).success).toBe(false);
    expect(ToolCallResultSchema.safeParse('hello').success).toBe(false);
  });

  it('rejects when isError is non-boolean', () => {
    expect(
      ToolCallResultSchema.safeParse({ content: {}, isError: 'no' }).success,
    ).toBe(false);
  });
});
