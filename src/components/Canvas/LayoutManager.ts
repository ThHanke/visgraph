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
  async applyLayout(layoutType: LayoutType, options: LayoutOptions = {}): Promise<void> {
    try {
      // Capture current positions if available
      if (this.diagram) {
        try {
          if (typeof this.diagram.getNodePositions === 'function') {
            const current = this.diagram.getNodePositions();
            this.lastPositions.push(current || {});
          } else if (Array.isArray(this.diagram.nodes)) {
            const snapshot: Record<string, { x: number; y: number }> = {};
            for (const n of this.diagram.nodes) {
              const pos = (n && n.position) || { x: NaN, y: NaN };
              snapshot[n.id] = { x: (pos.x as number) || 0, y: (pos.y as number) || 0 };
            }
            this.lastPositions.push(snapshot);
          }
        } catch {
          // ignore snapshot failures
        }
      }

      // If the diagram exposes a layout API, try to delegate to it.
      if (this.diagram) {
        if (typeof this.diagram.applyLayout === 'function') {
          await Promise.resolve(this.diagram.applyLayout(layoutType, options));
          return;
        }

        // Handle dagre-driven layouts: horizontal / vertical
        if (Array.isArray(this.diagram.nodes) && (layoutType === 'horizontal' || layoutType === 'vertical')) {
          try {
            // Import the dagre helper relative to this module.
            // Use dynamic import to keep the module lightweight unless needed.
             
            const { applyDagreLayout } = await import('./layout/dagreLayout');

            const direction = layoutType === 'horizontal' ? 'LR' : 'TB';
            const nodeSep = options.nodeSpacing ?? (options.layoutSpecific && options.layoutSpecific.nodeSep) ?? 60;
            const rankSep = (options.layoutSpecific && options.layoutSpecific.rankSep) ?? 60;

            const positioned = applyDagreLayout(this.diagram.nodes, this.diagram.edges || [], {
              direction: direction as any,
              nodeSep,
              rankSep,
            });

            // Attempt to hand updated positions back to the diagram
            if (typeof this.diagram.setNodePositions === 'function') {
              await Promise.resolve(this.diagram.setNodePositions(positioned));
              return;
            }
            // Generic fallback: replace nodes array with positioned nodes
            this.diagram.nodes = positioned;
            return;
          } catch (err) {
            // swallow dagre/layout failures — this manager is intentionally lightweight
          }
        }

        // Generic fallback: place nodes on a regular grid using provided spacing.
        if (Array.isArray(this.diagram.nodes)) {
          const total = this.diagram.nodes.length;
          const cols = Math.ceil(Math.sqrt(Math.max(1, total)));
          const spacingX = options.nodeSpacing ?? 160;
          const spacingY = (options.layoutSpecific && options.layoutSpecific.rankSep) ?? (options.nodeSpacing ?? 120);

          const updated = this.diagram.nodes.map((node: any, i: number) => {
            const x = (i % cols) * spacingX;
            const y = Math.floor(i / cols) * spacingY;
            return { ...node, position: { x, y } };
          });

          try {
            if (typeof this.diagram.setNodePositions === 'function') {
              await Promise.resolve(this.diagram.setNodePositions(updated));
              return;
            }
            this.diagram.nodes = updated;
            return;
          } catch {
            // ignore
          }
        }
      }

      // No diagram to modify — act as a no-op but resolve so callers don't hang.
      return;
    } catch {
      // Ensure we always resolve
      return;
    }
  }
}
