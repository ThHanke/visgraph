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
        description: 'Layout algorithm to apply. Defaults to elk-layered.',
        enum: [...VALID_ALGORITHMS],
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const p = params as { algorithm?: string };
      // Normalise common short forms: "dagre" → "dagre-lr", "elk" → "elk-layered"
      const ALIASES: Record<string, string> = { dagre: 'dagre-lr', elk: 'elk-layered' };
      const raw = p.algorithm ?? 'elk-layered';
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
// clusterNodes
// ---------------------------------------------------------------------------
const VALID_CLUSTER_ALGORITHMS = ['label-propagation', 'louvain', 'kmeans'] as const;
type ClusterAlgorithm = typeof VALID_CLUSTER_ALGORITHMS[number];

const clusterNodes: McpTool = {
  name: 'clusterNodes',
  description: 'Group canvas nodes into clusters. Provide `iris` to group exactly those nodes directly, or provide `algorithm` to run community-detection on all canvas nodes. Fails if any target node is already in a cluster.',
  inputSchema: {
    type: 'object',
    properties: {
      iris: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of node IRIs to group. When provided, groups exactly these nodes without running a community algorithm.',
      },
      algorithm: {
        type: 'string',
        description: 'Community-detection algorithm. Required when iris is not provided.',
        enum: [...VALID_CLUSTER_ALGORITHMS],
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const p = params as { iris?: string[]; algorithm?: string };
      const { ctx } = getWorkspaceRefs();

      if (p.iris !== undefined) {
        // --- Direct grouping by IRI subset ---
        const iris = p.iris;

        // Validate: all IRIs must be EntityElement on canvas
        const nonCanvas: string[] = [];
        const members: Reactodia.EntityElement[] = [];
        for (const iri of iris) {
          const el = ctx.model.elements.find(
            e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === iri
          ) as Reactodia.EntityElement | undefined;
          if (!el) nonCanvas.push(iri);
          else members.push(el);
        }
        if (nonCanvas.length > 0) {
          return { success: false, error: `IRIs not on canvas: ${nonCanvas.join(', ')}` };
        }

        // Validate: none already in a cluster
        const conflicts: { iri: string; clusterId: string }[] = [];
        for (const el of ctx.model.elements) {
          if (el instanceof Reactodia.EntityGroup) {
            for (const member of el.items) {
              if (member.data.id && iris.includes(member.data.id)) {
                conflicts.push({ iri: member.data.id, clusterId: el.id });
              }
            }
          }
        }
        if (conflicts.length > 0) {
          return { success: false, error: `Some nodes are already in clusters: ${JSON.stringify(conflicts)}` };
        }

        ctx.model.group(members);
        return { success: true, data: { grouped: iris } };
      } else {
        // --- Community-detection algorithm on all canvas nodes ---
        const { algorithm } = p;
        if (!algorithm) {
          return { success: false, error: 'Either `iris` or `algorithm` must be provided.' };
        }
        if (!(VALID_CLUSTER_ALGORITHMS as readonly string[]).includes(algorithm)) {
          return {
            success: false,
            error: `Unknown algorithm: ${algorithm}. Valid: ${VALID_CLUSTER_ALGORITHMS.join(', ')}`,
          };
        }

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
          const conflictsList = [...clusterMap.entries()].map(([iri, clusterId]) => ({ iri, clusterId }));
          return { success: false, error: `Some nodes are already in clusters: ${JSON.stringify(conflictsList)}` };
        }

        const canvas = ctx.view.findAnyCanvas();
        if (!canvas) return { success: false, error: 'No canvas available' };

        const { applyCanvasClustering } = await import('@/components/Canvas/core/clusteringService');
        const { createDagreLayout } = await import('@/components/Canvas/layout/layouts');
        await applyCanvasClustering(ctx, canvas, algorithm as ClusterAlgorithm, createDagreLayout('LR', 120), true);

        return { success: true, data: { algorithm } };
      }
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// layoutNodes
// ---------------------------------------------------------------------------
const layoutNodes: McpTool = {
  name: 'layoutNodes',
  description: 'Lay out a named subset of canvas nodes together in a free area, pan the viewport to them, and return the bounding box. Fails if any IRI is not on the canvas or is inside a cluster.',
  inputSchema: {
    type: 'object',
    properties: {
      iris: {
        type: 'array',
        items: { type: 'string' },
        description: 'IRIs of the canvas nodes to lay out together.',
      },
      algorithm: {
        type: 'string',
        description: 'Layout algorithm to apply to the subset. Defaults to elk-layered.',
        enum: [...VALID_ALGORITHMS],
      },
    },
    required: ['iris'],
  },
  async handler(params): Promise<McpResult> {
    try {
      const p = params as { iris?: string[]; algorithm?: string };
      const iris = p.iris ?? [];
      if (iris.length === 0) {
        return { success: false, error: 'iris must be a non-empty array' };
      }

      // Resolve algorithm
      const ALIASES: Record<string, string> = { dagre: 'dagre-lr', elk: 'elk-layered' };
      const raw = p.algorithm ?? 'elk-layered';
      const algorithm = ALIASES[raw] ?? raw;
      if (!(VALID_ALGORITHMS as readonly string[]).includes(algorithm)) {
        return {
          success: false,
          error: `Unknown algorithm: ${raw}. Valid: ${VALID_ALGORITHMS.join(', ')}`,
        };
      }

      const { ctx } = getWorkspaceRefs();

      // Build cluster membership map
      const clusterMap = new Map<string, string>();
      for (const el of ctx.model.elements) {
        if (el instanceof Reactodia.EntityGroup) {
          for (const member of el.items) {
            if (member.data.id) clusterMap.set(member.data.id, el.id);
          }
        }
      }

      // Validate: all IRIs must be EntityElement on canvas
      const entityElements = new Map<string, Reactodia.EntityElement>();
      for (const el of ctx.model.elements) {
        if (el instanceof Reactodia.EntityElement) {
          entityElements.set((el as Reactodia.EntityElement).iri, el as Reactodia.EntityElement);
        }
      }

      const nonCanvas: string[] = [];
      for (const iri of iris) {
        if (!entityElements.has(iri)) nonCanvas.push(iri);
      }
      if (nonCanvas.length > 0) {
        return { success: false, error: `IRIs not on canvas: ${nonCanvas.join(', ')}` };
      }

      // Validate: none may be in a cluster
      const clustered: { iri: string; clusterId: string }[] = [];
      for (const iri of iris) {
        const clusterId = clusterMap.get(iri);
        if (clusterId) clustered.push({ iri, clusterId });
      }
      if (clustered.length > 0) {
        return { success: false, error: `Some nodes are inside clusters: ${JSON.stringify(clustered)}` };
      }

      const selectedElements = iris.map(iri => entityElements.get(iri)!);

      // Resolve layout function
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

      // Run layout on subset — performLayout expects ReadonlySet<Element>, not IRIs
      // animate:false so positions are committed synchronously before we compute bboxes
      const selectedElementSet = new Set<Reactodia.Element>(selectedElements);
      await ctx.performLayout({ layoutFunction, animate: false, selectedElements: selectedElementSet });

      const canvas = ctx.view.findAnyCanvas();
      if (!canvas) return { success: false, error: 'No canvas available' };

      // Wait for layout spinner to clear, then flush rendering state
      await new Promise<void>(resolve => {
        const check = () => {
          const s = (globalThis as any).__VG_LAST_CANVAS_LOADING;
          if (!s || !s.loading) { resolve(); return; }
          setTimeout(check, 100);
        };
        setTimeout(check, 100);
      });
      canvas.renderingState.syncUpdate();

      // Compute bounding box of all other elements
      const iriSet = new Set(iris);
      const otherElements = ctx.model.elements.filter(
        el => el instanceof Reactodia.EntityElement && !iriSet.has((el as Reactodia.EntityElement).iri)
      ) as Reactodia.Element[];
      // Links between other elements only (approximate: use all non-subset links)
      const otherLinks = ctx.model.links.filter(
        lk => !iriSet.has((lk.sourceId as unknown as string)) && !iriSet.has((lk.targetId as unknown as string))
      );

      if (otherElements.length > 0) {
        const otherBbox = Reactodia.getContentFittingBox(otherElements, otherLinks, canvas.renderingState);
        const subsetBbox = Reactodia.getContentFittingBox(selectedElements, [], canvas.renderingState);
        const dx = (otherBbox.x + otherBbox.width + 120) - subsetBbox.x;
        const dy = otherBbox.y - subsetBbox.y;

        await canvas.animateGraph(() => {
          for (const el of selectedElements) {
            el.setPosition({ x: el.position.x + dx, y: el.position.y + dy });
          }
        });
      }

      // Compute final bbox of subset for viewport
      const finalBbox = Reactodia.getContentFittingBox(selectedElements, [], canvas.renderingState);
      const PAD = 40;
      void canvas.zoomToFitRect(
        { x: finalBbox.x - PAD, y: finalBbox.y - PAD, width: finalBbox.width + PAD * 2, height: finalBbox.height + PAD * 2 },
        { animate: true, duration: 350 }
      );

      return {
        success: true,
        data: {
          placed: iris,
          boundingBox: finalBbox,
          suggestedFocusIri: iris[0],
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const layoutTools: McpTool[] = [runLayout, focusNode, fitCanvas, clusterNodes, layoutNodes];
