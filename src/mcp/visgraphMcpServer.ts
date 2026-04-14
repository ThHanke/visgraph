// src/mcp/visgraphMcpServer.ts
import { mcpManifest } from './manifest';
import { graphTools } from './tools/graph';
import { nodeTools } from './tools/nodes';
import { linkTools } from './tools/links';
import { searchTools } from './tools/search';
import { layoutTools } from './tools/layout';
import { reasoningTools } from './tools/reasoning';
import type { McpTool } from './types';

const allTools: McpTool[] = [
  ...graphTools,
  ...nodeTools,
  ...linkTools,
  ...searchTools,
  ...layoutTools,
  ...reasoningTools,
];

export async function registerMcpTools(): Promise<void> {
  const mc = (navigator as any).modelContext;
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
