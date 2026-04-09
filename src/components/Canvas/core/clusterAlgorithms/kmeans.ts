/**
 * K-means clustering algorithm using ml-kmeans.
 * Features: normalised (x, y) canvas position + connectivity.
 */

import { kmeans } from 'ml-kmeans';
import type { ClusterNode, ClusterEdge, ClusterInfo, ClusterResult, ClusterAlgorithmOptions } from './types';

const TARGET_MAX_CLUSTERS = 100;

export function computeClustersKmeans(
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: ClusterAlgorithmOptions
): ClusterResult {
  console.log('[Kmeans] Starting clustering:', { nodeCount: nodes.length, edgeCount: edges.length });

  if (nodes.length < 2) {
    console.log('[Kmeans] Too few nodes for clustering');
    return { clusters: new Map(), claimedNodes: new Set() };
  }

  const k = Math.min(Math.ceil(nodes.length / 10), TARGET_MAX_CLUSTERS);

  // Collect raw values for normalisation
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minConn = Infinity, maxConn = -Infinity;

  for (const node of nodes) {
    const x = node.position?.x ?? 0;
    const y = node.position?.y ?? 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minConn = Math.min(minConn, node.connectivity);
    maxConn = Math.max(maxConn, node.connectivity);
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const rangeConn = maxConn - minConn || 1;

  const features: number[][] = [];
  const nodeIds: string[] = [];

  for (const node of nodes) {
    features.push([
      ((node.position?.x ?? 0) - minX) / rangeX,
      ((node.position?.y ?? 0) - minY) / rangeY,
      (node.connectivity - minConn) / rangeConn,
    ]);
    nodeIds.push(node.id);
  }

  let result;
  try {
    result = kmeans(features, k, { initialization: 'kmeans++', maxIterations: 100 });
  } catch (error) {
    console.error('[Kmeans] Clustering failed:', error);
    return { clusters: new Map(), claimedNodes: new Set() };
  }

  const clusterGroups = new Map<number, string[]>();
  for (let i = 0; i < result.clusters.length; i++) {
    const cid = result.clusters[i];
    if (!clusterGroups.has(cid)) clusterGroups.set(cid, []);
    clusterGroups.get(cid)!.push(nodeIds[i]);
  }

  return buildClusters(nodes, clusterGroups);
}

function buildClusters(
  nodes: ClusterNode[],
  clusterGroups: Map<number, string[]>
): ClusterResult {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const clusters = new Map<string, ClusterInfo>();
  const claimedNodes = new Set<string>();

  for (const [, memberIds] of clusterGroups) {
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
