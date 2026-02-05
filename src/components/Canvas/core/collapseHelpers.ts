/**
 * Collapse/expand helpers for node hiding based on predicate priority
 * 
 * This module provides utilities for determining which nodes should be hidden
 * when a node is collapsed, using predicate-frequency sorting to prioritize
 * rare predicates (keeping them visible) over common predicates.
 */

/**
 * Find nodes to hide based on predicate frequency priority.
 * 
 * Strategy:
 * - Get outgoing edges from collapsed node
 * - Count predicate occurrences
 * - Sort edges by predicate frequency (ascending - rare predicates first)
 * - Hide target nodes from edges at index >= threshold
 * - BUT: Only hide LEAF nodes (nodes with no outgoing edges to other visible nodes)
 * 
 * This ensures that:
 * 1. Connections with rare predicates are preserved
 * 2. Common predicates are hidden first
 * 3. Intermediate nodes with connections to other visible nodes are kept visible
 * 
 * @param collapsedNodeIri - IRI of the node being collapsed
 * @param allEdges - All edges in the graph (with source, target, predicateUri)
 * @param threshold - Number of visible edges before hiding starts
 * @returns Set of node IRIs that should be hidden
 */
export function findNodesToHideByPredicate(
  collapsedNodeIri: string,
  allEdges: Array<{ source: string; target: string; predicateUri: string }>,
  threshold: number
): Set<string> {
  // Get outgoing edges from collapsed node
  const outgoingEdges = allEdges.filter(e => e.source === collapsedNodeIri);
  
  if (outgoingEdges.length === 0) {
    // No outgoing edges, nothing to hide
    return new Set<string>();
  }

  // Count predicate frequency
  const predicateCount = new Map<string, number>();
  for (const edge of outgoingEdges) {
    const count = predicateCount.get(edge.predicateUri) ?? 0;
    predicateCount.set(edge.predicateUri, count + 1);
  }

  // Sort edges by predicate frequency (ascending - rare predicates first)
  const sortedEdges = outgoingEdges.slice().sort((a, b) => {
    const countA = predicateCount.get(a.predicateUri) ?? 0;
    const countB = predicateCount.get(b.predicateUri) ?? 0;
    return countA - countB; // Ascending: rare predicates first
  });

  // Identify candidate nodes to hide (targets from index threshold onwards)
  const candidateTargets = new Set<string>();
  for (let i = threshold; i < sortedEdges.length; i++) {
    candidateTargets.add(sortedEdges[i].target);
  }

  // Filter out non-leaf nodes - keep nodes visible if they have outgoing edges to other nodes
  // A node is a leaf if it has no outgoing edges, OR all its outgoing edges point to other hidden nodes
  const toHide = new Set<string>();
  
  for (const candidateIri of candidateTargets) {
    // Check if this candidate has any outgoing edges
    const candidateOutgoing = allEdges.filter(e => e.source === candidateIri);
    
    if (candidateOutgoing.length === 0) {
      // No outgoing edges - this is a leaf node, can be hidden
      toHide.add(candidateIri);
    } else {
      // Has outgoing edges - check if all targets are either:
      // 1. Also being hidden
      // 2. Or the collapsed node itself
      const hasVisibleTargets = candidateOutgoing.some(e => {
        const target = e.target;
        // Don't count edges back to the collapsed node
        if (target === collapsedNodeIri) return false;
        // Check if target will be hidden
        return !candidateTargets.has(target);
      });
      
      if (!hasVisibleTargets) {
        // All outgoing edges point to hidden nodes or back to collapsed node
        // This node can be hidden
        toHide.add(candidateIri);
      }
      // else: has connections to visible nodes, keep it visible (don't add to toHide)
    }
  }

  return toHide;
}

/**
 * Apply collapse filtering to a set of nodes and edges.
 * 
 * This function:
 * 1. Computes which nodes should be hidden based on collapse state
 * 2. Generates React Flow node changes to update isCollapsed AND hidden flags efficiently
 * 3. Generates React Flow edge changes to hide edges connected to hidden nodes
 * 4. React Flow automatically handles rendering - hidden nodes and edges won't display
 * 
 * @param nodes - All nodes in the current view
 * @param edges - All edges in the current view (used to compute which nodes to hide)
 * @param collapsedNodes - Set of collapsed node IRIs
 * @param collapseThreshold - Threshold for collapse
 * @returns Object with nodeChanges and edgeChanges arrays to apply via applyNodeChanges/applyEdgeChanges
 */
export function applyCollapseFilter<N extends { id: string | unknown; data?: any; hidden?: boolean }, E extends { id: string | unknown; source: string | unknown; target: string | unknown; data?: { propertyUri?: string }; hidden?: boolean }>(
  nodes: Array<N>,
  edges: Array<E>,
  collapsedNodes: Set<string>,
  collapseThreshold: number
): { nodeChanges: Array<{ id: string; type: 'replace'; item: N }>; edgeChanges: Array<{ id: string; type: 'replace'; item: E }> } {
  // Build edge structure for predicate-priority computation
  const allEdges = edges.map(e => ({
    source: String(e.source),
    target: String(e.target),
    predicateUri: e.data?.propertyUri || '',
  }));

  // Compute hidden nodes using predicate-priority algorithm
  const hiddenNodeSet = new Set<string>();
  for (const collapsedIri of collapsedNodes) {
    const toHide = findNodesToHideByPredicate(
      collapsedIri, 
      allEdges, 
      collapseThreshold
    );
    toHide.forEach(n => hiddenNodeSet.add(n));
  }

  // Generate React Flow node changes for both collapse state AND visibility
  // Only create change objects for nodes whose state actually changed
  const nodeChanges: Array<{ id: string; type: 'replace'; item: N }> = [];
  
  for (const node of nodes) {
    const nodeId = String(node.id);
    const isCurrentlyCollapsed = collapsedNodes.has(nodeId);
    const shouldBeHidden = hiddenNodeSet.has(nodeId);
    
    // Check if collapse state changed
    const dataIsCollapsed = node.data && typeof (node.data as any).isCollapsed === 'boolean' 
      ? (node.data as any).isCollapsed 
      : false;
    
    // Check if hidden state changed
    const currentlyHidden = typeof node.hidden === 'boolean' ? node.hidden : false;
    
    // Only generate change if something actually changed
    if (dataIsCollapsed !== isCurrentlyCollapsed || currentlyHidden !== shouldBeHidden) {
      // Generate a replace change with updated collapse state AND hidden flag
      nodeChanges.push({
        id: nodeId,
        type: 'replace',
        item: {
          ...node,
          hidden: shouldBeHidden,
          data: {
            ...(node.data || {}),
            isCollapsed: isCurrentlyCollapsed,
          },
        } as N,
      });
    }
  }

  // Generate React Flow edge changes to hide edges connected to hidden nodes
  // Only create change objects for edges whose hidden state actually changed
  const edgeChanges: Array<{ id: string; type: 'replace'; item: E }> = [];
  
  for (const edge of edges) {
    const edgeId = String(edge.id);
    const sourceId = String(edge.source);
    const targetId = String(edge.target);
    
    // Hide edge if either source or target is hidden
    const shouldBeHidden = hiddenNodeSet.has(sourceId) || hiddenNodeSet.has(targetId);
    
    // Check if hidden state changed
    const currentlyHidden = typeof edge.hidden === 'boolean' ? edge.hidden : false;
    
    // Only generate change if hidden state actually changed
    if (currentlyHidden !== shouldBeHidden) {
      edgeChanges.push({
        id: edgeId,
        type: 'replace',
        item: {
          ...edge,
          hidden: shouldBeHidden,
        } as E,
      });
    }
  }

  return { nodeChanges, edgeChanges };
}
