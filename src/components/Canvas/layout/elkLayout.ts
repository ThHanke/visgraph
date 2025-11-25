import ELK from 'elkjs/lib/elk.bundled.js';
import { debug } from '../../../utils/startupDebug';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { NodeData, LinkData } from '../../../types/canvas';
import { getElkAlgorithmConfig } from './elkLayoutConfig';

export interface ElkOptions {
  algorithm?: string; // e.g., 'layered', 'force', 'stress', 'dot'
  spacing?: number; // Base spacing for nodes
}

export interface NodeMeasurement {
  width: number;
  height: number;
}

const elk = new ELK();

/**
 * applyElkLayout
 * Computes node positions using ELK.js and returns a new nodes array with updated positions.
 *
 * Notes:
 * - Similar to dagreLayout but uses ELK's more sophisticated algorithms
 * - Supports multiple algorithms: layered, force, stress, dot
 * - The returned nodes preserve all existing node properties but set `position` to computed coords
 * - Accepts optional manualMeasurements from direct DOM queries for accurate sizing
 */
export async function applyElkLayout(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  opts: ElkOptions = {},
  manualMeasurements?: Map<string, NodeMeasurement>
): Promise<RFNode<NodeData>[]> {
  const algorithm = opts.algorithm || 'layered';
  const spacing = opts.spacing ?? 120;

  // Get algorithm configuration
  const algorithmConfig = getElkAlgorithmConfig(algorithm);
  if (!algorithmConfig) {
    console.warn(`Unknown ELK algorithm: ${algorithm}, falling back to layered`);
    return applyElkLayout(nodes, edges, { ...opts, algorithm: 'layered' }, manualMeasurements);
  }

  // Gather node measurements
  const nodeData = nodes.map((n) => {
    const nodeId = String(n.id);
    let w: number;
    let h: number;

    // Priority: 1. Manual DOM measurements, 2. React Flow __rf metadata, 3. Fallback
    const manual = manualMeasurements?.get(nodeId);
    if (manual && typeof manual.width === 'number' && typeof manual.height === 'number' && manual.width > 0 && manual.height > 0) {
      w = manual.width;
      h = manual.height;
    } else {
      const meta = (n as any).__rf || {};
      const hasWidth = meta.width && typeof meta.width === 'number' && meta.width > 0;
      const hasHeight = meta.height && typeof meta.height === 'number' && meta.height > 0;
      w = hasWidth ? meta.width : 180;
      h = hasHeight ? meta.height : 64;
    }

    return {
      id: nodeId,
      width: w,
      height: h,
    };
  });

  // Compute max dimensions to scale spacing (O(n) - very fast)
  let maxWidth = 0;
  let maxHeight = 0;
  for (const node of nodeData) {
    maxWidth = Math.max(maxWidth, node.width);
    maxHeight = Math.max(maxHeight, node.height);
  }
  const maxDimension = Math.max(maxWidth, maxHeight);

  // Build algorithm-specific layout options
  const layoutOptions: Record<string, string> = {
    ...algorithmConfig.defaultOptions,
  };

  // Apply algorithm-specific spacing strategies to prevent node overlap
  switch (algorithm) {
    case 'layered':
      // Layered: Add max dimension to spacing for both in-layer and between-layer spacing
      layoutOptions['elk.spacing.nodeNode'] = String(spacing + maxDimension);
      layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers'] = String(spacing + maxDimension);
      break;

    case 'force':
      // Force-directed: Scale repulsion with node size, add spacing
      layoutOptions['elk.force.repulsion'] = String(100 + maxDimension * 2);
      layoutOptions['elk.spacing.nodeNode'] = String(spacing + maxDimension * 0.5);
      break;

    case 'stress':
      // Stress: Scale desired edge length with node size and spacing
      layoutOptions['elk.stress.desiredEdgeLength'] = String(spacing + maxDimension);
      layoutOptions['elk.spacing.nodeNode'] = String(spacing + maxDimension * 0.5);
      break;

    default:
      // Fallback for any other algorithms
      layoutOptions['elk.spacing.nodeNode'] = String(spacing + maxDimension);
      break;
  }

  // Build ELK graph structure
  const elkGraph = {
    id: 'root',
    layoutOptions,
    children: nodeData.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [String(edge.source)],
      targets: [String(edge.target)],
    })),
  };

  if (typeof debug === 'function') {
    debug('elk.layout.start', {
      algorithm: algorithmConfig.algorithm,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      spacing,
    });
  }

  try {
    // Run ELK layout
    const layoutedGraph = await elk.layout(elkGraph);

    if (typeof debug === 'function') {
      // Collect sample of computed positions for debugging
      const sample = (layoutedGraph.children || []).slice(0, 6).map((node) => ({
        id: node.id,
        x: Math.round(node.x || 0),
        y: Math.round(node.y || 0),
        width: node.width,
        height: node.height,
      }));
      debug('elk.layout.end', { algorithm: algorithmConfig.algorithm, sample, total: layoutedGraph.children?.length || 0 });
    }

    // Map computed positions back to React Flow nodes
    // ELK returns top-left coordinates, but React Flow uses nodeOrigin=[0.5, 0.5] (center)
    // So we need to convert: center = topLeft + (width/2, height/2)
    const positioned = nodes.map((node) => {
      const elkNode = layoutedGraph.children?.find((n) => n.id === node.id);
      if (!elkNode) {
        return { ...node };
      }

      // Convert from top-left to center coordinates
      const centerX = (elkNode.x || 0) + (elkNode.width || 0) / 2;
      const centerY = (elkNode.y || 0) + (elkNode.height || 0) / 2;

      return {
        ...node,
        position: {
          x: Math.round(centerX),
          y: Math.round(centerY),
        },
      };
    });

    return positioned;
  } catch (error) {
    console.error('ELK layout failed:', error);
    // Return nodes unchanged on error
    return nodes;
  }
}
