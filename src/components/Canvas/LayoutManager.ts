export type LayoutType = 'horizontal' | 'vertical';

export interface LayoutOptions {
  animationDuration?: number;
  animated?: boolean;
  nodeSpacing?: number;
  layoutSpecific?: Record<string, any>;
}

export interface LayoutConfig {
  type: LayoutType;
  label: string;
  description?: string;
  icon?: string;
}

/**
 * Lightweight, -free LayoutManager
 *
 * This module intentionally provides a minimal, dependency-free API surface
 * that the UI (LayoutToolbar and other callers) can use. It does not depend
 * on  or any  types. It implements simple, synchronous layout helpers
 * and a no-op applyLayout that callers can await.
 *
 * The project previously used a -backed implementation. That dependency
 * has been removed; this file preserves the exported types and methods so the
 * rest of the codebase can compile and run without .
 */
export class LayoutManager {
  // Optional runtime diagram handle (framework-agnostic)
  private diagram: any;

  // Keep a simple stack of previous positions when callers request restore
  private lastPositions: Record<string, { x: number; y: number }>[] = [];

  constructor(diagram?: any) {
    this.diagram = diagram ?? null;
  }

  // Return a conservative set of supported layouts for the UI
  getAvailableLayouts(): LayoutConfig[] {
    // Reduced set: provide two explicit dagre-driven layouts exposed to the UI.
    return [
      {
        type: 'horizontal',
        label: 'Horizontal (Dagre)',
        description: 'Left-to-right layered layout using dagre',
        icon: 'Layers',
      },
      {
        type: 'vertical',
        label: 'Vertical (Dagre)',
        description: 'Top-to-bottom layered layout using dagre',
        icon: 'TreePine',
      },
    ];
  }

  suggestOptimalLayout(): LayoutType {
    // Conservative default: prefer the horizontal dagre layout for most graphs.
    return 'horizontal';
  }

  restoreLastPositions(): void {
    if (!this.diagram) return;
    const last = this.lastPositions.pop();
    if (!last) return;
    try {
      // attempt to set node positions if diagram exposes setNodePosition-like API
      if (typeof this.diagram.setNodePositions === 'function') {
        this.diagram.setNodePositions(last);
        return;
      }
      // generic fallback: assume diagram.nodes is an array of { id, position }
      if (Array.isArray(this.diagram.nodes)) {
        this.diagram.nodes = this.diagram.nodes.map((n: any) => {
          const pos = last[n.id];
          return pos ? { ...n, position: pos } : n;
        });
      }
    } catch {
      // swallow errors — this manager is intentionally lightweight
    }
  }

  resetToOriginal(): void {
    // Clear stored history and, if possible, call a reset on the diagram
    this.lastPositions = [];
    try {
      if (this.diagram && typeof this.diagram.resetPositions === 'function') {
        this.diagram.resetPositions();
      }
    } catch {
      // ignore
    }
  }

  getCurrentLayoutInfo(): { type: LayoutType; options: LayoutOptions } {
    // No internal state tracked beyond last call; return a sensible default
    return { type: this.suggestOptimalLayout(), options: {} };
  }

  // Import dagre-based helper lazily to avoid introducing a hard runtime dependency
  // when this module is used in non-ReactFlow contexts.
  //
  // Full-integration change:
  // - applyLayout now accepts an optional context parameter containing { nodes, edges }
  //   and returns an array of node change objects that callers should apply via
  //   React Flow's applyNodeChanges. This avoids mutating external diagram objects
  //   and makes layout results explicit and race-free.
  async applyLayout(
    layoutType: LayoutType,
    options: LayoutOptions = {},
    context?: { nodes?: any[]; edges?: any[] },
  ): Promise<Array<any>> {
    try {
      // Prefer context-provided nodes/edges, fall back to internal diagram when present.
      const diagramNodes = (context && Array.isArray(context.nodes) ? context.nodes : (this.diagram && Array.isArray(this.diagram.nodes) ? this.diagram.nodes : [])) || [];
      const diagramEdges = (context && Array.isArray(context.edges) ? context.edges : (this.diagram && Array.isArray(this.diagram.edges) ? this.diagram.edges : [])) || [];

      // Capture current positions (for undo/restore) using either context or diagram snapshot.
      try {
        const sourceNodes = diagramNodes;
        const snapshot: Record<string, { x: number; y: number }> = {};
        for (const n of sourceNodes) {
          const pos = (n && n.position) || { x: NaN, y: NaN };
          snapshot[n.id] = { x: (pos.x as number) || 0, y: (pos.y as number) || 0 };
        }
        this.lastPositions.push(snapshot);
      } catch {
        // ignore snapshot failures
      }

      // If the diagram exposes a layout API and no context was provided, prefer delegation.
      if (!context && this.diagram && typeof this.diagram.applyLayout === 'function') {
        await Promise.resolve(this.diagram.applyLayout(layoutType, options));
        // Attempt to read resulting positions into change objects
        const resulting = (this.diagram && Array.isArray(this.diagram.nodes)) ? this.diagram.nodes : [];
        return (resulting || []).map((n: any) => ({ id: String(n.id), type: "position", position: n.position }));
      }

      // Handle dagre-driven layouts when nodes array available
      if (Array.isArray(diagramNodes) && (layoutType === 'horizontal' || layoutType === 'vertical')) {
        try {
          const { applyDagreLayout } = await import('./layout/dagreLayout');
          const direction = layoutType === 'horizontal' ? 'LR' : 'TB';
          // Use the single spacing parameter from the layout dialog as the base spacing.
          // Pass it as both nodeSep and rankSep so the dagre helper can add node-size
          // adjustments internally (final separation = baseSpacing + max node size).
          const baseSpacing = options.nodeSpacing ?? (options.layoutSpecific && options.layoutSpecific.nodeSep) ?? 60;
          const nodeSep = baseSpacing;
          const rankSep = baseSpacing;

          const positioned = applyDagreLayout(diagramNodes, diagramEdges || [], {
            direction: direction as any,
            nodeSep,
            rankSep,
          });

          // Return position change objects (caller will apply them via applyNodeChanges)
          return (positioned || []).map((n: any) => ({ id: String(n.id), type: "position", position: n.position }));
        } catch (err) {
          // swallow dagre/layout failures and continue to fallback grid layout
        }
      }

      // Generic grid layout fallback
      if (Array.isArray(diagramNodes)) {
        const total = diagramNodes.length;
        const cols = Math.ceil(Math.sqrt(Math.max(1, total)));
        const spacingX = options.nodeSpacing ?? 160;
        const spacingY = (options.layoutSpecific && options.layoutSpecific.rankSep) ?? (options.nodeSpacing ?? 120);

        const positioned = (diagramNodes || []).map((node: any, i: number) => {
          const x = (i % cols) * spacingX;
          const y = Math.floor(i / cols) * spacingY;
          return { ...node, position: { x, y } };
        });

        return (positioned || []).map((n: any) => ({ id: String(n.id), type: "position", position: n.position }));
      }

      // Nothing to layout -> return empty changes
      return [];
    } catch {
      // Ensure we always resolve with an array
      return [];
    }
  }
}
