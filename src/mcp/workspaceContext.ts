// src/mcp/workspaceContext.ts
import type * as Reactodia from '@reactodia/workspace';
import type { N3DataProvider } from '@/providers/N3DataProvider';

interface WorkspaceRefs {
  ctx: Reactodia.WorkspaceContext;
  dataProvider: N3DataProvider;
}

let refs: WorkspaceRefs | null = null;

export function setWorkspaceContext(
  ctx: Reactodia.WorkspaceContext,
  dataProvider: N3DataProvider
): void {
  refs = { ctx, dataProvider };
}

export function getWorkspaceRefs(): WorkspaceRefs {
  if (!refs) throw new Error('[MCP] WorkspaceContext not yet initialised');
  return refs;
}
