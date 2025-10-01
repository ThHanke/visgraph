import dagre from 'dagre';
import { debug } from '../../../utils/startupDebug';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { NodeData, LinkData } from '../../../types/canvas';

export interface DagreOptions {
  direction?: 'LR' | 'TB' | 'RL' | 'BT';
  nodeSep?: number;
  rankSep?: number;
  marginX?: number;
  marginY?: number;
}

/**
 * applyDagreLayout
 * Computes node positions using dagre and returns a new nodes array with updated positions.
 *
 * Notes:
 * - Nodes/edges are the React Flow node/edge objects. Node sizes are estimated when not provided.
 * - The returned nodes preserve all existing node properties but set `position` to the computed layout coords.
 */
export function applyDagreLayout(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  opts: DagreOptions = {}
): RFNode<NodeData>[] {
  const direction = opts.direction || 'LR';
  const nodeSep = opts.nodeSep ?? 50;
  const rankSep = opts.rankSep ?? 50;
  const marginX = opts.marginX ?? 20;
  const marginY = opts.marginY ?? 20;

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: nodeSep,
    ranksep: rankSep,
    marginx: marginX,
    marginy: marginY,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add nodes to the dagre graph. Provide width/height estimates if not available.
  for (const n of nodes) {
    const meta = (n as any).__rf || {};
    const w = (meta.width && typeof meta.width === 'number') ? meta.width : 180;
    const h = (meta.height && typeof meta.height === 'number') ? meta.height : 64;
    g.setNode(n.id, { width: w, height: h });
  }

  // Compute maximum node dimensions and adjust spacing so layout is node-size-aware.
  // We add the max lateral size to rank separation and the max cross size to node separation.
  // This is an additive change (no opt-in, no padding/scaling) as requested.
  try {
    let maxWidth = 0;
    let maxHeight = 0;
    const allNodeIds = g.nodes() || [];
    for (const id of allNodeIds) {
      const v: any = g.node(id);
      if (!v) continue;
      if (typeof v.width === 'number' && v.width > maxWidth) maxWidth = v.width;
      if (typeof v.height === 'number' && v.height > maxHeight) maxHeight = v.height;
    }

    // Determine final separations depending on layout direction.
    let finalNodeSep = nodeSep;
    let finalRankSep = rankSep;
    if (direction === 'LR' || direction === 'RL') {
      // Horizontal layout: ranks progress left->right; add max node width to rank separation (X axis)
      // and add max node height to nodesep (Y-axis spacing within a rank).
      finalRankSep = (rankSep ?? 0) + maxWidth;
      finalNodeSep = (nodeSep ?? 0) + maxHeight;
    } else {
      // Vertical layout: ranks progress top->bottom; add max node height to rank separation (Y axis)
      // and add max node width to nodesep (X-axis spacing within a rank).
      finalRankSep = (rankSep ?? 0) + maxHeight;
      finalNodeSep = (nodeSep ?? 0) + maxWidth;
    }

    // Update graph layout settings with the computed separations.
    g.setGraph({
      rankdir: direction,
      nodesep: finalNodeSep,
      ranksep: finalRankSep,
      marginx: marginX,
      marginy: marginY,
    });
  } catch (_) {
    // If anything goes wrong, fall back to the original settings already applied above.
  }

  // Add edges
  for (const e of edges) {
    // dagre expects unique edge ids but we can omit id and provide source/target
    try {
      g.setEdge(e.source, e.target);
    } catch (err) {
      // ignore malformed edges
    }
  }

  // Run layout
  if (typeof debug === 'function') {
    try {
      debug('dagre.layout.start', { nodeCount: nodes.length, edgeCount: edges.length, opts });
    } catch (_) { /* ignore */ }
  }

  dagre.layout(g);

  if (typeof debug === 'function') {
    try {
      // collect a small sample of computed node positions for debugging
      const sample: any[] = [];
      const allIds = g.nodes() || [];
      for (let i = 0; i < Math.min(6, allIds.length); i++) {
        const v = g.node(allIds[i]);
        if (v) sample.push({ id: allIds[i], x: Math.round(v.x), y: Math.round(v.y), width: v.width, height: v.height });
      }
      debug('dagre.layout.end', { sample, total: allIds.length });
    } catch (_) { /* ignore */ }
  }

  // Map computed positions back to nodes
  const positioned = nodes.map(n => {
    const v = g.node(n.id);
    if (!v) {
      return { ...n };
    }
    const width = v.width || 180;
    const height = v.height || 64;
    return {
      ...n,
      position: {
        x: Math.round(v.x - width / 2),
        y: Math.round(v.y - height / 2)
      }
    };
  });

  return positioned;
}
