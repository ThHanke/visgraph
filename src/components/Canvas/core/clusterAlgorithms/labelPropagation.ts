/**
 * Label Propagation clustering algorithm using ngraph.slpa
 * SLPA (Speaker-Listener Label Propagation) - Detects overlapping communities
 */

import createGraph from 'ngraph.graph';
import slpa from 'ngraph.slpa';
import type { ClusterNode, ClusterEdge, ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from './types';

/** Target maximum number of clusters */
const TARGET_MAX_CLUSTERS = 100;

/**
 * Label Propagation clustering algorithm using SLPA.
 *
 * Uses speaker-listener label propagation to detect communities.
 * Overlapping-community output is resolved to the primary community per node.
 */
export function computeClustersLabelPropagation(
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  console.log('[LabelPropagation] Starting clustering:', {
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  const graph = createGraph();

  for (const node of nodes) {
    graph.addNode(node.id);
  }

  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    try {
      graph.addLink(edge.source, edge.target);
    } catch {
      // duplicate link — ignore
    }
  }

  console.log('[LabelPropagation] Graph created:', {
    nodeCount: graph.getNodesCount(),
    linksCount: graph.getLinksCount(),
  });

  // slpa(graph, T, r): T = iterations (≥20), r = community threshold (0–1)
  const result = slpa(graph, 20, 0.1);

  console.log('[LabelPropagation] SLPA complete:', {
    communitiesCount: result?.communities ? Object.keys(result.communities).length : 0,
  });

  const communityGroups = new Map<string, string[]>();

  if (result?.communities) {
    const sorted = Object.entries(result.communities)
      .map(([name, members]) => ({ name, members: members as string[] }))
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, TARGET_MAX_CLUSTERS);

    for (const { name, members } of sorted) {
      communityGroups.set(name, members);
    }
  }

  return buildClusters(nodes, communityGroups);
}

/** Pick highest-connectivity node as parent; build ClusterResult from community groups. */
function buildClusters(
  nodes: ClusterNode[],
  communityGroups: Map<string, string[]>
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
