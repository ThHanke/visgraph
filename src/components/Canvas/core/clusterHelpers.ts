/**
 * Clustering helpers for node grouping based on visibility toggling
 * 
 * This module provides utilities for creating cluster nodes that group
 * multiple nodes together, with edge aggregation and visibility management.
 */

import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../types/canvas";
import initializeEdge from "./edgeStyle";
import { computeClustersLouvainNgraph } from "./clusterAlgorithms/louvainNgraph";
import { computeClustersConnectedComponents } from "./clusterAlgorithms/connectedComponents";

/** Maximum connectivity threshold for cluster extension absorption */
const MAX_CONNECTIVITY_FOR_ABSORPTION = 2;

export interface ClusterInfo {
  parentIri: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>; // Internal edges within cluster
}

/**
 * Find boundary edges for a cluster.
 * Boundary edge = one endpoint in cluster, one endpoint outside (bidirectional).
 */
function findClusterBoundaryEdges(
  cluster: ClusterInfo,
  edges: RFEdge<LinkData>[]
): RFEdge<LinkData>[] {
  const boundaryEdges: RFEdge<LinkData>[] = [];
  
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    const sourceInCluster = cluster.nodeIds.has(source);
    const targetInCluster = cluster.nodeIds.has(target);
    
    // XOR logic: exactly one endpoint in cluster
    if (sourceInCluster !== targetInCluster) {
      boundaryEdges.push(edge);
    }
  }
  
  return boundaryEdges;
}

/**
 * Compute internal edges for a cluster after extension.
 * Internal edge = both endpoints in cluster (bidirectional).
 */
function computeInternalEdges(
  cluster: ClusterInfo,
  edges: RFEdge<LinkData>[]
): Set<string> {
  const internalEdgeIds = new Set<string>();
  
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    // AND logic: both endpoints in cluster
    if (cluster.nodeIds.has(source) && cluster.nodeIds.has(target)) {
      internalEdgeIds.add(String(edge.id));
    }
  }
  
  return internalEdgeIds;
}

/**
 * Extend clusters by absorbing adjacent nodes with low connectivity.
 * 
 * Algorithm:
 * 1. For each cluster, find boundary edges
 * 2. For each boundary edge, follow the path outside the cluster
 * 3. Along the path, absorb nodes that meet criteria:
 *    - Not already in a cluster
 *    - Connectivity <= MAX_CONNECTIVITY_FOR_ABSORPTION
 * 4. Stop following path when hitting:
 *    - Node with connectivity > MAX_CONNECTIVITY_FOR_ABSORPTION
 *    - Node already in a cluster
 * 5. Recompute internal edges after all extensions complete
 */
function extendClusters(
  clusters: Map<string, ClusterInfo>,
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[]
): void {
  // Build edge adjacency map for efficient traversal
  const edgesByNode = new Map<string, RFEdge<LinkData>[]>();
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    if (!edgesByNode.has(source)) {
      edgesByNode.set(source, []);
    }
    if (!edgesByNode.has(target)) {
      edgesByNode.set(target, []);
    }
    edgesByNode.get(source)!.push(edge);
    edgesByNode.get(target)!.push(edge);
  }
  
  // Build node lookup map
  const nodeMap = new Map<string, RFNode<NodeData>>();
  for (const node of nodes) {
    nodeMap.set(String(node.id), node);
  }
  
  // Helper to check if node is in any cluster
  const isNodeInAnyCluster = (nodeId: string): boolean => {
    return Array.from(clusters.values()).some(c => c.nodeIds.has(nodeId));
  };
  
  // Process each cluster
  for (const [parentId, cluster] of clusters) {
    const nodesToAbsorb = new Set<string>();
    
    // Find boundary edges for this cluster
    const boundaryEdges = findClusterBoundaryEdges(cluster, edges);
    
    // For each boundary edge, follow the path outside
    for (const boundaryEdge of boundaryEdges) {
      const source = String(boundaryEdge.source);
      const target = String(boundaryEdge.target);
      
      // Identify the external node (not in this cluster)
      let currentNodeId: string;
      if (cluster.nodeIds.has(source) && !cluster.nodeIds.has(target)) {
        currentNodeId = target; // Edge pointing OUT
      } else if (!cluster.nodeIds.has(source) && cluster.nodeIds.has(target)) {
        currentNodeId = source; // Edge pointing IN
      } else {
        continue; // Should not happen
      }
      
      // Follow the path from this external node
      const visited = new Set<string>();
      const queue = [currentNodeId];
      
      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        
        // Skip if already visited
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        
        // Skip if already in cluster or absorb list
        if (cluster.nodeIds.has(nodeId) || nodesToAbsorb.has(nodeId)) continue;
        
        // Stop condition 1: already in another cluster
        if (isNodeInAnyCluster(nodeId)) break;
        
        // Get node
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        
        // Stop condition 2: connectivity > threshold
        const connectivity = (node.data as any)?.__connectivity ?? 0;
        if (connectivity > MAX_CONNECTIVITY_FOR_ABSORPTION) break;
        
        // This node can be absorbed!
        nodesToAbsorb.add(nodeId);
        
        // Find next edges to follow (edges to nodes outside cluster and not in absorb list)
        const connectedEdges = edgesByNode.get(nodeId) || [];
        for (const edge of connectedEdges) {
          const edgeSource = String(edge.source);
          const edgeTarget = String(edge.target);
          
          // Get the other endpoint
          const otherNode = edgeSource === nodeId ? edgeTarget : edgeSource;
          
          // Only follow if the other node is outside cluster and not in absorb list
          if (!cluster.nodeIds.has(otherNode) && !nodesToAbsorb.has(otherNode)) {
            queue.push(otherNode);
          }
        }
      }
    }
    
    // Absorb all collected nodes into the cluster
    for (const nodeId of nodesToAbsorb) {
      cluster.nodeIds.add(nodeId);
    }
  }
  
  // Recompute internal edges for all clusters after growth completes
  for (const [parentId, cluster] of clusters) {
    cluster.edgeIds = computeInternalEdges(cluster, edges);
  }
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
    algorithm?: "greedy" | "louvain" | "connected-components";
  }
): { nodes: RFNode<NodeData>[]; edges: RFEdge<LinkData>[] } {
  const { threshold, collapsedSet = new Set(), algorithm = "greedy" } = options;

  console.log('[Clustering] Starting automatic clustering:', {
    algorithm,
    threshold,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    visibleNodesBeforeClustering: nodes.length, // All nodes visible initially
  });

  // Compute clusters using selected algorithm
  const { clusters, claimedNodes } = selectClusteringAlgorithm(
    algorithm,
    nodes,
    edges,
    threshold,
    collapsedSet
  );

  // Calculate visible nodes after initial clustering
  const visibleAfterInitial = nodes.length - claimedNodes.size + clusters.size;
  
  console.log('[Clustering] Initial clusters computed:', {
    clusterCount: clusters.size,
    claimedNodeCount: claimedNodes.size,
    visibleNodesAfterInitialClustering: visibleAfterInitial,
    reductionFromInitial: nodes.length - visibleAfterInitial,
    clusters: Array.from(clusters.entries()).map(([parentId, info]) => ({
      parent: parentId,
      nodeCount: info.nodeIds.size,
      internalEdgeCount: info.edgeIds.size,
      nodeIds: Array.from(info.nodeIds),
    })),
  });

  // Extend clusters by absorbing weakly-connected adjacent nodes
  // (Only for greedy algorithm - Louvain and connected-components don't need extension)
  if (algorithm === "greedy") {
    extendClusters(clusters, nodes, edges);
    
    // Calculate visible nodes after extension (greedy only)
    const claimedAfterExtension = new Set<string>();
    for (const cluster of clusters.values()) {
      for (const nodeId of cluster.nodeIds) {
        claimedAfterExtension.add(nodeId);
      }
    }
    const visibleAfterExtension = nodes.length - claimedAfterExtension.size + clusters.size;
    
    console.log('[Clustering] Extended clusters (greedy only):', {
      clusterCount: clusters.size,
      claimedNodeCount: claimedAfterExtension.size,
      visibleNodesAfterExtension: visibleAfterExtension,
      reductionFromExtension: visibleAfterInitial - visibleAfterExtension,
      totalReductionFromStart: nodes.length - visibleAfterExtension,
    });
  }

  // Update claimedNodes to include all nodes from final clusters
  claimedNodes.clear();
  for (const cluster of clusters.values()) {
    for (const nodeId of cluster.nodeIds) {
      claimedNodes.add(nodeId);
    }
  }

  // Create cluster nodes
  const clusterNodesToAdd: RFNode<NodeData>[] = [];

  for (const [parentId, cluster] of clusters.entries()) {
    const parentNode = nodes.find(n => String(n.id) === parentId);
    if (!parentNode) continue;

    const clusterNodeId = `cluster:${parentId}`;
    // console.log('[Clustering] Creating cluster node:', {
    //   clusterNodeId,
    //   parentId,
    //   nodeCount: cluster.nodeIds.size,
    //   internalEdges: cluster.edgeIds.size,
    // });

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

  console.log('[Clustering] Cluster edge processing complete:', {
    visibleRegularEdges: visibleEdges.length,
    clusterEdgesCreated: clusterEdges.length,
    totalEdgesAfter: visibleEdges.length + clusterEdges.length,
  });

  // Keep ALL cluster edges - canvas filters by visibility dynamically
  // The viewFilteredEdges in KnowledgeCanvas.tsx handles visibility filtering
  // based on current node visibility, allowing edges to show/hide dynamically
  // when clusters expand/collapse
  const allEdges = [...visibleEdges, ...clusterEdges as any];

  // Set hidden flag on edges
  // - Original edges: hidden if EITHER endpoint is clustered (in claimedNodes)
  // - Cluster edges: hidden if EITHER endpoint node is hidden
  const hiddenNodeIds = new Set<string>();
  for (const node of allNodes) {
    if (node.hidden) {
      hiddenNodeIds.add(String(node.id));
    }
  }

  for (const edge of allEdges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    // Check if this is a cluster edge (starts with "cluster-edge-")
    const isClusterEdge = String(edge.id).startsWith('cluster-edge-');
    
    if (isClusterEdge) {
      // Cluster edges: hide if either endpoint is hidden
      edge.hidden = hiddenNodeIds.has(source) || hiddenNodeIds.has(target);
    } else {
      // Original edges: hide if either endpoint is HIDDEN
      // (not just clustered - when cluster expands, child nodes become visible and their edges should show)
      edge.hidden = hiddenNodeIds.has(source) || hiddenNodeIds.has(target);
    }
  }



  // Final summary
  console.log('[Clustering] SUMMARY:', {
    inputNodes: nodes.length,
    clusteredNodesInAllClusters: claimedNodes.size,
    totalClusterEdges: clusterEdges.length,
    clustersCreated: clusters.size,
    visibleNodes: visibleNodeIds.size,
    visibleEdges: allEdges.filter(e => !e.hidden).length,
  });

  return { nodes: allNodes, edges: allEdges };
}

/**
 * Compute clusters using greedy hierarchical algorithm with pre-computed connectivity.
 * 
 * Algorithm:
 * 1. Use pre-computed connectivity (unique connected nodes) from node metadata
 * 2. Sort nodes by connectivity (descending - most connected nodes first)
 * 3. Process nodes in order:
 *    - Calculate EFFECTIVE connectivity (connections to unclaimed nodes only)
 *    - If effective connectivity >= threshold AND node is in collapsedSet
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

  // Sort nodes by connectivity (unique connected nodes) from pre-computed metadata
  // If collapsedSet is empty, consider all nodes (automatic clustering mode)
  // If collapsedSet has entries, only include nodes in the set (manual clustering mode)
  const isAutomaticMode = collapsedSet.size === 0;
  const sortedNodes = [...nodes]
    .filter(n => {
      const nodeId = String(n.id);
      return isAutomaticMode || collapsedSet.has(nodeId);
    })
    .sort((a, b) => {
      // Use pre-computed connectivity (unique connected nodes count)
      const connectivityA = (a.data as any)?.__connectivity ?? 0;
      const connectivityB = (b.data as any)?.__connectivity ?? 0;
      return connectivityB - connectivityA; // Descending - highest connectivity first
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
 * Strategy (refactored for clarity):
 * - Keep ALL original edges (will be shown when both endpoints are expanded)
 * - For each cluster, find its boundary edges (edges crossing cluster boundary)
 * - For each boundary edge, determine external endpoint (node or another cluster)
 * - Create appropriate cluster edge variant: cluster:X → cluster:Y, cluster:X → nodeB, or nodeA → cluster:X
 * - Group/aggregate edges with same source→target pair
 * 
 * This approach is clearer: process each cluster's boundary explicitly, ensuring
 * all cross-cluster connections are properly represented.
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

  // Process each cluster's boundary edges explicitly
  for (const [parentId, cluster] of clusters.entries()) {
    const boundaryEdges = findClusterBoundaryEdges(cluster, allEdges);
    
    console.log(`[Clustering] Processing boundary edges for cluster:${parentId}:`, {
      clusterNodeCount: cluster.nodeIds.size,
      boundaryEdgeCount: boundaryEdges.length,
    });
    
    for (const edge of boundaryEdges) {
      const source = String(edge.source);
      const target = String(edge.target);
      const edgeId = String(edge.id);
      
      // Determine which endpoint is internal (in this cluster) vs external
      const sourceInCluster = cluster.nodeIds.has(source);
      const targetInCluster = cluster.nodeIds.has(target);
      
      // One and only one should be in cluster (boundary edge property)
      if (sourceInCluster === targetInCluster) {
        console.warn('[Clustering] Invalid boundary edge detected:', {
          edgeId,
          source,
          target,
          sourceInCluster,
          targetInCluster,
        });
        continue;
      }
      
      const internalNode = sourceInCluster ? source : target;
      const externalNode = sourceInCluster ? target : source;
      const isOutbound = sourceInCluster; // edge goes OUT of this cluster
      
      // Check if external node is in another cluster
      // First check if it's a cluster parent itself, then check if it's a child of another cluster
      const externalIsClusterParent = clusters.has(externalNode);
      const externalClusterParent = externalIsClusterParent 
        ? externalNode 
        : findClusterParentOf(externalNode, clusters);
      
      // Create cluster edge variant(s)
      // IMPORTANT: When external node is a cluster parent, create BOTH variants:
      // 1. Edge to the cluster (for when it's collapsed)
      // 2. Edge to the original node (for when cluster is expanded showing parent node)
      const variants: Array<{ source: string; target: string }> = [];
      
      if (isOutbound) {
        // Edge goes OUT of this cluster
        if (externalIsClusterParent) {
          // Create BOTH variants for cluster parent
          variants.push({
            source: `cluster:${parentId}`,
            target: `cluster:${externalClusterParent}`, // Edge to collapsed cluster
          });
          variants.push({
            source: `cluster:${parentId}`,
            target: externalNode, // Edge to expanded parent node
          });
        } else if (externalClusterParent) {
          // External is a child of another cluster
          // Create BOTH variants: to cluster AND to individual child node
          variants.push({
            source: `cluster:${parentId}`,
            target: `cluster:${externalClusterParent}`, // Edge to collapsed cluster
          });
          variants.push({
            source: `cluster:${parentId}`,
            target: externalNode, // Edge to expanded child node
          });
        } else {
          // External is unclustered - edge to original node
          variants.push({
            source: `cluster:${parentId}`,
            target: externalNode,
          });
        }
      } else {
        // Edge comes IN to this cluster
        if (externalIsClusterParent) {
          // Create BOTH variants for cluster parent
          variants.push({
            source: `cluster:${externalClusterParent}`, // Edge from collapsed cluster
            target: `cluster:${parentId}`,
          });
          variants.push({
            source: externalNode, // Edge from expanded parent node
            target: `cluster:${parentId}`,
          });
        } else if (externalClusterParent) {
          // External is a child of another cluster
          // Create BOTH variants: from cluster AND from individual child node
          variants.push({
            source: `cluster:${externalClusterParent}`, // Edge from collapsed cluster
            target: `cluster:${parentId}`,
          });
          variants.push({
            source: externalNode, // Edge from expanded child node
            target: `cluster:${parentId}`,
          });
        } else {
          // External is unclustered - edge from original node
          variants.push({
            source: externalNode,
            target: `cluster:${parentId}`,
          });
        }
      }
      
      // Aggregate all variants
      for (const variant of variants) {
        // Skip self-loops (shouldn't happen with proper boundary detection)
        if (variant.source === variant.target) {
          console.warn('[Clustering] Self-loop detected in cluster edge variant:', {
            edgeId,
            source,
            target,
            variantSource: variant.source,
            variantTarget: variant.target,
          });
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
  }

  console.log('[Clustering] Edge aggregation complete:', {
    uniqueClusterEdgePairs: edgeAggregation.size,
    aggregations: Array.from(edgeAggregation.entries()).map(([key, val]) => ({
      key,
      count: val.edgeIds.length,
    })),
  });

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

/**
 * Algorithm dispatcher - selects and runs the appropriate clustering algorithm
 */
function selectClusteringAlgorithm(
  algorithm: string,
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  threshold: number,
  collapsedSet: Set<string>
): { clusters: Map<string, ClusterInfo>; claimedNodes: Set<string> } {
  console.log(`[Clustering] Using algorithm: ${algorithm}`);
  
  switch (algorithm) {
    case "louvain":
      return computeClustersLouvainNgraph(nodes, edges, { threshold, collapsedSet });
    
    case "connected-components":
      return computeClustersConnectedComponents(nodes, edges, { threshold, collapsedSet });
    
    case "greedy":
    default:
      // Use the original greedy hierarchical algorithm
      return computeClusters(nodes, edges, collapsedSet, threshold);
  }
}
