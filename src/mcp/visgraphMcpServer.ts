// src/mcp/visgraphMcpServer.ts
import { mcpManifest } from './manifest';
import { graphTools } from './tools/graph';
import { nodeTools } from './tools/nodes';
import { linkTools } from './tools/links';
import { layoutTools } from './tools/layout';
import { reasoningTools } from './tools/reasoning';
import { namespaceTools } from './tools/namespaceTools';
import { navigationTools } from './tools/navigation';
import { shaclTools } from './tools/shacl';
import type { McpTool } from './types';

const allTools: McpTool[] = [
  ...graphTools,
  ...nodeTools,
  ...linkTools,
  ...layoutTools,
  ...reasoningTools,
  ...namespaceTools,
  ...navigationTools,
  ...shaclTools,
];

export async function registerMcpTools(): Promise<void> {
  // Build the tool map unconditionally so the relay bridge can use it
  // even in browsers without the navigator.modelContext MCP polyfill.
  const toolMap: Record<string, (params: unknown) => Promise<import('./types').McpResult>> = {};
  for (const tool of allTools) {
    toolMap[tool.name] = (params: unknown) => tool.handler(params);
  }
  window.__mcpTools = toolMap;

  const mc = (navigator as any).modelContext;
  if (!mc) {
    console.warn('[MCP] navigator.modelContext not available; skipping tool registration');
    return;
  }
  for (const entry of mcpManifest) {
    const tool = allTools.find(t => t.name === entry.name);
    if (!tool) {
      console.warn(`[MCP] No handler found for tool: ${entry.name}`);
      continue;
    }
    await mc.registerTool(
      entry.name,
      entry.description,
      entry.inputSchema,
      async (params: unknown) => tool.handler(params)
    );
  }
  console.log(`[MCP] Registered ${mcpManifest.length} tools via navigator.modelContext`);
}
