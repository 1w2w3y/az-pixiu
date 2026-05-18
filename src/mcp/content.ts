import type { ToolCallResult } from '../schemas/index.js';

/**
 * MCP-standard content extraction helpers.
 *
 * Real AMG-MCP responses follow the MCP wire shape:
 *   { content: [{ type: "text", text: "<JSON-stringified-or-error>" }, ...] }
 *
 * The synthetic fixture used during early Phase 1 development took the
 * shortcut of putting JSON directly in `content`. Live responses don't —
 * they wrap their payload (or their error) inside an `{type:"text"}` item.
 *
 * These helpers normalize that:
 *   - extractText concatenates all `{type:"text"}` items into one string
 *   - tryParseJson tries to parse that string as JSON (returns undefined
 *     if it isn't valid JSON, which is fine for plain-text responses)
 *   - isWrappedError detects AMG-MCP's pattern of returning a successful
 *     tool result whose text begins with "An error occurred invoking …".
 *     Those are downstream-data-source failures (e.g., Grafana Azure
 *     Monitor data source can't authenticate to Azure) wrapped as a 200
 *     OK from the MCP server's perspective.
 */

interface MCPTextContentItem {
  type: 'text';
  text: string;
}

export function extractText(result: ToolCallResult): string {
  const content = result.content;
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      (item as { type: unknown }).type === 'text' &&
      'text' in item &&
      typeof (item as { text: unknown }).text === 'string'
    ) {
      parts.push((item as MCPTextContentItem).text);
    }
  }
  return parts.join('\n');
}

export function tryParseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const WRAPPED_ERROR_PATTERNS: readonly RegExp[] = [
  /^An error occurred invoking/i,
  /err_calling_grafana_api/i,
  /StatusCode:\s*(Internal|BadRequest|Unauthorized|Forbidden|NotFound|ServiceUnavailable)/i,
  /invalid_grant/i,
  /not authenticated/i,
  /access denied/i,
];

export function isWrappedError(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return WRAPPED_ERROR_PATTERNS.some((p) => p.test(t));
}

/** Classify a wrapped error to a DataQualityCategory-compatible class. */
export function classifyWrappedError(text: string): 'auth' | 'authz_gap' | 'schema_mismatch' {
  const lower = text.toLowerCase();
  if (
    lower.includes('not authenticated') ||
    lower.includes('invalid_grant') ||
    lower.includes('unauthorized')
  ) {
    return 'auth';
  }
  if (
    lower.includes('forbidden') ||
    lower.includes('access denied') ||
    lower.includes('insufficient')
  ) {
    return 'authz_gap';
  }
  return 'schema_mismatch';
}
