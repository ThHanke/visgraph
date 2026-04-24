// src/mcp/tools/layout.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool, McpResult } from '@/mcp/types';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

export const VALID_ALGORITHMS = ['dagre-lr', 'dagre-tb', 'elk-layered', 'elk-force', 'elk-stress', 'elk-radial'] as const;
type Algorithm = typeof VALID_ALGORITHMS[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function focusElementOnCanvas(el: Reactodia.Element, ctx: Reactodia.WorkspaceContext): void {
  const canvas = ctx.view.findAnyCanvas();
  if (!canvas) return;
  const size = canvas.renderingState.getElementSize(el) ?? { width: 160, height: 80 };
  void canvas.zoomToFitRect(
    { x: el.position.x - 40, y: el.position.y - 40, width: size.width + 80, height: size.height + 80 },
    { animate: true, duration: 350 }
  );
}

export function fitCanvasView(ctx: Reactodia.WorkspaceContext): void {
  const canvas = ctx.view.findAnyCanvas();
  if (!canvas) return;
  const FIT_PADDING = 100;
  const bbox = Reactodia.getContentFittingBox(ctx.model.elements, ctx.model.links, canvas.renderingState);
  void canvas.zoomToFitRect({
    x: bbox.x - FIT_PADDING,
    y: bbox.y - FIT_PADDING,
    width: bbox.width + FIT_PADDING * 2,
    height: bbox.height + FIT_PADDING * 2,
  });
}

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
      // Normalise common short forms: "dagre" → "dagre-lr", "elk" → "elk-layered"
      const ALIASES: Record<string, string> = { dagre: 'dagre-lr', elk: 'elk-layered' };
      const raw = p.algorithm ?? '';
      const algorithm = ALIASES[raw] ?? raw;
      if (!(VALID_ALGORITHMS as readonly string[]).includes(algorithm)) {
        return {
          success: false,
          error: `Unknown algorithm: ${raw}. Valid: ${VALID_ALGORITHMS.join(', ')}`,
        };
      }

      const { ctx } = getWorkspaceRefs();

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

// ---------------------------------------------------------------------------
// focusNode
// ---------------------------------------------------------------------------
const focusNode: McpTool = {
  name: 'focusNode',
  description: 'Pan and zoom the viewport to centre on a specific node by IRI.',
  inputSchema: {
    type: 'object',
    properties: {
      iri: { type: 'string' },
    },
    required: ['iri'],
  },
  async handler(params): Promise<McpResult> {
    try {
      const { iri } = params as { iri: string };
      const { ctx } = getWorkspaceRefs();
      const el = ctx.model.elements.find(
        e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === iri
      ) as Reactodia.EntityElement | undefined;
      if (!el) return { success: false, error: `Element not on canvas: ${iri}` };
      focusElementOnCanvas(el, ctx);
      return { success: true, data: { iri } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// fitCanvas
// ---------------------------------------------------------------------------
const fitCanvas: McpTool = {
  name: 'fitCanvas',
  description: 'Fit the viewport to show all elements on the canvas.',
  inputSchema: { type: 'object' },
  async handler(): Promise<McpResult> {
    try {
      const { ctx } = getWorkspaceRefs();
      fitCanvasView(ctx);
      return { success: true, data: {} };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// clusterCanvas
// ---------------------------------------------------------------------------
const VALID_CLUSTER_ALGORITHMS = ['label-propagation', 'louvain', 'kmeans'] as const;
type ClusterAlgorithm = typeof VALID_CLUSTER_ALGORITHMS[number];

const clusterCanvas: McpTool = {
  name: 'clusterCanvas',
  description: 'Group canvas nodes into clusters using a graph-community algorithm. Fails if any node is already in a cluster.',
  inputSchema: {
    type: 'object',
    properties: {
      algorithm: {
        type: 'string',
        description: 'Clustering algorithm to apply.',
        enum: [...VALID_CLUSTER_ALGORITHMS],
      },
    },
    required: ['algorithm'],
  },
  async handler(params): Promise<McpResult> {
    try {
      const { algorithm } = params as { algorithm: string };
      if (!(VALID_CLUSTER_ALGORITHMS as readonly string[]).includes(algorithm)) {
        return {
          success: false,
          error: `Unknown algorithm: ${algorithm}. Valid: ${VALID_CLUSTER_ALGORITHMS.join(', ')}`,
        };
      }

      const { ctx } = getWorkspaceRefs();

      // Guard: check if any node is already in an EntityGroup
      const clusterMap = new Map<string, string>();
      for (const el of ctx.model.elements) {
        if (el instanceof Reactodia.EntityGroup) {
          for (const member of el.items) {
            if (member.data.id) clusterMap.set(member.data.id, el.id);
          }
        }
      }
      if (clusterMap.size > 0) {
        const conflicts = [...clusterMap.entries()].map(([iri, clusterId]) => ({ iri, clusterId }));
        return { success: false, error: `Some nodes are already in clusters: ${JSON.stringify(conflicts)}` };
      }

      const canvas = ctx.view.findAnyCanvas();
      if (!canvas) return { success: false, error: 'No canvas available' };

      const { applyCanvasClustering } = await import('@/components/Canvas/core/clusteringService');
      const { createDagreLayout } = await import('@/components/Canvas/layout/layouts');
      await applyCanvasClustering(ctx, canvas, algorithm as ClusterAlgorithm, createDagreLayout('LR', 120), true);

      return { success: true, data: { algorithm } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const layoutTools: McpTool[] = [runLayout, focusNode, fitCanvas, clusterCanvas];
