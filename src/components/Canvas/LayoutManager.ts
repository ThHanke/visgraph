import { ELK_ALGORITHMS } from './layout/elkLayoutConfig';

export type LayoutType = 'horizontal' | 'vertical' | 'elk-layered' | 'elk-force' | 'elk-stress';

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
    // Dagre layouts (existing)
    const dagreLayouts: LayoutConfig[] = [
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

    // ELK layouts (new)
    const elkLayouts: LayoutConfig[] = Object.entries(ELK_ALGORITHMS).map(([key, config]: [string, any]) => ({
      type: `elk-${key}` as LayoutType,
      label: config.label,
      description: config.description,
      icon: config.icon,
    }));

    return [...dagreLayouts, ...elkLayouts];
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
    context?: { nodes?: any[]; edges?: any[]; manualMeasurements?: Map<string, { width: number; height: number }> },
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
            // Wait up to a SHORT timeout for measurements to appear, checking every RAF.
            // CRITICAL: Keep timeout low (300ms) to avoid blocking the UI when layout is triggered
            // from user interactions (e.g., dialog buttons). Longer waits can make the browser
            // think the page is frozen. If measurements still missing after timeout, we fall back
            // to DOM measurements below.
            const waitForMeasurements = async (timeoutMs = 300) => {
              const start = Date.now();
              const rafWait = () =>
                new Promise((res) => {
                  try {
                    requestAnimationFrame(res);
                  } catch (_) {
                    // In non-browser/test environments schedule a microtask instead of a real timeout
                    if (typeof window === "undefined") {
                      Promise.resolve().then(res);
                    } else {
                      setTimeout(res, 16);
                    }
                  }
                });
              
              // Limit iterations to avoid infinite loops
              let iterations = 0;
              const maxIterations = 20; // ~320ms at 16ms/iteration
              
              while (Date.now() - start < timeoutMs && iterations < maxIterations) {
                iterations++;
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
            
            try {
              // eslint-disable-next-line no-await-in-loop
              await waitForMeasurements();
            } catch (err) {
              // Swallow measurement wait errors and proceed to DOM fallback
              console.warn('[LayoutManager] Measurement wait failed, using DOM fallback:', err);
            }

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
          // Use the spacing parameter to let dagre calculate optimal sep values
          // based on actual node dimensions (final separation = spacing + max node size)
          // Default to 120 to match config.layoutSpacing default
          const spacing = options.nodeSpacing ?? (options.layoutSpecific && options.layoutSpecific.spacing) ?? 120;

          const positioned = applyDagreLayout(
            diagramNodes,
            diagramEdges || [],
            {
              direction: direction as any,
              spacing,
            },
            context?.manualMeasurements
          );

          // Return position change objects (caller will apply them via applyNodeChanges)
          return (positioned || []).map((n: any) => ({ id: String(n.id), type: "position", position: n.position }));
        } catch (err) {
          // swallow dagre/layout failures and continue to fallback grid layout
        }
      }

      // Handle ELK-driven layouts when nodes array available
      if (Array.isArray(diagramNodes) && layoutType.startsWith('elk-')) {
        try {
          const { applyElkLayout } = await import('./layout/elkLayout');
          // Extract algorithm name from layout type (e.g., 'elk-layered' -> 'layered')
          const algorithm = layoutType.replace('elk-', '');
          const spacing = options.nodeSpacing ?? (options.layoutSpecific && options.layoutSpecific.spacing) ?? 120;

          const positioned = await applyElkLayout(
            diagramNodes,
            diagramEdges || [],
            {
              algorithm,
              spacing,
            },
            context?.manualMeasurements
          );

          // Return position change objects (caller will apply them via applyNodeChanges)
          return (positioned || []).map((n: any) => ({ id: String(n.id), type: "position", position: n.position }));
        } catch (err) {
          console.error('ELK layout failed:', err);
          // swallow elk/layout failures and continue to fallback grid layout
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
