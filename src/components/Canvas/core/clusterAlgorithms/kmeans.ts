/**
 * K-means clustering algorithm using ml-kmeans
 * Feature-based clustering using node positions and connectivity
 */

import { kmeans } from 'ml-kmeans';
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../../types/canvas";
import type { ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from "./types";

/** Target maximum number of clusters (K value for k-means) */
const TARGET_MAX_CLUSTERS = 100;

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
 * K-means clustering algorithm using ml-kmeans
 * 
 * This algorithm uses k-means to cluster nodes based on their features:
 * - Position (x, y coordinates)
 * - Connectivity (degree/edge count)
 * 
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @param options - Clustering options (threshold not directly used, but kept for interface consistency)
 * @returns Cluster information with parent nodes and member nodes
 */
export function computeClustersKmeans(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  const { collapsedSet, threshold } = options;
  
  console.log('[Kmeans] Starting clustering:', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  // If we have fewer nodes than desired clusters, adjust K
  const k = Math.min(Math.ceil(nodes.length / 10), TARGET_MAX_CLUSTERS);
  
  if (nodes.length < 2) {
    console.log('[Kmeans] Too few nodes for clustering');
    return { clusters: new Map(), claimedNodes: new Set() };
  }

  // Extract features from nodes
  // Features: [x-position, y-position, connectivity]
  const features: number[][] = [];
  const nodeIds: string[] = [];
  
  // Find bounds for normalization
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minConn = Infinity, maxConn = -Infinity;
  
  for (const node of nodes) {
    const x = node.position?.x || 0;
    const y = node.position?.y || 0;
    const connectivity = (node.data as any)?.__connectivity ?? 0;
    
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minConn = Math.min(minConn, connectivity);
    maxConn = Math.max(maxConn, connectivity);
  }
  
  // Normalize features to [0, 1] range
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const rangeConn = maxConn - minConn || 1;
  
  for (const node of nodes) {
    const nodeId = String(node.id);
    const x = node.position?.x || 0;
    const y = node.position?.y || 0;
    const connectivity = (node.data as any)?.__connectivity ?? 0;
    
    // Normalized features
    features.push([
      (x - minX) / rangeX,
      (y - minY) / rangeY,
      (connectivity - minConn) / rangeConn,
    ]);
    nodeIds.push(nodeId);
  }
  
  console.log('[Kmeans] Features extracted:', {
    featureCount: features.length,
    targetClusters: k,
    featureDimensions: features[0]?.length || 0,
  });
  
  // Run k-means clustering
  let result;
  try {
    result = kmeans(features, k, {
      initialization: 'kmeans++', // Better initialization
      maxIterations: 100,
    });
  } catch (error) {
    console.error('[Kmeans] Clustering failed:', error);
    return { clusters: new Map(), claimedNodes: new Set() };
  }
  
  console.log('[Kmeans] K-means complete:', {
    iterations: result.iterations,
    clusterCount: k,
  });
  
  // Group nodes by their assigned cluster
  const clusterGroups = new Map<number, string[]>();
  
  for (let i = 0; i < result.clusters.length; i++) {
    const clusterIdx = result.clusters[i];
    const nodeId = nodeIds[i];
    
    if (!clusterGroups.has(clusterIdx)) {
      clusterGroups.set(clusterIdx, []);
    }
    clusterGroups.get(clusterIdx)!.push(nodeId);
  }
  
  console.log('[Kmeans] Cluster groups:', {
    totalGroups: clusterGroups.size,
    groupSizes: Array.from(clusterGroups.entries()).map(([id, members]) => ({
      clusterId: id,
      memberCount: members.length,
      sampleMembers: members.slice(0, 3),
    })),
  });
  
  // Create clusters from groups
  // For each cluster, select the node with highest connectivity as parent
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();
  
  console.log('[Kmeans] Creating clusters from groups:', {
    totalGroups: clusterGroups.size,
  });
  
  for (const [clusterIdx, memberIds] of clusterGroups) {
    // Skip single-node clusters
    if (memberIds.length < 2) {
      console.log(`[Kmeans] Skipping single-node cluster ${clusterIdx}`);
      continue;
    }
    
    // Find the node with highest connectivity in this cluster to be the parent
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
  
  console.log('[Kmeans] Clustering complete:', {
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
