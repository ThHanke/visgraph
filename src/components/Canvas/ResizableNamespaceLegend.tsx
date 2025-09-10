/**
 * @fileoverview Resizable and draggable namespace legend component
 * Provides an interactive legend showing namespace prefixes with color coding
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical, X } from 'lucide-react';
import { buildPaletteMap } from './core/namespacePalette';

interface ResizableNamespaceLegendProps {
  namespaces?: Record<string, string>;
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ namespaces, onClose }: ResizableNamespaceLegendProps) => {
  const { rdfManager } = useOntologyStore();
  
  // Calculate initial size based on content
  const calculateInitialSize = () => {
    const maxWidth = Math.min(400, window.innerWidth * 0.3);
    const maxHeight = Math.min(500, window.innerHeight * 0.6);
    const minWidth = 250;
    const minHeight = 150;
    
    // Estimate content height (approx 24px per namespace + header + padding)
    const namespaceCount = Object.keys(namespaces || rdfManager.getNamespaces()).length;
    const estimatedHeight = Math.min(maxHeight, Math.max(minHeight, namespaceCount * 28 + 80));
    
    return {
      width: maxWidth,
      height: estimatedHeight
    };
  };
  
  const [position, setPosition] = useState({ x: Math.max(16, window.innerWidth - calculateInitialSize().width - 16), y: 16 });
  const [size, setSize] = useState(calculateInitialSize());
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsScroll, setNeedsScroll] = useState(false);
  
  // Use namespaces from RDF manager if not provided
  const displayNamespaces = namespaces || rdfManager.getNamespaces();
  
  // Filter out empty or undefined prefixes and ensure we have meaningful namespaces
  const filteredNamespaces = Object.entries(displayNamespaces)
    .filter(([prefix, uri]) => prefix && uri && prefix !== '' && uri !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  // Build a shared palette map so legend and canvas use identical colors
  const paletteMap = useMemo(() => {
    try {
      const nsMap = displayNamespaces || {};
      const prefixes = Object.keys(nsMap).filter(Boolean).sort();
      const textColors = [
        getComputedStyle(document.documentElement).getPropertyValue('--node-foreground') || '#000000',
        getComputedStyle(document.documentElement).getPropertyValue('--primary-foreground') || '#000000'
      ];
      return buildPaletteMap(prefixes, { avoidColors: textColors });
    } catch (e) {
      return {};
    }
  }, [displayNamespaces]);

  // Check if content needs scrolling
  useEffect(() => {
    if (contentRef.current) {
      const { scrollHeight, clientHeight } = contentRef.current;
      setNeedsScroll(scrollHeight > clientHeight);
    }
  }, [filteredNamespaces, size]);

  const handleMouseDown = (e: React.MouseEvent, type: 'drag' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    
    if (type === 'drag') {
      setIsDragging(true);
      setDragStart({
        x: e.clientX - position.x,
        y: e.clientY - position.y
      });
    } else {
      setIsResizing(true);
      setResizeStart({
        x: e.clientX,
        y: e.clientY,
        width: size.width,
        height: size.height
      });
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPosition({
          x: Math.max(0, e.clientX - dragStart.x),
          y: Math.max(0, e.clientY - dragStart.y)
        });
      } else if (isResizing) {
        const newWidth = Math.max(200, resizeStart.width + (e.clientX - resizeStart.x));
        const newHeight = Math.max(150, resizeStart.height + (e.clientY - resizeStart.y));
        setSize({ width: newWidth, height: newHeight });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, dragStart, resizeStart]);

  if (filteredNamespaces.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="absolute bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg resize-none select-none"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex: 50
      }}
    >
      {/* Header with drag handle and close button */}
      <div 
        className="flex items-center justify-between p-3 border-b cursor-move bg-muted/50 rounded-t-lg"
        onMouseDown={(e) => handleMouseDown(e, 'drag')}
      >
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Namespace Legend</h3>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded-sm hover:bg-muted transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Content area */}
      <div 
        ref={contentRef}
        className={`p-3 overflow-y-auto ${needsScroll ? 'scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent' : ''}`}
        style={{ 
          height: size.height - 60, // Subtract header height
          overflowY: needsScroll ? 'scroll' : 'hidden'
        }}
      >
        <div className="space-y-2">
          {filteredNamespaces.map(([prefix, uri], index) => (
            <div key={prefix} className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 shrink-0">
                <div 
                  className="w-3 h-3 rounded-full border border-border/50"
                  style={{ backgroundColor: paletteMap[prefix] || paletteMap[prefix.replace(/[:#].*$/, '')] || 'hsl(var(--primary))' }}
                />
                <Badge variant="outline" className="font-mono text-xs px-1.5 py-0.5">
                  {prefix}:
                </Badge>
              </div>
              <span 
                className="text-muted-foreground truncate flex-1 text-xs leading-relaxed" 
                title={uri}
              >
                {uri}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize bg-muted/50 rounded-tl-lg border-l border-t border-border/50"
        onMouseDown={(e) => handleMouseDown(e, 'resize')}
      >
        <div className="absolute bottom-1 right-1 w-2 h-2">
          <div className="absolute bottom-0 right-0 w-1 h-1 bg-muted-foreground/50 rounded-full"></div>
          <div className="absolute bottom-0.5 right-0.5 w-0.5 h-0.5 bg-muted-foreground/30 rounded-full"></div>
        </div>
      </div>
    </div>
  );
};
