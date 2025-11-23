import dagre from 'dagre';
import { debug } from '../../../utils/startupDebug';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { NodeData, LinkData } from '../../../types/canvas';

export interface DagreOptions {
  direction?: 'LR' | 'TB' | 'RL' | 'BT';
  nodeSep?: number;
  rankSep?: number;
  spacing?: number; // Base spacing to add to max node dimensions for auto-calculated sep values
  marginX?: number;
  marginY?: number;
}

export interface NodeMeasurement {
  width: number;
  height: number;
}

/**
 * applyDagreLayout
 * Computes node positions using dagre and returns a new nodes array with updated positions.
 *
 * Notes:
 * - Nodes/edges are the React Flow node/edge objects. Node sizes are estimated when not provided.
 * - The returned nodes preserve all existing node properties but set `position` to the computed layout coords.
 * - Accepts optional manualMeasurements from direct DOM queries for accurate sizing.
 */
export function applyDagreLayout(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  opts: DagreOptions = {},
  manualMeasurements?: Map<string, NodeMeasurement>
): RFNode<NodeData>[] {
  const direction = opts.direction || 'LR';
  const marginX = opts.marginX ?? 20;
  const marginY = opts.marginY ?? 20;

  // Check node measurements and add nodes to the dagre graph
  let nodesWithMeasurements = 0;
  const measurementInfo: Array<{ id: string; hasWidth: boolean; hasHeight: boolean; width: number; height: number; __rf: any }> = [];
  
  // Track max dimensions for dynamic spacing calculation
  let maxWidth = 0;
  let maxHeight = 0;

  for (const n of nodes) {
    const nodeId = String(n.id);
    
    // Priority: 1. Manual DOM measurements, 2. React Flow __rf metadata, 3. Fallback
    let w: number;
    let h: number;
    let hasWidth = false;
    let hasHeight = false;
    
    // Check manual measurements first (most accurate)
    const manual = manualMeasurements?.get(nodeId);
    if (manual && typeof manual.width === 'number' && typeof manual.height === 'number' && manual.width > 0 && manual.height > 0) {
      w = manual.width;
      h = manual.height;
      hasWidth = true;
      hasHeight = true;
      nodesWithMeasurements++;
    } else {
      // Fall back to React Flow metadata
      const meta = (n as any).__rf || {};
      hasWidth = meta.width && typeof meta.width === 'number' && meta.width > 0;
      hasHeight = meta.height && typeof meta.height === 'number' && meta.height > 0;
      w = hasWidth ? meta.width : 180;
      h = hasHeight ? meta.height : 64;
      
      if (hasWidth && hasHeight) {
        nodesWithMeasurements++;
      }
    }

    measurementInfo.push({
      id: nodeId,
      hasWidth: !!hasWidth,
      hasHeight: !!hasHeight,
      width: w,
      height: h,
      __rf: (n as any).__rf || {}
    });

    // Track max dimensions
    maxWidth = Math.max(maxWidth, w);
    maxHeight = Math.max(maxHeight, h);
  }

  // Calculate dynamic spacing based on node dimensions and layout direction
  // Use the spacing config parameter to add to max node dimensions
  const spacingConfig = opts.spacing ?? 120; // Default spacing between nodes

  const isHorizontal = direction === 'LR' || direction === 'RL';

  // Calculate nodeSep: spacing between nodes in the same rank
  let nodeSep: number;
  if (opts.nodeSep !== undefined) {
    // Explicit override provided
    nodeSep = opts.nodeSep;
  } else if (isHorizontal) {
    // Horizontal layout: nodes flow left-to-right in vertical ranks
    // Nodes in same rank are arranged vertically, so nodeSep is vertical spacing
    nodeSep = maxHeight + spacingConfig;
  } else {
    // Vertical layout: nodes flow top-to-bottom in horizontal ranks
    // Nodes in same rank are arranged horizontally, so nodeSep is horizontal spacing
    nodeSep = maxWidth + spacingConfig;
  }

  // Calculate rankSep: spacing between ranks
  let rankSep: number;
  if (opts.rankSep !== undefined) {
    // Explicit override provided
    rankSep = opts.rankSep;
  } else if (isHorizontal) {
    // Horizontal layout: ranks are arranged horizontally
    // rankSep is horizontal spacing between ranks
    rankSep = maxWidth + spacingConfig;
  } else {
    // Vertical layout: ranks are arranged vertically
    // rankSep is vertical spacing between ranks
    rankSep = maxHeight + spacingConfig;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: nodeSep,
    ranksep: rankSep,
    marginx: marginX,
    marginy: marginY,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add nodes to dagre graph
  for (const info of measurementInfo) {
    g.setNode(info.id, { width: info.width, height: info.height });
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
  // Note: dagre returns center coordinates (x, y) and React Flow uses nodeOrigin=[0.5, 0.5]
  // which means it also expects center coordinates, so we pass them directly without conversion
  const positioned = nodes.map(n => {
    const v = g.node(n.id);
    if (!v) {
      return { ...n };
    }
    return {
      ...n,
      position: {
        x: Math.round(v.x),
        y: Math.round(v.y)
      }
    };
  });

  return positioned;
}
