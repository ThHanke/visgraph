// src/components/Canvas/layout/silentLayout.ts
/**
 * runSilentLayout — compute layout positions for a set of nodes without triggering
 * Reactodia's spinner overlay. Returns a Map from element IRI to position Vector.
 *
 * The caller is responsible for applying positions (e.g. via el.setPosition) at the
 * appropriate time. This function only computes; it never touches the canvas model.
 */
import type { LayoutFunction, LayoutGraph, LayoutState, Vector } from '@reactodia/workspace';

export interface SilentLayoutEdge {
  source: string;
  target: string;
}

/**
 * @param layoutFn  - Any LayoutFunction (Dagre worker, ELK worker, etc.)
 * @param iris      - All element IRIs to lay out
 * @param edges     - Edges between those elements
 * @param sizes     - Optional per-IRI sizes; defaults to 120×40
 * @returns         - Map from IRI → {x, y} top-left position
 */
export async function runSilentLayout(
  layoutFn: LayoutFunction,
  iris: string[],
  edges: SilentLayoutEdge[],
  sizes?: Map<string, { width: number; height: number }>
): Promise<Map<string, Vector>> {
  if (iris.length === 0) return new Map();

  // Build LayoutGraph
  const nodes: LayoutGraph['nodes'] = {};
  for (const id of iris) {
    nodes[id] = { types: [] };
  }

  const irisSet = new Set(iris);
  const links: LayoutGraph['links'] = edges
    .filter(e => irisSet.has(e.source) && irisSet.has(e.target))
    .map(e => ({ type: '' as any, source: e.source, target: e.target }));

  const graph: LayoutGraph = { nodes, links };

  // Build LayoutState with known or default sizes
  const bounds: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const id of iris) {
    const s = sizes?.get(id);
    bounds[id] = { x: 0, y: 0, width: s?.width ?? 120, height: s?.height ?? 40 };
  }
  const state: LayoutState = { bounds };

  // Run layout in worker (non-blocking by construction)
  const result = await layoutFn(graph, state);

  // Convert bounds to position map (top-left corner)
  const positions = new Map<string, Vector>();
  for (const id of iris) {
    const b = result.bounds[id];
    if (b) positions.set(id, { x: b.x, y: b.y });
  }
  return positions;
}
