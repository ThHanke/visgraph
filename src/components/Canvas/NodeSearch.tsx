/**
 * NodeSearch component
 * 
 * Search component for React Flow that searches ALL nodes (including off-screen)
 * by examining node data directly. Works with RDF node properties.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useReactFlow, useNodes } from '@xyflow/react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { Node } from '@xyflow/react';

interface NodeSearchProps {
  className?: string;
  placeholder?: string;
}

export function NodeSearch({ 
  className,
  placeholder = "Search nodes..." 
}: NodeSearchProps) {
  const [searchText, setSearchText] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { fitView, setNodes, setCenter } = useReactFlow();
  const nodes = useNodes();

  // Extract searchable text from node data
  const getSearchableText = useCallback((node: Node): string => {
    try {
      const data = node.data as any;
      const parts: string[] = [];
      
      // Collect all text fields from RDF node data
      if (data.displayPrefixed) parts.push(String(data.displayPrefixed));
      if (data.displayShort) parts.push(String(data.displayShort));
      if (data.label) parts.push(String(data.label));
      if (data.subtitle) parts.push(String(data.subtitle));
      if (data.humanLabel) parts.push(String(data.humanLabel));
      if (data.classType) parts.push(String(data.classType));
      if (data.displayclassType) parts.push(String(data.displayclassType));
      if (data.iri) parts.push(String(data.iri));
      
      // Add properties
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

  // Find all matching nodes
  const matchingNodes = useMemo(() => {
    if (!searchText || searchText.length < 2) return [];
    
    const lowerSearch = searchText.toLowerCase();
    return nodes.filter((node) => {
      const nodeText = getSearchableText(node);
      return nodeText.includes(lowerSearch);
    });
  }, [nodes, searchText, getSearchableText]);

  const matchCount = matchingNodes.length;
  const hasMatches = matchCount > 0;

  // Focus on a specific node
  const focusNode = useCallback((nodeId: string) => {
    try {
      // Find the node in the full nodes array (includes unrendered nodes)
      const node = nodes.find(n => String(n.id) === nodeId);
      if (!node) {
        console.warn('[NodeSearch] Node not found:', nodeId);
        return;
      }
      
      console.log('[NodeSearch] Focusing on node:', {
        id: nodeId,
        position: node.position,
        hasSetCenter: typeof setCenter === 'function'
      });
      
      // Select the node
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: String(n.id) === nodeId,
        }))
      );
      
      // Move viewport to center on the node's position
      if (node.position && typeof setCenter === 'function') {
        console.log('[NodeSearch] Calling setCenter with:', node.position);
        try {
          setCenter(node.position.x, node.position.y, {
            zoom: 1.2,
            duration: 400,
          });
          console.log('[NodeSearch] setCenter called successfully');
        } catch (centerErr) {
          console.error('[NodeSearch] setCenter failed:', centerErr);
          // Fallback to fitView
          fitView({
            padding: 0.3,
            duration: 300,
            nodes: [node],
            maxZoom: 1.5,
          });
        }
      } else {
        console.log('[NodeSearch] Using fitView fallback');
        // Fallback to fitView for rendered nodes
        fitView({
          padding: 0.3,
          duration: 300,
          nodes: [node],
          maxZoom: 1.5,
        });
      }
    } catch (err) {
      console.error('[NodeSearch] focusNode failed:', err);
    }
  }, [nodes, setNodes, setCenter, fitView]);

  // Navigate to next match
  const handleNext = useCallback(() => {
    if (matchCount === 0) return;
    
    const nextIndex = (currentMatchIndex + 1) % matchCount;
    setCurrentMatchIndex(nextIndex);
    
    const nodeId = String(matchingNodes[nextIndex].id);
    focusNode(nodeId);
  }, [currentMatchIndex, matchCount, matchingNodes, focusNode]);

  // Navigate to previous match
  const handlePrevious = useCallback(() => {
    if (matchCount === 0) return;
    
    const prevIndex = currentMatchIndex === 0 
      ? matchCount - 1 
      : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIndex);
    
    const nodeId = String(matchingNodes[prevIndex].id);
    focusNode(nodeId);
  }, [currentMatchIndex, matchCount, matchingNodes, focusNode]);

  // Handle search input change
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    setCurrentMatchIndex(0);
    
    // If we have matches, focus on the first one
    if (value.length >= 2) {
      // Compute matches directly to avoid stale closure
      const lowerSearch = value.toLowerCase();
      const matches = nodes.filter((node) => {
        const nodeText = getSearchableText(node);
        return nodeText.includes(lowerSearch);
      });
      
      if (matches.length > 0) {
        // Use setTimeout to ensure state updates have processed
        setTimeout(() => {
          focusNode(String(matches[0].id));
        }, 10);
      }
    }
  }, [nodes, getSearchableText, focusNode]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    } else if (e.key === 'Escape') {
      setSearchText('');
      setCurrentMatchIndex(0);
      inputRef.current?.blur();
    }
  }, [handleNext, handlePrevious]);

  // Reset when nodes change significantly
  useEffect(() => {
    if (matchCount > 0 && currentMatchIndex >= matchCount) {
      setCurrentMatchIndex(0);
    }
  }, [matchCount, currentMatchIndex]);

  const displayIndex = hasMatches ? currentMatchIndex + 1 : 0;

  return (
    <div className={cn(
      "flex items-center gap-2 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[320px]",
      className
    )}>
      {/* Search Icon */}
      <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      
      {/* Search Input */}
      <input
        ref={inputRef}
        type="text"
        value={searchText}
        onChange={handleSearchChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "flex-1 bg-transparent border-none outline-none text-sm",
          "placeholder:text-muted-foreground"
        )}
      />
      
      {/* Match Counter */}
      {searchText && (
        <div className={cn(
          "text-xs font-medium px-2 py-1 rounded whitespace-nowrap",
          hasMatches ? "text-foreground bg-muted" : "text-muted-foreground"
        )}>
          {hasMatches ? `${displayIndex}/${matchCount}` : 'No matches'}
        </div>
      )}
      
      {/* Navigation Buttons */}
      {hasMatches && (
        <>
          <button
            onClick={handlePrevious}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="Previous match (Shift+Enter)"
            type="button"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            onClick={handleNext}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="Next match (Enter)"
            type="button"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </>
      )}
      
      {/* Clear Button */}
      {searchText && (
        <button
          onClick={() => {
            setSearchText('');
            setCurrentMatchIndex(0);
            inputRef.current?.focus();
          }}
          className="p-1 hover:bg-muted rounded transition-colors"
          title="Clear search (Esc)"
          type="button"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
