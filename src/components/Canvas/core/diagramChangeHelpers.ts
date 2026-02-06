/**
 * Optimized helpers for applying diagram changes with non-blocking chunked processing
 */

import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges } from "@xyflow/react";
import type { NodeData, LinkData } from "../../../types/canvas";

// Constants for chunking
const CHUNK_SIZE = 200; // Nodes per chunk
const CHUNK_THRESHOLD = 200; // Threshold to start chunking

/**
 * Optimized data merge that returns original reference when unchanged
 * This is critical for performance - prevents unnecessary React Flow reconciliation
 */
export function mergeDataOptimized(existingData: any, incomingData: any): any {
  // Fast path: return original if nothing to merge
  if (!incomingData || typeof incomingData !== 'object') {
    return existingData ?? {};
  }

  // Quick reference check
  if (existingData === incomingData) return existingData;

  // Check if any meaningful changes exist
  let hasChanges = false;
  const merged = { ...(existingData ?? {}) };

  for (const key of Object.keys(incomingData)) {
    const newVal = incomingData[key];
    const oldVal = merged[key];

    // Skip if values are identical
    if (oldVal === newVal) continue;

    // Array comparison
    if (Array.isArray(newVal)) {
      if (newVal.length > 0) {
        // Only update if arrays differ
        if (
          !Array.isArray(oldVal) ||
          oldVal.length !== newVal.length ||
          !oldVal.every((v, i) => v === newVal[i])
        ) {
          merged[key] = newVal;
          hasChanges = true;
        }
      }
    } else if (
      newVal !== null &&
      newVal !== undefined &&
      !(typeof newVal === 'string' && newVal.trim() === '')
    ) {
      merged[key] = newVal;
      hasChanges = true;
    }
  }

  // Return original reference if nothing changed!
  return hasChanges ? merged : existingData;
}

/**
 * Compute node changes for a batch
 */
export function computeNodeChanges(
  nodesList: RFNode<NodeData>[],
  currentNodes: RFNode<NodeData>[],
): any[] {
  // Sort so visible nodes (hidden: false or undefined) are processed first
  // This improves perceived rendering performance by showing visible content immediately
  const sortedNodes = [...nodesList].sort((a, b) => {
    const aHidden = a.hidden === true ? 1 : 0;
    const bHidden = b.hidden === true ? 1 : 0;
    return aHidden - bHidden; // false/undefined before true
  });

  const current = currentNodes || [];
  const currentById = new Map(
    current.map((node: any) => [String(node.id), node]),
  );
  const incomingById = new Map(
    sortedNodes.map((node: any) => [String(node.id), node]),
  );
  const knownIds = new Set<string>([
    ...currentById.keys(),
    ...incomingById.keys(),
  ]);
  const changes: any[] = [];

  for (const node of sortedNodes) {
    const id = String(node.id);
    const existing = currentById.get(id);
    const isPlaceholder = (node as any).data?.__isPlaceholder === true;

    if (existing) {
      // CRITICAL: Never overwrite existing nodes with placeholders!
      // Placeholders are created for edge targets but should not replace real data.
      if (isPlaceholder) {
        continue; // ← Skip this node completely - keep existing
      }

      // Merge and check if changed
      const mergedData = mergeDataOptimized(existing.data, (node as any).data);

      // Fast path: if data reference is same, skip entirely
      if (mergedData === existing.data) {
        continue; // ← No change needed!
      }

      // Only create change object if data actually changed
      const mergedNode = {
        ...existing,
        type: (node as any).type ?? existing.type,
        position: existing.position ?? (node as any).position ?? { x: 0, y: 0 },
        data: mergedData,
      };

      delete (mergedNode as any).selected;
      // Clean up the internal flag - it's only for merge decisions
      if (mergedNode.data && '__isPlaceholder' in mergedNode.data) {
        delete (mergedNode.data as any).__isPlaceholder;
      }
      changes.push({ id, type: 'replace', item: mergedNode });
    } else {
      // New node - add it
      const newNode = {
        ...(node as any),
        position: (node as any).position ?? { x: 0, y: 0 },
      };
      delete (newNode as any).selected;
      // Clean up the internal flag for new nodes too
      if (newNode.data && '__isPlaceholder' in newNode.data) {
        delete (newNode.data as any).__isPlaceholder;
      }
      changes.push({ type: 'add', item: newNode });
      knownIds.add(String(newNode.id));
    }
  }

  return changes;
}

/**
 * Compute edge changes with reconciliation
 */
export function computeEdgeChanges(
  edgesList: RFEdge<LinkData>[],
  currentEdges: RFEdge<LinkData>[],
  updatedSubjects?: Set<string>,
): any[] {
  // Sort so visible edges (hidden: false or undefined) are processed first
  // This ensures visible connections appear immediately
  const sortedEdges = [...edgesList].sort((a, b) => {
    const aHidden = a.hidden === true ? 1 : 0;
    const bHidden = b.hidden === true ? 1 : 0;
    return aHidden - bHidden; // false/undefined before true
  });

  const current = currentEdges || [];
  const currentById = new Map(
    current.map((edge: any) => [String(edge.id), edge]),
  );
  const incomingIds = new Set(sortedEdges.map((e) => String(e.id)));
  const changes: any[] = [];

  // Add or replace incoming edges
  for (const edge of sortedEdges) {
    const id = String(edge.id);
    const existing = currentById.get(id);
    const mergedEdge = {
      ...(existing ?? {}),
      ...(edge as any),
      data: {
        ...(existing?.data ?? {}),
        ...((edge as any).data ?? {}),
      },
    };
    if (existing) {
      changes.push({ id, type: 'replace', item: mergedEdge });
    } else {
      changes.push({ type: 'add', item: mergedEdge });
    }
  }

  // Remove edges FROM updated subjects that aren't in the mapper output
  if (updatedSubjects && updatedSubjects.size > 0) {
    for (const existing of current) {
      const id = String(existing.id);
      const source = String(existing.source);

      // Only remove if this edge's source was updated AND the edge isn't in new output
      const sourceWasUpdated = updatedSubjects.has(source);
      if (sourceWasUpdated && !incomingIds.has(id)) {
        changes.push({ id, type: 'remove' });
      }
    }
  }

  return changes;
}

/**
 * Apply bidirectional edge offsets
 */
export function applyBidirectionalOffsets(edges: RFEdge<LinkData>[]): RFEdge<LinkData>[] {
  const BASE_BIDIRECTIONAL_OFFSET = 40;
  const PARALLEL_EDGE_SHIFT_STEP = 60;

  // Group edges by unordered node pairs
  const bidirectionalGroups = new Map<string, RFEdge<LinkData>[]>();

  for (const edge of edges) {
    if (!edge) continue;
    const source = String(edge.source);
    const target = String(edge.target);

    // Create canonical key (alphabetically sorted)
    const canonicalKey = source < target ? `${source}||${target}` : `${target}||${source}`;

    if (!bidirectionalGroups.has(canonicalKey)) {
      bidirectionalGroups.set(canonicalKey, []);
    }
    bidirectionalGroups.get(canonicalKey)!.push(edge);
  }

  // Process each bidirectional group
  return edges.map((edge): RFEdge<LinkData> => {
    const source = String(edge.source);
    const target = String(edge.target);
    const canonicalKey = source < target ? `${source}||${target}` : `${target}||${source}`;

    const pairEdges = bidirectionalGroups.get(canonicalKey) || [];

    // Split edges by direction
    const directions = new Map<string, RFEdge<LinkData>[]>();
    for (const e of pairEdges) {
      const dirKey = `${e.source}→${e.target}`;
      if (!directions.has(dirKey)) {
        directions.set(dirKey, []);
      }
      directions.get(dirKey)!.push(e);
    }

    // Get the base shift from mapper
    const baseShift = (edge.data as any)?.shift ?? 0;

    if (directions.size === 2) {
      // Bidirectional case
      const dirKey = `${edge.source}→${edge.target}`;
      const dirEdges = directions.get(dirKey) || [];

      const sortedDirEdges = [...dirEdges].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const edgeIndex = sortedDirEdges.findIndex((e) => String(e.id) === String(edge.id));

      const baseOffset = BASE_BIDIRECTIONAL_OFFSET;
      const parallelOffset = edgeIndex * PARALLEL_EDGE_SHIFT_STEP;
      const finalShift = baseOffset + parallelOffset;

      return {
        ...edge,
        data: {
          ...edge.data,
          shift: finalShift,
        },
      } as RFEdge<LinkData>;
    }

    // Unidirectional: keep the shift from mapper
    return edge;
  });
}

/**
 * Chunked non-blocking apply for large updates
 */
export async function applyDiagramChangeChunked(
  nodesList: RFNode<NodeData>[],
  edgesList: RFEdge<LinkData>[],
  updatedSubjects: Set<string> | undefined,
  setNodes: (updater: any) => void,
  setEdges: (updater: any) => void,
  canvasActions?: { setLoading: (loading: boolean, progress: number, message: string) => void },
  yieldFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  suppressLayoutFn?: (suppress: boolean) => void,
): Promise<void> {
  // Signal to suppress layout during chunked update
  if (suppressLayoutFn) suppressLayoutFn(true);
  const totalNodes = nodesList.length;

  // Show progress for large updates
  if (totalNodes > 500 && canvasActions) {
    canvasActions.setLoading(true, 0, `Processing ${totalNodes} nodes...`);
  }

  // Process nodes in chunks
  for (let i = 0; i < nodesList.length; i += CHUNK_SIZE) {
    const chunk = nodesList.slice(i, i + CHUNK_SIZE);

    // Process chunk
    setNodes((prev: RFNode<NodeData>[]) => {
      const changes = computeNodeChanges(chunk, prev);
      return applyNodeChanges(changes as any, prev);
    });

    // Update progress
    if (totalNodes > 500 && canvasActions) {
      const processed = Math.min(i + CHUNK_SIZE, totalNodes);
      const percent = Math.round((processed / totalNodes) * 90);
      canvasActions.setLoading(true, percent, `Processing ${processed}/${totalNodes} nodes...`);
    }

    // Yield to browser (keep UI responsive)
    await yieldFn(0);
  }

  // Process edges (single batch usually fine)
  setEdges((prev: RFEdge<LinkData>[]) => {
    const changes = computeEdgeChanges(edgesList, prev, updatedSubjects);
    const newEdgeState = applyEdgeChanges(changes as any, prev);
    return applyBidirectionalOffsets(newEdgeState);
  });

  if (totalNodes > 500 && canvasActions) {
    canvasActions.setLoading(false, 0, '');
  }

  // Re-enable layout after all chunks complete
  if (suppressLayoutFn) suppressLayoutFn(false);
}

/**
 * Main entry point: decides between immediate or chunked apply
 * Returns true if chunking was used (caller should defer layout)
 */
export async function applyDiagramChangeSmart(
  nodesList: RFNode<NodeData>[],
  edgesList: RFEdge<LinkData>[],
  updatedSubjects: Set<string> | undefined,
  setNodes: (updater: any) => void,
  setEdges: (updater: any) => void,
  canvasActions?: { setLoading: (loading: boolean, progress: number, message: string) => void },
  yieldFn?: (ms: number) => Promise<void>,
  suppressLayoutFn?: (suppress: boolean) => void,
): Promise<boolean> {
  // Small updates: apply immediately (fast path)
  if (nodesList.length < CHUNK_THRESHOLD) {
    setNodes((prev: RFNode<NodeData>[]) => {
      const changes = computeNodeChanges(nodesList, prev);
      // Create placeholders for edge endpoints
      const knownIds = new Set(prev.map((n) => String(n.id)));
      const newIds = new Set(nodesList.map((n) => String(n.id)));
      for (const id of newIds) knownIds.add(id);

      for (const edge of edgesList) {
        const source = String(edge?.source ?? '');
        const target = String(edge?.target ?? '');

        for (const id of [source, target]) {
          if (id && !knownIds.has(id)) {
            knownIds.add(id);
            changes.push({
              type: 'add',
              item: {
                id,
                type: 'ontology',
                position: { x: 0, y: 0 },
                data: {
                  key: id,
                  iri: id,
                  rdfTypes: [],
                  literalProperties: [],
                  annotationProperties: [],
                  inferredProperties: [],
                  visible: true,
                },
              },
            });
          }
        }
      }

      return applyNodeChanges(changes as any, prev);
    });

    setEdges((prev: RFEdge<LinkData>[]) => {
      const changes = computeEdgeChanges(edgesList, prev, updatedSubjects);
      const newEdgeState = applyEdgeChanges(changes as any, prev);
      return applyBidirectionalOffsets(newEdgeState);
    });

    return false; // No chunking used
  }

  // Large updates: use chunked processing
  await applyDiagramChangeChunked(
    nodesList,
    edgesList,
    updatedSubjects,
    setNodes,
    setEdges,
    canvasActions,
    yieldFn,
    suppressLayoutFn,
  );

  return true; // Chunking was used
}
