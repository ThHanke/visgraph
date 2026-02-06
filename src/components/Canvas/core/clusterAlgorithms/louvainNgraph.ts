/**
 * Louvain clustering algorithm using ngraph
 * Fast community detection optimized for large graphs (10k+ nodes)
 */

import createGraph from 'ngraph.graph';
import louvain from 'ngraph.louvain';
import coarsen from 'ngraph.coarsen';
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../../types/canvas";
import type { ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from "./types";

/** Target maximum number of clusters after hierarchical coarsening */
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
 * Louvain clustering algorithm using ngraph
 * 
 * This algorithm uses community detection to find natural clusters in the graph.
 * It's optimized for large graphs and produces high-quality communities.
 * 
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @param options - Clustering options (threshold not used by Louvain, but kept for interface consistency)
 * @returns Cluster information with parent nodes and member nodes
 */
export function computeClustersLouvainNgraph(
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  const { collapsedSet, threshold } = options;
  
  console.log('[Louvain] Starting clustering:', {
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
  
  console.log('[Louvain] Graph created:', {
    nodeCount: graph.getNodesCount(),
    linksCount: graph.getLinksCount(),
  });
  
  // Run Louvain with hierarchical coarsening
  // Following the ngraph pattern: graph = coarsen(graph, clusters); clusters = detectClusters(graph);
  let workGraph = graph;
  let communities = louvain(workGraph);
  let level = 0;
  
  // Track mapping from current level nodes to original nodes
  // Start with identity mapping: each original node maps to itself
  let nodeToOriginals = new Map<any, string[]>();
  graph.forEachNode((node: any) => {
    nodeToOriginals.set(node.id, [String(node.id)]);
  });
  
  console.log('[Louvain] Initial community detection complete');
  
  // Hierarchical coarsening loop
  while (communities.canCoarse && communities.canCoarse()) {
    level++;
    const prevNodeCount = workGraph.getNodesCount();
    
    // Before coarsening, build mapping: which nodes go into which community
    const prevNodeToOriginals = nodeToOriginals;
    nodeToOriginals = new Map<any, string[]>();
    
    // Track which prev-level nodes are in each community
    const communityMembers = new Map<number, any[]>();
    workGraph.forEachNode((node: any) => {
      const communityId = communities.getClass(node.id);
      if (!communityMembers.has(communityId)) {
        communityMembers.set(communityId, []);
      }
      communityMembers.get(communityId)!.push(node.id);
    });
    
    // Coarsen the graph based on current communities
    workGraph = coarsen(workGraph, communities);
    
    console.log('[Louvain] Coarsening level ' + level + ':', {
      previousNodes: prevNodeCount,
      coarsenedNodes: workGraph.getNodesCount(),
      reduction: prevNodeCount - workGraph.getNodesCount(),
    });
    
    // After coarsening, map new coarsened nodes to original nodes
    // IMPORTANT: ngraph.coarsen uses community IDs as the new node IDs!
    // So a coarsened node with ID=5 represents all nodes that were in community 5
    for (const [communityId, memberIds] of communityMembers) {
      // Collect all original nodes from this community
      const originals: string[] = [];
      for (const memberId of memberIds) {
        const memberOriginals = prevNodeToOriginals.get(memberId) || [String(memberId)];
        originals.push(...memberOriginals);
      }
      // The coarsened node ID is the community ID itself
      nodeToOriginals.set(communityId, originals);
    }
    
    console.log('[Louvain] Level ' + level + ' mapping check:', {
      communitiesTracked: communityMembers.size,
      nodesInMapping: nodeToOriginals.size,
      totalOriginalsTracked: Array.from(nodeToOriginals.values()).flat().length,
    });
    
    // Detect communities on the coarsened graph
    communities = louvain(workGraph);
    
    // Safety check: stop if we've reduced enough or hit iteration limit
    if (workGraph.getNodesCount() <= TARGET_MAX_CLUSTERS || level >= 10) {
      console.log('[Louvain] Stopping coarsening:', {
        reason: workGraph.getNodesCount() <= TARGET_MAX_CLUSTERS ? 'target reached' : 'max iterations',
        finalNodeCount: workGraph.getNodesCount(),
        levels: level,
      });
      break;
    }
  }
  
  // Group original nodes by their final community
  // Use the manual mapping we built during coarsening
  const communityGroups = new Map<number, string[]>();
  
  workGraph.forEachNode((node: any) => {
    const nodeId = node.id;
    const communityId = communities.getClass(nodeId);
    
    if (communityId !== undefined) {
      if (!communityGroups.has(communityId)) {
        communityGroups.set(communityId, []);
      }
      
      // Get original node IDs from our manual mapping
      const originalIds = nodeToOriginals.get(nodeId) || [String(nodeId)];
      communityGroups.get(communityId)!.push(...originalIds);
    }
  });
  
  console.log('[Louvain] Mapped back to originals:', {
    totalOriginalNodes: Array.from(communityGroups.values()).flat().length,
    expected: nodes.length,
  });
  
  console.log('[Louvain] Community groups:', {
    totalGroups: communityGroups.size,
    groupSizes: Array.from(communityGroups.entries()).map(([id, members]) => ({
      communityId: id,
      memberCount: members.length,
      sampleMembers: members.slice(0, 3),
    })),
  });
  
  // Create clusters from communities
  // For each community, select the node with highest connectivity as parent
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();
  
  console.log('[Louvain] Creating clusters from communities:', {
    totalCommunities: communityGroups.size,
  });
  
  for (const [communityId, memberIds] of communityGroups) {
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
  
  console.log('[Louvain] Clustering complete:', {
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
