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

  // Check node measurements and add nodes to the dagre graph
  let nodesWithMeasurements = 0;
  const measurementInfo: Array<{ id: string; hasWidth: boolean; hasHeight: boolean; width: number; height: number }> = [];

  for (const n of nodes) {
    const meta = (n as any).__rf || {};
    const hasWidth = meta.width && typeof meta.width === 'number';
    const hasHeight = meta.height && typeof meta.height === 'number';
    const w = hasWidth ? meta.width : 180;
    const h = hasHeight ? meta.height : 64;

    if (hasWidth && hasHeight) {
      nodesWithMeasurements++;
    }

    measurementInfo.push({
      id: n.id,
      hasWidth: !!hasWidth,
      hasHeight: !!hasHeight,
      width: w,
      height: h
    });

    g.setNode(n.id, { width: w, height: h });
  }

  // Calculate measurement coverage
  const totalNodes = nodes.length;
  const measurementCoverage = totalNodes > 0 ? (nodesWithMeasurements / totalNodes) * 100 : 0;

  // Log measurement status
  console.debug('[dagre] Layout measurement check:', {
    totalNodes,
    nodesWithMeasurements,
    coveragePercent: Math.round(measurementCoverage),
    direction,
    nodeSep,
    rankSep,
    sampleMeasurements: measurementInfo.slice(0, 3)
  });

  // If less than 80% of nodes have measurements, warn but proceed with fallbacks
  if (measurementCoverage < 80 && totalNodes > 0) {
    console.warn(`[dagre] Only ${Math.round(measurementCoverage)}% of nodes have measurements. Layout may not be optimal. Consider retrying after nodes render.`);
  }

  // Add edges
  for (const e of edges) {
    // dagre expects unique edge ids but we can omit id and provide source/target
    {
      g.setEdge(e.source, e.target);
    }
  }

  // Run layout
  if (typeof debug === 'function') {
    {
      debug('dagre.layout.start', { nodeCount: nodes.length, edgeCount: edges.length, opts });
    }
  }

  dagre.layout(g);

  if (typeof debug === 'function') {
    {
      // collect a small sample of computed node positions for debugging
      const sample: any[] = [];
      const allIds = g.nodes() || [];
      for (let i = 0; i < Math.min(6, allIds.length); i++) {
        const v = g.node(allIds[i]);
        if (v) sample.push({ id: allIds[i], x: Math.round(v.x), y: Math.round(v.y), width: v.width, height: v.height });
      }
      debug('dagre.layout.end', { sample, total: allIds.length });
    }
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
