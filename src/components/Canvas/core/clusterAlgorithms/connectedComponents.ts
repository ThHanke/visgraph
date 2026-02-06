/**
 * Connected Components clustering algorithm
 * Fastest option - groups disconnected subgraphs together (O(V+E))
 */

import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../../types/canvas";
import type { ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from "./types";

/**
 * Compute internal edges for a cluster
 */
function computeInternalEdges(
  cluster: ClusterInfo,
  edges: RFEdge<LinkData>[]
): Set<string> {
  const internalEdgeIds = new Set<string>();
  
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    if (cluster.nodeIds.has(source) && cluster.nodeIds.has(target)) {
      internalEdgeIds.add(String(edge.id));
    }
  }
  
  return internalEdgeIds;
}

/**
 * Find connected components using Union-Find (Disjoint Set)
 * 
 * This algorithm groups nodes that are connected by any path into the same component.
 * Very fast O(V+E) and useful for disconnected graphs.
 * 
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @param options - Clustering options (threshold not used, but kept for interface consistency)
 * @returns Cluster information with parent nodes and member nodes
 */
export function computeClustersConnectedComponents(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  const { threshold } = options;
  
  console.log('[ConnectedComponents] Starting clustering:', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    threshold,
  });

  // Union-Find data structure
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  
  // Initialize each node as its own component
  for (const node of nodes) {
    const nodeId = String(node.id);
    parent.set(nodeId, nodeId);
    rank.set(nodeId, 0);
  }
  
  // Find with path compression
  function find(x: string): string {
    const p = parent.get(x);
    if (!p || p === x) return x;
    const root = find(p);
    parent.set(x, root); // Path compression
    return root;
  }
  
  // Union by rank
  function union(x: string, y: string): void {
    const rootX = find(x);
    const rootY = find(y);
    
    if (rootX === rootY) return;
    
    const rankX = rank.get(rootX) ?? 0;
    const rankY = rank.get(rootY) ?? 0;
    
    if (rankX < rankY) {
      parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      parent.set(rootY, rootX);
    } else {
      parent.set(rootY, rootX);
      rank.set(rootX, rankX + 1);
    }
  }
  
  // Unite nodes connected by edges
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    // Skip self-loops
    if (source === target) continue;
    
    union(source, target);
  }
  
  // Group nodes by their root component
  const components = new Map<string, string[]>();
  for (const node of nodes) {
    const nodeId = String(node.id);
    const root = find(nodeId);
    
    if (!components.has(root)) {
      components.set(root, []);
    }
    components.get(root)!.push(nodeId);
  }
  
  console.log('[ConnectedComponents] Components found:', {
    totalComponents: components.size,
    componentSizes: Array.from(components.values()).map(c => c.length),
  });
  
  // Create clusters from components with sufficient size
  // For each component, select the node with highest connectivity as parent
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();
  
  // Use threshold as minimum component size (different interpretation than greedy)
  const minComponentSize = Math.max(2, threshold);
  
  console.log('[ConnectedComponents] Filtering components by minimum size:', {
    minComponentSize,
    totalComponents: components.size,
  });
  
  for (const [root, memberIds] of components) {
    // Skip components below minimum size threshold
    if (memberIds.length < minComponentSize) {
      console.log(`[ConnectedComponents] Skipping small component with ${memberIds.length} members`);
      continue;
    }
    
    // Find the node with highest connectivity in this component to be the parent
    let parentId: string | null = null;
    let maxConnectivity = -1;
    
    for (const nodeId of memberIds) {
      const node = nodes.find(n => String(n.id) === nodeId);
      if (!node) continue;
      
      const connectivity = (node.data as any)?.__connectivity ?? 0;
      if (connectivity > maxConnectivity) {
        maxConnectivity = connectivity;
        parentId = nodeId;
      }
    }
    
    // If no parent found (shouldn't happen), use first node
    if (!parentId) {
      parentId = memberIds[0];
    }
    
    // Create cluster info
    const nodeIds = new Set(memberIds);
    const edgeIds = computeInternalEdges({ parentIri: parentId, nodeIds, edgeIds: new Set() }, edges);
    
    clusters.set(parentId, {
      parentIri: parentId,
      nodeIds,
      edgeIds,
    });
    
    // Mark all nodes as claimed
    for (const nodeId of memberIds) {
      claimedNodes.add(nodeId);
    }
  }
  
  console.log('[ConnectedComponents] Clustering complete:', {
    clusterCount: clusters.size,
    claimedNodeCount: claimedNodes.size,
    clusters: Array.from(clusters.entries()).map(([parentId, info]) => ({
      parent: parentId,
      nodeCount: info.nodeIds.size,
      internalEdgeCount: info.edgeIds.size,
    })),
  });
  
  return { clusters, claimedNodes };
}
