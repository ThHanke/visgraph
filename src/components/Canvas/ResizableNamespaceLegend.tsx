/**
 * Resizable and draggable namespace legend component (simplified)
 *
 * This version displays exactly the registered prefix -> namespace mappings
 * as provided by the RDF manager (or the optional `namespaces` prop). It
 * intentionally avoids additional filtering, heuristics, or normalization.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical, X } from "lucide-react";
import { buildPaletteMap } from "./core/namespacePalette";

interface ResizableNamespaceLegendProps {
  namespaces?: Record<string, string>;
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ namespaces, onClose }: ResizableNamespaceLegendProps) => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);

  // Derive the map we display: prefer explicit prop, otherwise ask the rdfManager.
  const displayNamespaces = useMemo(() => {
    try {
      if (namespaces && Object.keys(namespaces).length > 0) return namespaces;
      if (rdfManager && typeof rdfManager.getNamespaces === "function") return rdfManager.getNamespaces();
      return {};
    } catch (_) {
      return namespaces || {};
    }
  }, [namespaces, rdfManager, ontologiesVersion]);

  // Simple entries array reflecting the registered map exactly, sorted by prefix for stable order.
  const entries = useMemo(() => {
    return Object.entries(displayNamespaces)
      .map(([p, u]) => [String(p ?? ""), String(u ?? "")] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [displayNamespaces, ontologiesVersion]);

  // Build palette map so legend colors match canvas palette (if available).
  const paletteMap = useMemo(() => {
    try {
      const prefixes = Object.keys(displayNamespaces).filter(Boolean).sort();
      const textColors = [
        getComputedStyle(document.documentElement).getPropertyValue("--node-foreground") || "#000000",
        getComputedStyle(document.documentElement).getPropertyValue("--primary-foreground") || "#000000",
      ];
      return buildPaletteMap(prefixes, { avoidColors: textColors });
    } catch (_) {
      return {};
    }
  }, [displayNamespaces]);

  // Basic sizing/position state (kept minimal)
  const calculateInitialSize = () => {
    const maxWidth = Math.min(420, window.innerWidth * 0.32);
    const maxHeight = Math.min(520, window.innerHeight * 0.6);
    const minWidth = 240;
    const minHeight = 140;
    const estimatedHeight = Math.min(maxHeight, Math.max(minHeight, entries.length * 30 + 80));
    return { width: maxWidth, height: estimatedHeight };
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

  useEffect(() => {
    if (contentRef.current) {
      const { scrollHeight, clientHeight } = contentRef.current;
      setNeedsScroll(scrollHeight > clientHeight);
    }
  }, [entries, size]);

  const handleMouseDown = (e: React.MouseEvent, type: "drag" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    if (type === "drag") {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    } else {
      setIsResizing(true);
      setResizeStart({ x: e.clientX, y: e.clientY, width: size.width, height: size.height });
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPosition({ x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) });
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
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isResizing, dragStart, resizeStart]);

  if (!entries || entries.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg resize-none select-none"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height, zIndex: 50 }}
    >
      <div
        className="flex items-center justify-between p-3 border-b cursor-move bg-muted/50 rounded-t-lg"
        onMouseDown={(e) => handleMouseDown(e, "drag")}
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

      <div
        ref={contentRef}
        className={`p-3 overflow-y-auto ${needsScroll ? "scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" : ""}`}
        style={{ height: size.height - 60, overflowY: needsScroll ? "auto" : "hidden" }}
      >
        <div className="space-y-2">
          {entries.map(([prefix, uri], index) => (
            <div key={String(prefix) + index} className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 shrink-0">
                <div
                  className="w-3 h-3 rounded-full border border-border/50"
                  style={{ backgroundColor: paletteMap[String(prefix)] || paletteMap[String(prefix).replace(/[:#].*$/, "")] || "hsl(var(--primary))" }}
                />
                <Badge variant="outline" className="font-mono text-xs px-1.5 py-0.5">
                  {String(prefix) === "" ? ":" : String(prefix)}
                </Badge>
              </div>
              <span className="text-muted-foreground truncate flex-1 text-xs leading-relaxed" title={uri}>
                {uri}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize bg-muted/50 rounded-tl-lg border-l border-t border-border/50"
        onMouseDown={(e) => handleMouseDown(e, "resize")}
      >
        <div className="absolute bottom-1 right-1 w-2 h-2">
          <div className="absolute bottom-0 right-0 w-1 h-1 bg-muted-foreground/50 rounded-full"></div>
          <div className="absolute bottom-0.5 right-0.5 w-0.5 h-0.5 bg-muted-foreground/30 rounded-full"></div>
        </div>
      </div>
    </div>
  );
};

export default ResizableNamespaceLegend;
