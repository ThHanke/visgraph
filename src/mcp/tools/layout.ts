// src/mcp/tools/layout.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

export const VALID_ALGORITHMS = ['dagre-lr', 'dagre-tb', 'elk-layered', 'elk-force', 'elk-stress', 'elk-radial'] as const;
type Algorithm = typeof VALID_ALGORITHMS[number];

// ---------------------------------------------------------------------------
// runLayout
// ---------------------------------------------------------------------------
const runLayout: McpTool = {
  name: 'runLayout',
  description: 'Apply a layout algorithm to the current graph on the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      algorithm: {
        type: 'string',
        description: 'Layout algorithm to apply.',
        enum: [...VALID_ALGORITHMS],
      },
    },
    required: ['algorithm'],
  },
  async handler(params): Promise<McpResult> {
    try {
      const p = params as { algorithm?: string };
      const algorithm = p.algorithm ?? '';
      if (!(VALID_ALGORITHMS as readonly string[]).includes(algorithm)) {
        return {
          success: false,
          error: `Unknown algorithm: ${algorithm}. Valid: ${VALID_ALGORITHMS.join(', ')}`,
        };
      }

      const { ctx } = getWorkspaceRefs();

      // Resolve a layoutFunction for the requested algorithm.
      // We import lazily so that worker constructors are only called at
      // runtime (not during module load / node-env tests).
      const { createDagreLayout, createElkLayout } = await import(
        '@/components/Canvas/layout/layouts'
      );
      const spacing = 120;
      let layoutFunction;
      switch (algorithm as Algorithm) {
        case 'dagre-lr':
          layoutFunction = createDagreLayout('LR', spacing);
          break;
        case 'dagre-tb':
          layoutFunction = createDagreLayout('TB', spacing);
          break;
        case 'elk-layered':
          layoutFunction = createElkLayout('layered', spacing);
          break;
        case 'elk-force':
          layoutFunction = createElkLayout('force', spacing);
          break;
        case 'elk-stress':
          layoutFunction = createElkLayout('stress', spacing);
          break;
        case 'elk-radial':
          layoutFunction = createElkLayout('radial', spacing);
          break;
      }

      await ctx.performLayout({ layoutFunction, animate: true });
      return { success: true, data: { algorithm } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const layoutTools: McpTool[] = [runLayout];
