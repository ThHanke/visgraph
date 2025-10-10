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

  // Allow wiring a runtime diagram/instance (e.g. a React Flow instance) after construction.
  // Callers can provide the instance so the LayoutManager can query runtime measurements
  // (for example React Flow's getNodes/getEdges) before computing layout.
  public setDiagram(diagram: any) {
    try {
      this.diagram = diagram ?? null;
    } catch {
      this.diagram = diagram ?? null;
    }
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
    {
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
    }
  }

  resetToOriginal(): void {
    // Clear stored history and, if possible, call a reset on the diagram
    this.lastPositions = [];
    {
      if (this.diagram && typeof this.diagram.resetPositions === 'function') {
        this.diagram.resetPositions();
      }
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
      // If a runtime diagram instance is available (for example a React Flow instance),
      // prefer to query it for nodes/edges so we can read runtime measurement metadata
      // (e.g. __rf.width/__rf.height). If measurements are not yet present we will await
      // a short readiness period so layouts use the actual node sizes.
      let diagramNodes: any[] = [];
      let diagramEdges: any[] = [];

      if (context && Array.isArray(context.nodes)) {
        diagramNodes = context.nodes;
      } else if (this.diagram && typeof (this.diagram as any).getNodes === 'function') {
        // Attempt to obtain measured nodes from diagram instance.
        try {
          diagramNodes = (this.diagram as any).getNodes() || [];
          // If nodes lack measurement metadata, allow a short wait for measurements to appear.
          const needsMeasurement = Array.isArray(diagramNodes) && diagramNodes.some((n: any) => {
            const meta = (n && (n as any).__rf) || {};
            return typeof meta.width !== 'number' || typeof meta.height !== 'number';
          });
          if (needsMeasurement) {
            // Wait up to a short timeout for measurements to appear, checking every RAF.
            // Increase timeout slightly and keep it conservative; if measurements still
            // missing we will attempt a DOM-measurement fallback so layout can use real sizes.
            const waitForMeasurements = async (timeoutMs = 2000) => {
              const start = Date.now();
              const rafWait = () =>
                new Promise((res) => {
                  try {
                    requestAnimationFrame(res);
                  } catch (_) {
                    setTimeout(res, 16);
                  }
                });
              while (Date.now() - start < timeoutMs) {
                // eslint-disable-next-line no-await-in-loop
                await rafWait();
                const rechecked = (this.diagram as any).getNodes() || [];
                const stillMissing = Array.isArray(rechecked) && rechecked.some((n: any) => {
                  const meta = (n && (n as any).__rf) || {};
                  return typeof meta.width !== 'number' || typeof meta.height !== 'number';
                });
                diagramNodes = rechecked;
                if (!stillMissing) break;
              }
            };
            // eslint-disable-next-line no-await-in-loop
            await waitForMeasurements();

            // If measurements are still missing, attempt a best-effort DOM fallback.
            // This queries the document for node elements using common React Flow data attributes
            // and patches width/height into the node objects so dagre can use real sizes.
            try {
              if (typeof document !== 'undefined' && Array.isArray(diagramNodes)) {
                const patched = (diagramNodes || []).map((n: any) => {
                  try {
                    const meta = (n && (n as any).__rf) || {};
                    if (typeof meta.width === 'number' && typeof meta.height === 'number') return n;
                    const id = String(n && n.id);
                    let el: Element | null = null;
                    // Try several likely selectors to find the node element in the DOM.
                    try { el = document.querySelector(`[data-nodeid="${id}"]`) || document.querySelector(`[data-id="${id}"]`) || document.querySelector(`.react-flow__node[data-id="${id}"]`); } catch (_) { el = null; }
                    if (el && typeof (el as any).getBoundingClientRect === 'function') {
                      const rect = (el as any).getBoundingClientRect();
                      const w = (rect && typeof rect.width === 'number') ? Math.round(rect.width) : undefined;
                      const h = (rect && typeof rect.height === 'number') ? Math.round(rect.height) : undefined;
                      if (typeof w === 'number' && typeof h === 'number') {
                        const copy = { ...(n || {}) };
                        try {
                          (copy as any).__rf = Object.assign({}, (copy as any).__rf || {}, { width: w, height: h });
                        } catch (_) { /* ignore */ }
                        return copy;
                      }
                    }
                  } catch (_) { /* ignore per-node fallback errors */ }
                  return n;
                });
                diagramNodes = patched;
              }
            } catch (_) { /* swallow DOM fallback errors */ }
          }
        } catch {
          // fallback to other sources below
          diagramNodes = [];
        }
      } else if (this.diagram && Array.isArray(this.diagram.nodes)) {
        diagramNodes = this.diagram.nodes;
      }

      if (context && Array.isArray(context.edges)) {
        diagramEdges = context.edges;
      } else if (this.diagram && typeof (this.diagram as any).getEdges === 'function') {
        try {
          diagramEdges = (this.diagram as any).getEdges() || [];
        } catch {
          diagramEdges = [];
        }
      } else if (this.diagram && Array.isArray(this.diagram.edges)) {
        diagramEdges = this.diagram.edges;
      }

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
