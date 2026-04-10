import ELK from 'elkjs/lib/elk-api.js';
import { toast } from 'sonner';
import type { LayoutFunction, LayoutGraph, LayoutState } from '@reactodia/workspace';

// ---------------------------------------------------------------------------
// Active Dagre worker — module-level so any new layout call can cancel it
// ---------------------------------------------------------------------------

let activeDagreWorker: Worker | null = null;

/** Kill the current Dagre worker if one is running. Silently no-ops otherwise. */
function cancelActiveDagreLayout() {
  if (activeDagreWorker) {
    activeDagreWorker.terminate();
    activeDagreWorker = null;
  }
}

// ---------------------------------------------------------------------------
// Active ELK worker — module-level so any new layout call can cancel it
// ---------------------------------------------------------------------------

let activeElkWorker: Worker | null = null;

/** Kill the current ELK worker if one is running. Silently no-ops otherwise. */
function cancelActiveElkLayout() {
  if (activeElkWorker) {
    activeElkWorker.terminate();
    activeElkWorker = null;
  }
}

// ---------------------------------------------------------------------------
// Dagre
// ---------------------------------------------------------------------------

export function createDagreLayout(direction: 'LR' | 'TB', spacing: number): LayoutFunction {
  return (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
    cancelActiveDagreLayout();
    cancelActiveElkLayout();

    const worker = new Worker(
      new URL('./dagre.worker.ts', import.meta.url),
      { type: 'module' }
    );
    activeDagreWorker = worker;

    return new Promise<LayoutState>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<{ bounds: LayoutState['bounds'] }>) => {
        if (activeDagreWorker === worker) activeDagreWorker = null;
        worker.terminate();
        resolve({ bounds: data.bounds });
      };
      worker.onerror = (e) => {
        if (activeDagreWorker === worker) activeDagreWorker = null;
        worker.terminate();
        reject(e);
      };
      worker.postMessage({ graph, state, direction, spacing });
    });
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
  algorithm: 'layered' | 'force' | 'stress',
  spacing: number
): LayoutFunction {
  return async (graph: LayoutGraph, state: LayoutState): Promise<LayoutState> => {
    // Cancel any previous Dagre and ELK layouts still in progress.
    cancelActiveDagreLayout();
    cancelActiveElkLayout();

    const worker = new Worker(
      new URL('./elk.worker.ts', import.meta.url),
      { type: 'module' }
    );
    activeElkWorker = worker;

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
        return { id, width: b?.width ?? 120, height: b?.height ?? 40 };
      }),
      edges: graph.links.map((link, i) => ({
        id: `e${i}`,
        sources: [link.source],
        targets: [link.target],
      })),
    };

    // Resolve null on timeout so we can fall back gracefully instead of throwing.
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => {
        worker.terminate();
        resolve(null);
      }, ELK_TIMEOUT_MS)
    );

    let result: Awaited<ReturnType<typeof elk.layout>> | null;
    try {
      result = await Promise.race([elk.layout(elkGraph), timeout]);
    } finally {
      // Clear the module ref if this worker is still the active one.
      if (activeElkWorker === worker) activeElkWorker = null;
      worker.terminate();
    }

    if (result === null) {
      toast.warning(
        `ELK ${algorithm} timed out after ${ELK_TIMEOUT_MS / 1000}s` +
        ` (${nodeCount} nodes) — fell back to Dagre`,
        { duration: 6000 }
      );
      return createDagreLayout('TB', spacing)(graph, state);
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
  };
}
