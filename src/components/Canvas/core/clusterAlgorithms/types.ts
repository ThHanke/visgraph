/**
 * Shared types for clustering algorithms
 */

import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../../types/canvas";

export interface ClusterInfo {
  parentIri: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

export interface ClusterResult {
  clusters: Map<string, ClusterInfo>;
  claimedNodes: Set<string>;
}

export interface ClusterAlgorithmOptions {
  threshold: number;
  collapsedSet: Set<string>;
}

export type ClusterAlgorithm = (
  nodes: RFNode<NodeData>[],
  edges: RFEdge<LinkData>[],
  options: ClusterAlgorithmOptions
) => ClusterResult;
