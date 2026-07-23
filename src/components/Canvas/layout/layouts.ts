import ELK from 'elkjs/lib/elk-api.js';
import { toast } from 'sonner';
import type { LayoutFunction, LayoutGraph, LayoutState } from '@reactodia/workspace';

import { substituteFixedWithPhantom, restoreFixed } from './fixedPhantom';

// ---------------------------------------------------------------------------
// Dagre
// ---------------------------------------------------------------------------

export function createDagreLayout(direction: 'LR' | 'TB', spacing: number): LayoutFunction {
  return async (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
    const fixedIds = new Set(
      Object.entries(graph.nodes)
        .filter(([, n]) => n.fixed)
        .map(([id]) => id)
    );

    const phantom = substituteFixedWithPhantom(graph, state, fixedIds);
    const workerGraph = phantom ? phantom.graph : graph;
    const workerState = phantom ? phantom.state : state;

    const worker = new Worker(
      new URL('./dagre.worker.ts', import.meta.url),
      { type: 'module' }
    );

    const result = await new Promise<LayoutState>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<{ bounds: LayoutState['bounds'] }>) => {
        worker.terminate();
        resolve({ bounds: data.bounds });
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(e);
      };
      worker.postMessage({ graph: workerGraph, state: workerState, direction, spacing });
    });

    if (phantom) {
      return restoreFixed(result, phantom.phantomId, phantom.originalFixedBounds);
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// ELK
// ---------------------------------------------------------------------------

const ELK_ALGORITHM_IDS: Record<string, string> = {
  layered: 'org.eclipse.elk.layered',
  force:   'org.eclipse.elk.force',
  stress:  'org.eclipse.elk.stress',
  radial:  'org.eclipse.elk.radial',
};

const ELK_TIMEOUT_MS = 60_000;

function elkAlgorithmOptions(algorithm: string, spacing: number): Record<string, string> {
  switch (algorithm) {
    case 'layered':
      return {
        'org.eclipse.elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'org.eclipse.elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'org.eclipse.elk.layered.cycleBreaking.strategy': 'GREEDY',
        'org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
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
  algorithm: 'layered' | 'force' | 'stress' | 'radial',
  spacing: number
): LayoutFunction {
  return async (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
    const fixedIds = new Set(
      Object.entries(graph.nodes)
        .filter(([, n]) => n.fixed)
        .map(([id]) => id)
    );

    // elkjs 0.11 does not honor org.eclipse.elk.stress.fixed — use phantom for all algorithms
    const phantom = substituteFixedWithPhantom(graph, state, fixedIds);
    const effectiveGraph = phantom ? phantom.graph : graph;
    const effectiveState = phantom ? phantom.state : state;

    const elkResult = await runElk(effectiveGraph, effectiveState, algorithm, spacing);

    if (phantom) {
      return restoreFixed(elkResult, phantom.phantomId, phantom.originalFixedBounds);
    }
    return elkResult;
  };
}

async function runElk(
  graph: LayoutGraph,
  state: LayoutState,
  algorithm: 'layered' | 'force' | 'stress' | 'radial',
  spacing: number
): Promise<LayoutState> {
  const worker = new Worker(
    new URL('./elk.worker.ts', import.meta.url),
    { type: 'module' }
  );

  const elk = new ELK({ workerFactory: () => worker });
  const nodeCount = Object.keys(graph.nodes).length;

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'org.eclipse.elk.algorithm': ELK_ALGORITHM_IDS[algorithm],
      'org.eclipse.elk.spacing.nodeNode': String(spacing),
      ...elkAlgorithmOptions(algorithm, spacing),
    },
    children: Object.keys(graph.nodes).map((id) => {
      const b = state.bounds[id];
      return {
        id,
        x: b?.x ?? 0,
        y: b?.y ?? 0,
        width: b?.width ?? 120,
        height: b?.height ?? 40,
      };
    }),
    edges: graph.links.map((link, i) => ({
      id: `e${i}`,
      sources: [link.source],
      targets: [link.target],
    })),
  };

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      worker.terminate();
      resolve(null);
    }, ELK_TIMEOUT_MS)
  );

  let result: Awaited<ReturnType<typeof elk.layout>> | null;
  try {
    result = await Promise.race([elk.layout(elkGraph), timeout]);
  } catch (err) {
    worker.terminate();
    console.warn(`[ELK] ${algorithm} failed (${nodeCount} nodes), falling back to Dagre:`, err);
    toast.warning(
      `ELK ${algorithm} failed — fell back to Dagre`,
      { duration: 4000 }
    );
    return createDagreLayout('TB', spacing)(
      // Pass original graph so Dagre also gets fixed-node support
      { nodes: graph.nodes, links: graph.links },
      state
    );
  } finally {
    worker.terminate();
  }

  if (result === null) {
    toast.warning(
      `ELK ${algorithm} timed out after ${ELK_TIMEOUT_MS / 1000}s` +
      ` (${nodeCount} nodes) — fell back to Dagre`,
      { duration: 6000 }
    );
    return createDagreLayout('TB', spacing)(
      { nodes: graph.nodes, links: graph.links },
      state
    );
  }

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
}
