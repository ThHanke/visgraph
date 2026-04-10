// src/components/Canvas/layout/dagre.worker.ts
import dagre from 'dagre';
import type { LayoutGraph, LayoutState } from '@reactodia/workspace';

export interface DagreWorkerRequest {
  graph: LayoutGraph;
  state: LayoutState;
  direction: 'LR' | 'TB';
  spacing: number;
}

export interface DagreWorkerResponse {
  bounds: LayoutState['bounds'];
}

self.onmessage = ({ data }: MessageEvent<DagreWorkerRequest>) => {
  const { graph, state, direction, spacing } = data;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: spacing, ranksep: spacing });

  for (const id of Object.keys(graph.nodes)) {
    const b = state.bounds[id];
    g.setNode(id, { width: b?.width ?? 120, height: b?.height ?? 40 });
  }

  for (const link of graph.links) {
    g.setEdge(link.source, link.target);
  }

  dagre.layout(g);

  const bounds: Record<string, { x: number; y: number; width: number; height: number }> = {
    ...state.bounds,
  };
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (!n) continue;
    const existing = state.bounds[id];
    const w = existing?.width ?? n.width;
    const h = existing?.height ?? n.height;
    bounds[id] = { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h };
  }

  (self as unknown as Worker).postMessage({ bounds } satisfies DagreWorkerResponse);
};
