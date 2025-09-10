export type LayoutType =
  | 'force-directed'
  | 'hierarchical'
  | 'circular'
  | 'grid'
  | 'layered-digraph'
  | 'tree';

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
    return [
      { type: 'force-directed', label: 'Force Directed', description: 'Evenly distributes nodes using a force model', icon: 'GitBranch' },
      { type: 'hierarchical', label: 'Hierarchical', description: 'Top-down layered layout', icon: 'TreePine' },
      { type: 'circular', label: 'Circular', description: 'Arrange nodes in concentric circles', icon: 'Circle' },
      { type: 'grid', label: 'Grid', description: 'Place nodes on a regular grid', icon: 'Grid3X3' },
      { type: 'layered-digraph', label: 'Layered Digraph', description: 'Layered directed graph layout', icon: 'Layers' },
      { type: 'tree', label: 'Tree', description: 'Tree-like layout', icon: 'TreeDeciduous' },
    ];
  }

  suggestOptimalLayout(): LayoutType {
    // Conservative default: force-directed for medium/small graphs.
    // Callers may override with specialized logic.
    return 'force-directed';
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

  async applyLayout(layoutType: LayoutType, options: LayoutOptions = {}): Promise<void> {
    // Hard removal strategy: no  usage. Provide an async, best-effort implementation
    // that updates a generic diagram object if present, otherwise acts as a no-op.
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
              const pos = n.position || n.position || { x: NaN, y: NaN };
              snapshot[n.id] = { x: pos.x || 0, y: pos.y || 0 };
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
        // Otherwise, attempt to set positions using simple heuristics for known layout types.
        if (Array.isArray(this.diagram.nodes)) {
          const n = this.diagram.nodes.length;
          const updated = this.diagram.nodes.map((node: any, i: number) => {
            let pos = { x: node.position?.x ?? 0, y: node.position?.y ?? 0 };
            if (layoutType === 'grid') {
              const cols = Math.ceil(Math.sqrt(Math.max(1, n)));
              pos = { x: (i % cols) * (options.nodeSpacing ?? 160), y: Math.floor(i / cols) * (options.nodeSpacing ?? 120) };
            } else if (layoutType === 'circular') {
              const r = 200 + Math.floor(i / 8) * 80;
              const angle = (i / Math.max(1, n)) * Math.PI * 2;
              pos = { x: Math.round(400 + r * Math.cos(angle)), y: Math.round(300 + r * Math.sin(angle)) };
            } else if (layoutType === 'tree' || layoutType === 'hierarchical' || layoutType === 'layered-digraph') {
              pos = { x: i * (options.nodeSpacing ?? 160), y: (i % 5) * (options.nodeSpacing ?? 120) };
            } else {
              // force-directed / fallback: simple horizontal spread
              pos = { x: i * (options.nodeSpacing ?? 160), y: (i % 5) * (options.nodeSpacing ?? 120) };
            }
            return { ...node, position: pos };
          });
          // Assign back if diagram supports it
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
