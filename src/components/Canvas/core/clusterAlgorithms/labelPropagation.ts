/**
 * Label Propagation clustering algorithm using ngraph.slpa
 * SLPA (Speaker-Listener Label Propagation) - Detects overlapping communities
 */

import createGraph from 'ngraph.graph';
import slpa from 'ngraph.slpa';
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../../types/canvas";
import type { ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from "./types";

/** Target maximum number of clusters */
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
 * Label Propagation clustering algorithm using SLPA
 * 
 * This algorithm uses speaker-listener label propagation to detect communities.
 * It can detect overlapping communities, but we select the primary community
 * for each node for visualization purposes.
 * 
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @param options - Clustering options (threshold not used by SLPA, but kept for interface consistency)
 * @returns Cluster information with parent nodes and member nodes
 */
export function computeClustersLabelPropagation(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  const { collapsedSet, threshold } = options;
  
  console.log('[LabelPropagation] Starting clustering:', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  // Create ngraph graph
  const graph = createGraph();
  
  // Add all nodes
  for (const node of nodes) {
    const nodeId = String(node.id);
    graph.addNode(nodeId);
  }
  
  // Add all edges (undirected for community detection)
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    
    // Skip self-loops
    if (source === target) continue;
    
    try {
      graph.addLink(source, target);
    } catch (e) {
      // Link might already exist, ignore
    }
  }
  
  console.log('[LabelPropagation] Graph created:', {
    nodeCount: graph.getNodesCount(),
    linksCount: graph.getLinksCount(),
  });
  
  // Run SLPA with configuration
  // Note: slpa(graph, T, r) where:
  // - T: number of iterations (default 100, should be at least 20)
  // - r: community threshold 0-1 (default 0.3, >0.5 = disjoint communities)
  const result = slpa(graph, 20, 0.1);
  
  console.log('[LabelPropagation] SLPA complete:', {
    communitiesDetected: result ? 'yes' : 'no',
    communitiesType: typeof result,
    communitiesCount: result?.communities ? Object.keys(result.communities).length : 0,
    sampleCommunities: result?.communities ? Object.keys(result.communities).slice(0, 3) : [],
  });
  
  // SLPA returns { communities: {communityName: [nodeIds]}, nodes: {nodeId: [communities]} }
  // The communities object already has nodes grouped by community!
  const communityGroups = new Map<string, string[]>();
  
  // Track which nodes have been assigned to communities
  const assignedNodes = new Set<string>();
  
  // Convert the communities object to a Map
  // Limit to TARGET_MAX_CLUSTERS by taking the largest communities
  if (result?.communities) {
    const communitiesArray = Object.entries(result.communities)
      .map(([name, members]) => ({ name, members: members as string[] }))
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, TARGET_MAX_CLUSTERS);
    
    for (const { name, members } of communitiesArray) {
      communityGroups.set(name, members);
      for (const nodeId of members) {
        assignedNodes.add(String(nodeId));
      }
    }
  }
  
  console.log('[LabelPropagation] Community groups:', {
    totalGroups: communityGroups.size,
    groupSizes: Array.from(communityGroups.entries()).map(([id, members]) => ({
      communityId: id,
      memberCount: members.length,
      sampleMembers: members.slice(0, 3),
    })),
    assignedNodes: assignedNodes.size,
    totalNodes: nodes.length,
  });
  
  // Create clusters from communities
  // For each community, select the node with highest connectivity as parent
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();
  
  console.log('[LabelPropagation] Creating clusters from communities:', {
    totalCommunities: communityGroups.size,
  });
  
  for (const [communityId, memberIds] of communityGroups) {
    // Skip single-node communities
    if (memberIds.length < 2) {
      console.log(`[LabelPropagation] Skipping single-node community ${communityId}`);
      continue;
    }
    
    // Find the node with highest connectivity in this community to be the parent
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
  
  console.log('[LabelPropagation] Clustering complete:', {
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
