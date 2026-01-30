/**
 * useSearchHighlight hook
 * 
 * Detects when browser's native find-in-page (Ctrl+F/Cmd+F) highlights text
 * within React Flow nodes and edges, automatically focusing on matches.
 * 
 * Searches ALL nodes and edges (including off-screen ones) by examining their data
 * and moving the viewport to show matches.
 */

import { useEffect, useCallback, useRef } from 'react';
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
      
      if (data.label) parts.push(String(data.label));
      if (data.propertyUri) parts.push(String(data.propertyUri));
      if (data.propertyType) parts.push(String(data.propertyType));
      
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
  const focusNode = useCallback((nodeId: string) => {
    if (!reactFlowInstance) return;
    
    try {
      const node = reactFlowInstance.getNode(nodeId);
      if (!node) return;
      
      // Select the node
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: String(n.id) === nodeId,
        }))
      );
      
      // Move viewport to show the node
      reactFlowInstance.fitView({
        padding: 0.3,
        duration: 300,
        nodes: [node],
        maxZoom: 1.5,
      });
    } catch (err) {
      console.debug('[useSearchHighlight] focusNode failed', err);
    }
  }, [reactFlowInstance, setNodes]);

  // Focus on a specific edge by moving viewport to show both endpoints
  const focusEdge = useCallback((edgeId: string) => {
    if (!reactFlowInstance) return;
    
    try {
      const edge = reactFlowInstance.getEdges().find(e => String(e.id) === edgeId);
      if (!edge) return;
      
      const sourceNode = reactFlowInstance.getNode(String(edge.source));
      const targetNode = reactFlowInstance.getNode(String(edge.target));
      
      if (!sourceNode || !targetNode) return;
      
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
    } catch (err) {
      console.debug('[useSearchHighlight] focusEdge failed', err);
    }
  }, [reactFlowInstance, setNodes]);

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

    debounceTimerRef.current = window.setTimeout(() => {
      try {
        const selection = window.getSelection();
        
        // Only proceed if there's a selection with text content
        if (!selection || selection.rangeCount === 0) {
          return;
        }
        
        const searchText = selection.toString().trim();
        if (!searchText) return;

        // Check if search text changed - if so, find all matches
        if (searchText !== lastSearchTextRef.current) {
          lastSearchTextRef.current = searchText;
          matchingItemsRef.current = findMatchingItems(searchText);
          currentMatchIndexRef.current = 0;
          
          console.debug('[useSearchHighlight] Found', matchingItemsRef.current.length, 'matches for:', searchText);
        }

        // Get the anchor node (where the selection starts)
        const anchorNode = selection.anchorNode;
        if (!anchorNode) {
          // No DOM node selected - try to move to next match from our list
          if (matchingItemsRef.current.length > 0) {
            const nextMatch = matchingItemsRef.current[currentMatchIndexRef.current];
            if (nextMatch) {
              focusMatch(nextMatch);
              currentMatchIndexRef.current = (currentMatchIndexRef.current + 1) % matchingItemsRef.current.length;
            }
          }
          return;
        }

        // Traverse up the DOM tree to find the node container with data-node-id
        let element: HTMLElement | null = 
          anchorNode.nodeType === Node.ELEMENT_NODE 
            ? (anchorNode as HTMLElement)
            : (anchorNode.parentElement as HTMLElement);

        let foundId: string | null = null;
        let foundType: 'node' | 'edge' | null = null;
        let maxDepth = 20; // Prevent infinite loops

        while (element && maxDepth > 0) {
          const dataNodeId = element.getAttribute('data-node-id');
          if (dataNodeId) {
            foundId = dataNodeId;
            foundType = 'node';
            break;
          }
          
          // Check if this is an edge label element
          // Edge labels typically have class names like 'react-flow__edge-text' or similar
          if (element.classList.contains('react-flow__edge-text') || 
              element.classList.contains('react-flow__edge-textwrapper')) {
            // Try to find edge id from parent edge element
            let edgeElement = element.parentElement;
            let edgeDepth = 5;
            while (edgeElement && edgeDepth > 0) {
              const edgeId = edgeElement.getAttribute('data-id');
              if (edgeId) {
                foundId = edgeId;
                foundType = 'edge';
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

        // Found a match in a rendered element
        if (foundId && foundType) {
          const matchIndex = matchingItemsRef.current.findIndex(
            m => m.id === foundId && m.type === foundType
          );
          if (matchIndex !== -1) {
            currentMatchIndexRef.current = matchIndex;
            focusMatch(matchingItemsRef.current[matchIndex]);
          }
        } else if (matchingItemsRef.current.length > 0) {
          // No rendered element found, but we have matches - move to next match
          const nextMatch = matchingItemsRef.current[currentMatchIndexRef.current];
          if (nextMatch) {
            focusMatch(nextMatch);
            currentMatchIndexRef.current = (currentMatchIndexRef.current + 1) % matchingItemsRef.current.length;
          }
        }
      } catch (err) {
        console.debug('[useSearchHighlight] Selection change handler error', err);
      }
    }, debounceMs);
  }, [reactFlowInstance, setNodes, debounceMs, findMatchingItems, focusMatch]);

  // Handle keyboard shortcuts for cycling through matches
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
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
      if (isFindNext) {
        currentMatchIndexRef.current = (currentMatchIndexRef.current + 1) % matchingItemsRef.current.length;
      } else if (isFindPrev) {
        currentMatchIndexRef.current = currentMatchIndexRef.current === 0 
          ? matchingItemsRef.current.length - 1 
          : currentMatchIndexRef.current - 1;
      }
      
      const match = matchingItemsRef.current[currentMatchIndexRef.current];
      if (match) {
        e.preventDefault(); // Prevent default browser find behavior
        focusMatch(match);
      }
    }
  }, [focusMatch]);

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
