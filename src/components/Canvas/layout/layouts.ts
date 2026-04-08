import dagre from 'dagre';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { LayoutFunction, LayoutGraph, LayoutState } from '@reactodia/workspace';

// ---------------------------------------------------------------------------
// Dagre
// ---------------------------------------------------------------------------

export function createDagreLayout(direction: 'LR' | 'TB', spacing: number): LayoutFunction {
  return async (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
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

    const bounds = { ...state.bounds };
    for (const id of g.nodes()) {
      const n = g.node(id);
      if (!n) continue;
      const existing = state.bounds[id];
      const w = existing?.width ?? n.width;
      const h = existing?.height ?? n.height;
      bounds[id] = { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h };
    }

    return { bounds };
  };
}

// ---------------------------------------------------------------------------
// ELK
// ---------------------------------------------------------------------------

const ELK_ALGORITHM_IDS: Record<string, string> = {
  layered: 'org.eclipse.elk.layered',
  force: 'org.eclipse.elk.force',
  stress: 'org.eclipse.elk.stress',
};

function elkAlgorithmOptions(algorithm: string, spacing: number): Record<string, string> {
  switch (algorithm) {
    case 'layered':
      return {
        'org.eclipse.elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'org.eclipse.elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'org.eclipse.elk.layered.cycleBreaking.strategy': 'GREEDY',
      };
    case 'force':
      return {
        'org.eclipse.elk.force.repulsion': String(spacing),
        'org.eclipse.elk.force.temperature': '0.001',
        'org.eclipse.elk.force.iterations': '300',
      };
    case 'stress':
      return {
        'org.eclipse.elk.stress.desiredEdgeLength': String(spacing),
        'org.eclipse.elk.stress.epsilon': '0.0001',
      };
    default:
      return {};
  }
}

export function createElkLayout(
  algorithm: 'layered' | 'force' | 'stress',
  spacing: number
): LayoutFunction {
  const elkInstance = new ELK();
  return async (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'org.eclipse.elk.algorithm': ELK_ALGORITHM_IDS[algorithm],
        'org.eclipse.elk.spacing.nodeNode': String(spacing),
        ...elkAlgorithmOptions(algorithm, spacing),
      },
      children: Object.keys(graph.nodes).map((id) => {
        const b = state.bounds[id];
        return { id, width: b?.width ?? 120, height: b?.height ?? 40 };
      }),
      edges: graph.links.map((link, i) => ({
        id: `e${i}`,
        sources: [link.source],
        targets: [link.target],
      })),
    };

    const result = await elkInstance.layout(elkGraph);

    const bounds = { ...state.bounds };
    for (const child of result.children ?? []) {
      const existing = state.bounds[child.id];
      bounds[child.id] = {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: existing?.width ?? child.width ?? 120,
        height: existing?.height ?? child.height ?? 40,
      };
    }

    return { bounds };
  };
}
