// src/mcp/types.ts
import type { JSONSchema7 } from 'json-schema';

export interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

export interface McpTool extends McpToolManifestEntry {
  handler: (params: unknown) => Promise<McpResult>;
}

export type McpResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
