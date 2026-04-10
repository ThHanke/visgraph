/**
 * Louvain clustering algorithm using ngraph.
 * Fast community detection optimised for large graphs (10k+ nodes).
 */

import createGraph from 'ngraph.graph';
import louvain from 'ngraph.louvain';
import coarsen from 'ngraph.coarsen';
import type { ClusterNode, ClusterEdge, ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from './types';

const TARGET_MAX_CLUSTERS = 100;

export function computeClustersLouvainNgraph(
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  console.log('[Louvain] Starting clustering:', { nodeCount: nodes.length, edgeCount: edges.length });

  const graph = createGraph();
  for (const node of nodes) graph.addNode(node.id);
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    try { graph.addLink(edge.source, edge.target); } catch { /* duplicate */ }
  }

  // Hierarchical coarsening — track original IDs through each level
  let workGraph = graph;
  let communities = louvain(workGraph);
  let level = 0;

  let nodeToOriginals = new Map<any, string[]>();
  graph.forEachNode((n: any) => nodeToOriginals.set(n.id, [String(n.id)]));

  while (communities.canCoarse && communities.canCoarse()) {
    level++;
    const prevNodeToOriginals = nodeToOriginals;
    nodeToOriginals = new Map();

    const communityMembers = new Map<number, any[]>();
    workGraph.forEachNode((n: any) => {
      const cid = communities.getClass(n.id);
      if (!communityMembers.has(cid)) communityMembers.set(cid, []);
      communityMembers.get(cid)!.push(n.id);
    });

    workGraph = coarsen(workGraph, communities);

    for (const [cid, memberIds] of communityMembers) {
      const originals: string[] = [];
      for (const mid of memberIds) {
        originals.push(...(prevNodeToOriginals.get(mid) ?? [String(mid)]));
      }
      nodeToOriginals.set(cid, originals);
    }

    communities = louvain(workGraph);
    if (workGraph.getNodesCount() <= TARGET_MAX_CLUSTERS || level >= 10) break;
  }

  // Map final communities back to original node IDs
  const communityGroups = new Map<number, string[]>();
  workGraph.forEachNode((n: any) => {
    const cid = communities.getClass(n.id);
    if (cid === undefined) return;
    if (!communityGroups.has(cid)) communityGroups.set(cid, []);
    communityGroups.get(cid)!.push(...(nodeToOriginals.get(n.id) ?? [String(n.id)]));
  });

  console.log('[Louvain] Communities:', { total: communityGroups.size });

  return buildClusters(nodes, communityGroups);
}

function buildClusters(
  nodes: ClusterNode[],
  communityGroups: Map<number, string[]>
): ClusterResult {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();

  for (const [, memberIds] of communityGroups) {
    if (memberIds.length < 2) continue;

    let parentId: string = memberIds[0];
    let maxConn = -1;
    for (const id of memberIds) {
      const conn = nodeMap.get(id)?.connectivity ?? 0;
      if (conn > maxConn) { maxConn = conn; parentId = id; }
    }

    clusters.set(parentId, { parentIri: parentId, nodeIds: new Set(memberIds) });
    for (const id of memberIds) claimedNodes.add(id);
  }

  return { clusters, claimedNodes };
}
