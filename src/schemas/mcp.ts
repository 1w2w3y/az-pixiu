import { z } from 'zod';

// ---------- MCP boundary types (§4.3, §13) ----------
// These shapes mirror what AMG-MCP returns. We use passthrough() so that
// fields we don't yet model (additional metadata, annotations, server
// extensions) are preserved through the transport rather than silently
// dropped — they may be useful for capability_versions or the
// failure_taxonomy later.

export const CapabilityDescriptorSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().min(1).optional(),
    inputSchema: z.unknown().optional(),
  })
  .passthrough();

export const CapabilityCatalogSchema = z
  .object({
    capabilities: z.array(CapabilityDescriptorSchema),
  })
  .passthrough();

export const ToolCallResultSchema = z
  .object({
    content: z.unknown(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
