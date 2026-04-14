// src/mcp/register.ts
export function registerMcp(): void {
  if (typeof navigator === 'undefined' || !('modelContext' in navigator)) {
    return;
  }
  import('./visgraphMcpServer').then(({ registerMcpTools }) => {
    registerMcpTools().catch(err => {
      console.error('[MCP] Failed to register tools:', err);
    });
  });
}
