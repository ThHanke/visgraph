/**
 * Clustering helpers for node grouping based on visibility toggling
 * 
 * This module provides utilities for creating cluster nodes that group
 * multiple nodes together, with edge aggregation and visibility management.
 */

import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../types/canvas";
import initializeEdge from "./edgeStyle";

export interface ClusterInfo {
  parentIri: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>; // Internal edges within cluster
}

/**
 * Apply clustering to a diagram (main entry point for clustering pipeline).
 * 
 * This function is called after the mapper has produced unclustered nodes/edges.
 * It creates cluster nodes, hides clustered children, and generates cluster edges.
 * 
 * @param nodes - Unclustered nodes from mapper (with __edgeCount metadata)
 * @param edges - Unclustered edges from mapper
 * @param options - Clustering options
 * @returns Clustered diagram with cluster nodes and edges
 */
export function applyClustering(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: {
    threshold: number;
    collapsedSet?: Set<string>;
  }
): { nodes: RFNode<NodeData>[]; edges: RFEdge<LinkData>[] } {
  const { threshold, collapsedSet = new Set() } = options;

  console.log('[Clustering] Starting automatic clustering:', {
    threshold,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  });

  // Compute clusters using pre-computed edge counts
  const { clusters, claimedNodes } = computeClusters(nodes, edges, collapsedSet, threshold);

  console.log('[Clustering] Computed clusters:', {
    clusterCount: clusters.size,
    claimedNodeCount: claimedNodes.size,
    clusters: Array.from(clusters.entries()).map(([parentId, info]) => ({
      parent: parentId,
      nodeCount: info.nodeIds.size,
      internalEdgeCount: info.edgeIds.size,
      nodeIds: Array.from(info.nodeIds),
    })),
  });

  // Create cluster nodes
  const clusterNodesToAdd: RFNode<NodeData>[] = [];

  for (const [parentId, cluster] of clusters.entries()) {
    const parentNode = nodes.find(n => String(n.id) === parentId);
    if (!parentNode) continue;

    const clusterNodeId = `cluster:${parentId}`;
    console.log('[Clustering] Creating cluster node:', {
      clusterNodeId,
      parentId,
      nodeCount: cluster.nodeIds.size,
      internalEdges: cluster.edgeIds.size,
    });

    clusterNodesToAdd.push({
      id: clusterNodeId,
      type: 'cluster',
      position: parentNode.position || { x: 0, y: 0 },
      data: {
        ...parentNode.data,
        clusterType: 'cluster',
        parentIri: cluster.parentIri,
        nodeIds: Array.from(cluster.nodeIds),
        edgeIds: Array.from(cluster.edgeIds),
        nodeCount: cluster.nodeIds.size,
      },
      hidden: false, // Cluster visible by default
    } as RFNode<NodeData>);
  }

  // Mark original nodes as hidden and add cluster parent reference
  const updatedNodes = nodes.map(node => {
    const nodeId = String(node.id);

    // If this node is part of any cluster, hide it and add parent reference
    if (claimedNodes.has(nodeId)) {
      const clusterParentId = Array.from(clusters.entries()).find(
        ([_, info]) => info.nodeIds.has(nodeId)
      )?.[0];

      return {
        ...node,
        data: {
          ...node.data,
          __clusterParent: clusterParentId ? `cluster:${clusterParentId}` : undefined,
        },
        hidden: true, // Hide original nodes when clustered
      };
    }

    return node;
  });

  // Combine original nodes with cluster nodes
  const allNodes = [...updatedNodes, ...clusterNodesToAdd];

  console.log('[Clustering] Node transformation complete:', {
    clusterNodesAdded: clusterNodesToAdd.length,
    hiddenChildren: claimedNodes.size,
    totalNodes: allNodes.length,
    totalVisible: allNodes.filter(n => !n.hidden).length,
  });

  // Build cluster edges
  const visibleNodeIds = new Set<string>();
  for (const node of allNodes) {
    if (!node.hidden) {
      visibleNodeIds.add(String(node.id));
    }
  }

  console.log('[Clustering] Building cluster edges from:', {
    totalInputEdges: edges.length,
    clusterCount: clusters.size,
    visibleNodes: visibleNodeIds.size,
  });

  const { visibleEdges, clusterEdges } = buildClusterEdges(edges, clusters, claimedNodes);

  // Filter out cluster edges that reference hidden nodes
  const validClusterEdges = clusterEdges.filter(edge => {
    const source = String(edge.source);
    const target = String(edge.target);
    const isValid = visibleNodeIds.has(source) && visibleNodeIds.has(target);

    if (!isValid) {
      console.warn('[Clustering] Filtering invalid cluster edge:', {
        id: edge.id,
        source,
        target,
        sourceVisible: visibleNodeIds.has(source),
        targetVisible: visibleNodeIds.has(target),
      });
    }

    return isValid;
  });

  console.log('[Clustering] Cluster edge processing complete:', {
    visibleRegularEdges: visibleEdges.length,
    clusterEdgesCreated: clusterEdges.length,
    validClusterEdges: validClusterEdges.length,
    filteredOut: clusterEdges.length - validClusterEdges.length,
    totalEdgesAfter: visibleEdges.length + validClusterEdges.length,
  });

  // Combine visible regular edges with valid cluster edges
  const allEdges = [...visibleEdges, ...validClusterEdges as any];

  // Set hidden flag on edges where either source or target is hidden
  const hiddenNodeIds = new Set<string>();
  for (const node of allNodes) {
    if (node.hidden) {
      hiddenNodeIds.add(String(node.id));
    }
  }

  for (const edge of allEdges) {
    const source = String(edge.source);
    const target = String(edge.target);
    edge.hidden = hiddenNodeIds.has(source) || hiddenNodeIds.has(target);
  }

  return { nodes: allNodes, edges: allEdges };
}

/**
 * Compute clusters using greedy hierarchical algorithm with pre-computed edge counts.
 * 
 * Algorithm:
 * 1. Use pre-computed total degree (incoming + outgoing edges) from node metadata
 * 2. Sort nodes by total degree (descending - high-degree nodes first)
 * 3. Process nodes in order:
 *    - Calculate EFFECTIVE edge count (edges to unclaimed nodes only)
 *    - If effective count >= threshold AND node is in collapsedSet
 *    - Create cluster and claim all target nodes
 * 4. Skip nodes already claimed by other clusters
 * 
 * This ensures no overlapping clusters and respects user collapse preferences.
 */
export function computeClusters(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  collapsedSet: Set<string>,
  threshold: number
): { clusters: Map<string, ClusterInfo>; claimedNodes: Set<string> } {
  // Build edge adjacency map
  const outgoingEdges = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    const edgeId = String(edge.id);
    
    if (!outgoingEdges.has(source)) {
      outgoingEdges.set(source, []);
    }
    outgoingEdges.get(source)!.push({ target, edgeId });
  }

  // Sort nodes by TOTAL degree (incoming + outgoing) from pre-computed metadata
  // If collapsedSet is empty, consider all nodes (automatic clustering mode)
  // If collapsedSet has entries, only include nodes in the set (manual clustering mode)
  const isAutomaticMode = collapsedSet.size === 0;
  const sortedNodes = [...nodes]
    .filter(n => {
      const nodeId = String(n.id);
      return isAutomaticMode || collapsedSet.has(nodeId);
    })
    .sort((a, b) => {
      // Use pre-computed total degree (incoming + outgoing)
      const countA = (a.data as any)?.__edgeCount?.total ?? 0;
      const countB = (b.data as any)?.__edgeCount?.total ?? 0;
      return countB - countA; // Descending - highest degree first
    });

  const claimedNodes = new Set<string>();
  const clusters = new Map<string, ClusterInfo>();

  // Process nodes in order
  for (const node of sortedNodes) {
    const nodeId = String(node.id);
    
    // Skip if already claimed by another cluster
    if (claimedNodes.has(nodeId)) continue;

    // Get outgoing edges
    const outgoing = outgoingEdges.get(nodeId) || [];
    
    // Calculate EFFECTIVE edge count (only edges to unclaimed nodes)
    const effectiveTargets = outgoing.filter(({ target }) => !claimedNodes.has(target));
    const effectiveEdgeCount = effectiveTargets.length;

    // Only cluster if effective edges >= threshold
    if (effectiveEdgeCount < threshold) continue;

    // Collect target node IDs and edge IDs
    const targetNodeIds = effectiveTargets.map(({ target }) => target);
    const clusterNodeIds = new Set<string>([nodeId, ...targetNodeIds]);
    
    // Find internal edges (edges where both source and target are in cluster)
    const internalEdgeIds = new Set<string>();
    for (const edge of edges) {
      const source = String(edge.source);
      const target = String(edge.target);
      if (clusterNodeIds.has(source) && clusterNodeIds.has(target)) {
        internalEdgeIds.add(String(edge.id));
      }
    }

    // Create cluster
    clusters.set(nodeId, {
      parentIri: nodeId,
      nodeIds: clusterNodeIds,
      edgeIds: internalEdgeIds,
    });

    // Mark all nodes in this cluster as claimed
    clusterNodeIds.forEach(id => claimedNodes.add(id));
  }

  return { clusters, claimedNodes };
}

/**
 * Find which cluster (if any) contains a given node.
 * Returns the parent IRI of the cluster, or null if node is not in any cluster.
 */
export function findClusterParentOf(
  nodeId: string,
  clusters: Map<string, ClusterInfo>
): string | null {
  for (const [parentId, info] of clusters) {
    // Check if node is in this cluster but is not the parent itself
    if (info.nodeIds.has(nodeId) && nodeId !== parentId) {
      return parentId;
    }
  }
  return null;
}

/**
 * Build cluster edges for ALL possible visibility combinations.
 * 
 * Strategy:
 * - Keep ALL original edges (will be shown when both endpoints are expanded)
 * - Create cluster edges for EVERY possible combination:
 *   - cluster:X → cluster:Y (both collapsed)
 *   - cluster:X → nodeB (source collapsed, target expanded)  
 *   - nodeA → cluster:Y (source expanded, target collapsed)
 * - Visibility rule: Show edge if and only if BOTH source AND target nodes are visible
 * 
 * This approach is simple: create all variants at build time, then just check
 * node visibility at render time. No complex state tracking needed!
 */
export function buildClusterEdges(
  allEdges: RFEdge<LinkData>[],
  clusters: Map<string, ClusterInfo>,
  claimedNodes: Set<string>
): {
  visibleEdges: RFEdge<LinkData>[];
  clusterEdges: RFEdge<LinkData & { edgeType: 'cluster'; aggregatedCount: number; originalEdgeIds: string[] }>[];
} {
  // All original edges stay as-is (will be shown when both nodes are expanded)
  const visibleEdges: RFEdge<LinkData>[] = [...allEdges];
  
  // Track all cluster edge variants to create
  // Key format: "sourceId→targetId" where IDs can be either "cluster:X" or regular node IDs
  const edgeAggregation = new Map<string, { edgeIds: string[]; data: LinkData[] }>();

  for (const edge of allEdges) {
    const source = String(edge.source);
    const target = String(edge.target);
    const edgeId = String(edge.id);
    
    // Check if source/target are in clusters
    const sourceClusterParent = clusters.has(source) ? source : findClusterParentOf(source, clusters);
    const targetClusterParent = clusters.has(target) ? target : findClusterParentOf(target, clusters);

    // Skip if neither endpoint is clustered (original edge is sufficient)
    if (!sourceClusterParent && !targetClusterParent) {
      continue;
    }

    // Skip internal edges (both in same cluster - these stay hidden)
    if (sourceClusterParent && targetClusterParent && sourceClusterParent === targetClusterParent) {
      continue;
    }

    // Create cluster edge variants for all possible visibility states
    const variants: Array<{ source: string; target: string }> = [];

    if (sourceClusterParent && targetClusterParent) {
      // Both are in clusters - create cluster:X → cluster:Y
      variants.push({
        source: `cluster:${sourceClusterParent}`,
        target: `cluster:${targetClusterParent}`,
      });
    } else if (sourceClusterParent && !targetClusterParent) {
      // Only source is clustered - create cluster:X → target
      variants.push({
        source: `cluster:${sourceClusterParent}`,
        target: target,
      });
    } else if (!sourceClusterParent && targetClusterParent) {
      // Only target is clustered - create source → cluster:Y
      variants.push({
        source: source,
        target: `cluster:${targetClusterParent}`,
      });
    }

    // Aggregate each variant
    for (const variant of variants) {
      // Skip self-loops
      if (variant.source === variant.target) {
        continue;
      }

      const aggregationKey = `${variant.source}→${variant.target}`;
      if (!edgeAggregation.has(aggregationKey)) {
        edgeAggregation.set(aggregationKey, { edgeIds: [], data: [] });
      }
      const aggregation = edgeAggregation.get(aggregationKey)!;
      aggregation.edgeIds.push(edgeId);
      aggregation.data.push(edge.data as LinkData);
    }
  }

  // Build cluster edge objects from aggregated variants
  const clusterEdges: RFEdge<LinkData & { edgeType: 'cluster'; aggregatedCount: number; originalEdgeIds: string[] }>[] = [];
  
  for (const [key, { edgeIds, data }] of edgeAggregation) {
    const [source, target] = key.split('→');
    const aggregatedCount = edgeIds.length;
    
    // Get representative edge data from first edge
    const representativeData = data[0] || {};
    
    // Use initializeEdge to ensure proper markerEnd format
    const initializedEdge = initializeEdge({
      id: `cluster-edge-${key}`,
      source,
      target,
      type: 'cluster',
      data: {
        ...representativeData,
        edgeType: 'cluster',
        aggregatedCount,
        originalEdgeIds: edgeIds,
        from: source,
        to: target,
        label: aggregatedCount > 1 ? `×${aggregatedCount}` : representativeData.label || '',
      } as any,
      hidden: false,
    });
    
    clusterEdges.push(initializedEdge);
  }

  return { visibleEdges, clusterEdges };
}
