/**
 * useSearchHighlight hook
 * 
 * Detects when browser's native find-in-page (Ctrl+F/Cmd+F) highlights text
 * within React Flow nodes and edges, automatically focusing on matches.
 * 
 * Creates a hidden searchable DOM layer containing ALL node/edge text so browser
 * find can search virtualized/off-screen content. When browser highlights text,
 * we detect it and navigate the viewport to show the corresponding node.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { ReactFlowInstance } from '@xyflow/react';

interface UseSearchHighlightOptions {
  reactFlowInstance: ReactFlowInstance | null;
  nodes: RFNode[];
  edges: RFEdge[];
  setNodes: (updater: (nodes: RFNode[]) => RFNode[]) => void;
  debounceMs?: number;
}

type Match = { type: 'node'; id: string } | { type: 'edge'; id: string };

export function useSearchHighlight({
  reactFlowInstance,
  nodes,
  edges,
  setNodes,
  debounceMs = 150,
}: UseSearchHighlightOptions) {
  const debounceTimerRef = useRef<number | null>(null);
  const lastSearchTextRef = useRef<string>('');
  const currentMatchIndexRef = useRef<number>(0);
  const matchingItemsRef = useRef<Match[]>([]);
  const searchOverlayRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedMatchRef = useRef<string | null>(null);
  const [, setUpdateTrigger] = useState(0);

  // Helper function to extract searchable text from a node
  const getSearchableText = useCallback((node: RFNode): string => {
    try {
      const data = node.data as any;
      const parts: string[] = [];
      
      // Collect all text fields
      if (data.displayPrefixed) parts.push(String(data.displayPrefixed));
      if (data.displayShort) parts.push(String(data.displayShort));
      if (data.label) parts.push(String(data.label));
      if (data.subtitle) parts.push(String(data.subtitle));
      if (data.humanLabel) parts.push(String(data.humanLabel));
      if (data.classType) parts.push(String(data.classType));
      if (data.displayclassType) parts.push(String(data.displayclassType));
      if (data.iri) parts.push(String(data.iri));
      
      // Add annotation properties
      if (Array.isArray(data.properties)) {
        for (const prop of data.properties) {
          if (prop && typeof prop === 'object') {
            if (prop.property) parts.push(String(prop.property));
            if (prop.value) parts.push(String(prop.value));
          }
        }
      }
      
      // Add RDF types
      if (Array.isArray(data.rdfTypes)) {
        parts.push(...data.rdfTypes.map((t: any) => String(t)));
      }
      
      return parts.join(' ').toLowerCase();
    } catch {
      return '';
    }
  }, []);

  // Helper function to extract searchable text from an edge
  const getEdgeSearchableText = useCallback((edge: RFEdge): string => {
    try {
      const data = edge.data as any;
      const parts: string[] = [];
      
      // Include edge ID components to make each edge searchable by source/target
      const source = String(edge.source || '');
      const target = String(edge.target || '');
      
      if (data.label) parts.push(String(data.label));
      if (data.propertyUri) parts.push(String(data.propertyUri));
      if (data.propertyType) parts.push(String(data.propertyType));
      
      // Add source and target to make edges distinguishable
      if (source) parts.push(source);
      if (target) parts.push(target);
      
      return parts.join(' ').toLowerCase();
    } catch {
      return '';
    }
  }, []);

  // Search all nodes and edges for matching text
  const findMatchingItems = useCallback((searchText: string): Match[] => {
    if (!searchText || searchText.length < 2) return [];
    
    const lowerSearch = searchText.toLowerCase();
    const matches: Match[] = [];
    
    // Search nodes
    for (const node of nodes) {
      const nodeText = getSearchableText(node);
      if (nodeText.includes(lowerSearch)) {
        matches.push({ type: 'node', id: String(node.id) });
      }
    }
    
    // Search edges
    for (const edge of edges) {
      const edgeText = getEdgeSearchableText(edge);
      if (edgeText.includes(lowerSearch)) {
        matches.push({ type: 'edge', id: String(edge.id) });
      }
    }
    
    return matches;
  }, [nodes, edges, getSearchableText, getEdgeSearchableText]);

  // Focus on a specific node by moving viewport
  // Enhanced to handle virtualized/unrendered nodes
  const focusNode = useCallback(async (nodeId: string) => {
    if (!reactFlowInstance) return;
    
    try {
      // Try to get the node from React Flow's state
      let node = reactFlowInstance.getNode(nodeId);
      
      // If node isn't in rendered state, search in the full nodes array
      if (!node) {
        const allNodes = nodes;
        node = allNodes.find((n) => String(n.id) === nodeId);
      }
      
      if (!node) {
        console.debug('[useSearchHighlight] Node not found:', nodeId);
        return;
      }
      
      // Select the node
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: String(n.id) === nodeId,
        }))
      );
      
      // For potentially unrendered nodes, use setCenter to move viewport
      // This ensures the node gets rendered before we try to highlight text
      if (node.position && typeof reactFlowInstance.setCenter === 'function') {
        try {
          // Move viewport to center on the node
          reactFlowInstance.setCenter(
            node.position.x,
            node.position.y,
            { zoom: 1.2, duration: 300 }
          );
          
          // Wait for React Flow to render the node (important for virtualization)
          await new Promise((resolve) => setTimeout(resolve, 350));
        } catch (err) {
          console.debug('[useSearchHighlight] setCenter failed, using fitView', err);
          // Fallback to fitView
          reactFlowInstance.fitView({
            padding: 0.3,
            duration: 300,
            nodes: [node],
            maxZoom: 1.5,
          });
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      } else {
        // Fallback to fitView for rendered nodes
        reactFlowInstance.fitView({
          padding: 0.3,
          duration: 300,
          nodes: [node],
          maxZoom: 1.5,
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } catch (err) {
      console.debug('[useSearchHighlight] focusNode failed', err);
    }
  }, [reactFlowInstance, nodes, setNodes]);

  // Focus on a specific edge by moving viewport to show both endpoints
  // Enhanced to handle virtualized/unrendered edges
  const focusEdge = useCallback(async (edgeId: string) => {
    if (!reactFlowInstance) return;
    
    try {
      // Try to find edge in React Flow state
      let edge = reactFlowInstance.getEdges().find(e => String(e.id) === edgeId);
      
      // If not found in rendered state, search in full edges array
      if (!edge) {
        edge = edges.find(e => String(e.id) === edgeId);
      }
      
      if (!edge) {
        console.debug('[useSearchHighlight] Edge not found:', edgeId);
        return;
      }
      
      // Find source and target nodes
      let sourceNode = reactFlowInstance.getNode(String(edge.source));
      let targetNode = reactFlowInstance.getNode(String(edge.target));
      
      // Search in full nodes array if not in rendered state
      if (!sourceNode) {
        sourceNode = nodes.find(n => String(n.id) === String(edge.source));
      }
      if (!targetNode) {
        targetNode = nodes.find(n => String(n.id) === String(edge.target));
      }
      
      if (!sourceNode || !targetNode) {
        console.debug('[useSearchHighlight] Edge endpoints not found');
        return;
      }
      
      // Deselect all nodes
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: false,
        }))
      );
      
      // Move viewport to show both nodes (which will show the edge between them)
      reactFlowInstance.fitView({
        padding: 0.3,
        duration: 300,
        nodes: [sourceNode, targetNode],
        maxZoom: 1.5,
      });
      
      // Wait for React Flow to render the nodes and edge
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch (err) {
      console.debug('[useSearchHighlight] focusEdge failed', err);
    }
  }, [reactFlowInstance, nodes, edges, setNodes]);

  // Focus on a match (node or edge)
  const focusMatch = useCallback((match: Match) => {
    if (match.type === 'node') {
      focusNode(match.id);
    } else {
      focusEdge(match.id);
    }
  }, [focusNode, focusEdge]);

  const handleSelectionChange = useCallback(() => {
    // Clear any pending debounce
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(async () => {
      try {
        const selection = window.getSelection();
        
        // Only proceed if there's a selection with text content
        if (!selection || selection.rangeCount === 0) {
          return;
        }
        
        const searchText = selection.toString().trim();
        if (!searchText) return;

        // Get the anchor node (where the selection starts)
        const anchorNode = selection.anchorNode;
        if (!anchorNode) return;

        // Traverse up the DOM tree to find our search overlay markers
        let element: HTMLElement | null = 
          anchorNode.nodeType === Node.ELEMENT_NODE 
            ? (anchorNode as HTMLElement)
            : (anchorNode.parentElement as HTMLElement);

        let foundId: string | null = null;
        let foundType: 'node' | 'edge' | null = null;
        let maxDepth = 20;

        while (element && maxDepth > 0) {
          // Check for search overlay markers first
          const vgNodeId = element.getAttribute('data-vg-node-id');
          const vgEdgeId = element.getAttribute('data-vg-edge-id');
          const vgType = element.getAttribute('data-vg-type');

          if (vgNodeId && vgType === 'node') {
            foundId = vgNodeId;
            foundType = 'node';
            console.debug('[useSearchHighlight] Found match in search overlay (node):', vgNodeId);
            break;
          }
          
          if (vgEdgeId && vgType === 'edge') {
            foundId = vgEdgeId;
            foundType = 'edge';
            console.debug('[useSearchHighlight] Found match in search overlay (edge):', vgEdgeId);
            break;
          }

          // Also check for regular node containers (for rendered nodes)
          const dataNodeId = element.getAttribute('data-node-id');
          if (dataNodeId) {
            foundId = dataNodeId;
            foundType = 'node';
            console.debug('[useSearchHighlight] Found match in rendered node:', dataNodeId);
            break;
          }
          
          // Check for edge labels
          if (element.classList.contains('react-flow__edge-text') || 
              element.classList.contains('react-flow__edge-textwrapper')) {
            let edgeElement = element.parentElement;
            let edgeDepth = 5;
            while (edgeElement && edgeDepth > 0) {
              const edgeId = edgeElement.getAttribute('data-id');
              if (edgeId) {
                foundId = edgeId;
                foundType = 'edge';
                console.debug('[useSearchHighlight] Found match in rendered edge:', edgeId);
                break;
              }
              edgeElement = edgeElement.parentElement;
              edgeDepth--;
            }
            if (foundId) break;
          }
          
          element = element.parentElement;
          maxDepth--;
        }

        // If we found a match, navigate to it (but only if it's different from last)
        if (foundId && foundType) {
          const matchKey = `${foundType}:${foundId}`;
          
          // Only navigate if this is a different match than last time
          if (lastFocusedMatchRef.current !== matchKey) {
            console.debug('[useSearchHighlight] Navigating to:', { type: foundType, id: foundId });
            lastFocusedMatchRef.current = matchKey;
            const match: Match = { type: foundType, id: foundId };
            await focusMatch(match);
          } else {
            console.debug('[useSearchHighlight] Skipping - already at this match:', matchKey);
          }
        }
      } catch (err) {
        console.debug('[useSearchHighlight] Selection change handler error', err);
      }
    }, debounceMs);
  }, [debounceMs, focusMatch]);

  // Handle keyboard shortcuts for cycling through matches
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    // F3 or Cmd/Ctrl+G for "Find Next"
    const isFindNext = 
      e.key === 'F3' || 
      ((e.metaKey || e.ctrlKey) && e.key === 'g' && !e.shiftKey);
    
    // Shift+F3 or Cmd/Ctrl+Shift+G for "Find Previous"
    const isFindPrev = 
      (e.key === 'F3' && e.shiftKey) ||
      ((e.metaKey || e.ctrlKey) && e.key === 'g' && e.shiftKey);
    
    if (!isFindNext && !isFindPrev) return;
    
    // If we have matches, cycle through them
    if (matchingItemsRef.current.length > 0) {
      // Prevent default browser find behavior - we'll handle it ourselves
      e.preventDefault();
      e.stopPropagation();
      
      if (isFindNext) {
        currentMatchIndexRef.current = (currentMatchIndexRef.current + 1) % matchingItemsRef.current.length;
      } else if (isFindPrev) {
        currentMatchIndexRef.current = currentMatchIndexRef.current === 0 
          ? matchingItemsRef.current.length - 1 
          : currentMatchIndexRef.current - 1;
      }
      
      const match = matchingItemsRef.current[currentMatchIndexRef.current];
      if (match) {
        console.debug('[useSearchHighlight] Navigating to match:', {
          index: currentMatchIndexRef.current,
          total: matchingItemsRef.current.length,
          match,
        });
        
        // Focus the match (this will navigate viewport and wait for rendering)
        await focusMatch(match);
        
        // After focusing, try to trigger browser's find to highlight the text
        // This works because the node is now rendered in the DOM
        setTimeout(() => {
          try {
            // Get the current selection text to re-trigger browser highlighting
            const searchText = lastSearchTextRef.current;
            if (searchText && window.find) {
              // Use browser's native find to highlight the text now that it's rendered
              window.find(searchText, false, isFindPrev);
            }
          } catch (err) {
            console.debug('[useSearchHighlight] Browser find trigger failed', err);
          }
        }, 100);
      }
    }
  }, [focusMatch]);

  // Create and maintain a hidden searchable overlay with ALL node/edge text
  useEffect(() => {
    // Create overlay element if it doesn't exist
    if (!searchOverlayRef.current) {
      const overlay = document.createElement('div');
      overlay.id = 'vg-search-overlay';
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.overflow = 'hidden';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '-1';
      overlay.style.opacity = '0';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
      searchOverlayRef.current = overlay;
    }

    // Populate overlay with searchable text from ALL nodes and edges
    const overlay = searchOverlayRef.current;
    overlay.innerHTML = '';

    // Add nodes - create ONE span per node with UNIQUE content
    let nodeCounter = 0;
    nodes.forEach((node) => {
      const nodeText = getSearchableText(node);
      if (nodeText) {
        nodeCounter++;
        const span = document.createElement('span');
        // Prepend counter to make each node absolutely unique
        span.textContent = `NODE#${nodeCounter} ${nodeText}`;
        span.setAttribute('data-vg-node-id', String(node.id));
        span.setAttribute('data-vg-type', 'node');
        span.style.display = 'inline-block';
        span.style.margin = '0 12px';
        span.style.whiteSpace = 'nowrap';
        overlay.appendChild(span);
      }
    });

    // Add edges - create ONE span per edge with UNIQUE content
    // Use a counter to ensure each edge is completely distinct
    let edgeCounter = 0;
    edges.forEach((edge) => {
      const data = edge.data as any;
      
      // Only use the label for search, not the full URIs (to avoid duplicate matches)
      let label = data?.label ? String(data.label).toLowerCase() : '';
      
      // If no label, try propertyType or propertyUri as fallback
      if (!label && data?.propertyType) {
        label = String(data.propertyType).toLowerCase();
      }
      if (!label && data?.propertyUri) {
        label = String(data.propertyUri).toLowerCase();
      }
      
      if (label) {
        edgeCounter++;
        const span = document.createElement('span');
        
        // Create completely unique text by prepending a counter
        // This ensures browser sees each edge as a distinct match
        span.textContent = `EDGE#${edgeCounter} ${label}`;
        
        span.setAttribute('data-vg-edge-id', String(edge.id));
        span.setAttribute('data-vg-type', 'edge');
        span.setAttribute('data-vg-source', String(edge.source || ''));
        span.setAttribute('data-vg-target', String(edge.target || ''));
        span.style.display = 'inline-block';
        span.style.margin = '0 12px';
        span.style.whiteSpace = 'nowrap';
        overlay.appendChild(span);
      }
    });

    return () => {
      // Cleanup on unmount
      if (searchOverlayRef.current) {
        searchOverlayRef.current.remove();
        searchOverlayRef.current = null;
      }
    };
  }, [nodes, edges, getSearchableText, getEdgeSearchableText]);

  useEffect(() => {
    // Listen to selection changes globally
    document.addEventListener('selectionchange', handleSelectionChange);
    // Listen to keyboard events for F3/Cmd+G
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('keydown', handleKeyDown);
      
      // Clean up any pending debounce timers
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [handleSelectionChange, handleKeyDown]);

  // Cleanup function for external callers
  return useCallback(() => {
    // Reserved for future cleanup needs
  }, []);
}
