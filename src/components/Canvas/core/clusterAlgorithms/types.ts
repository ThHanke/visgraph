/**
 * Shared types for clustering algorithms.
 * No dependency on React Flow or any canvas framework.
 */

export interface ClusterNode {
  id: string;
  connectivity: number;
  position?: { x: number; y: number };
}

export interface ClusterEdge {
  id: string;
  source: string;
  target: string;
}

export interface ClusterInfo {
  parentIri: string;
  nodeIds: Set<string>;
}

export interface ClusterResult {
  clusters: Map<string, ClusterInfo>;
  claimedNodes: Set<string>;
}

export interface ClusterAlgorithmOptions {
  threshold: number;
}

export type ClusterAlgorithm = (
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: ClusterAlgorithmOptions
) => ClusterResult;
