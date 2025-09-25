/**
 * Resizable and draggable namespace legend component (simplified)
 *
 * This version displays exactly the registered prefix -> namespace mappings
 * as provided by the RDF manager (or the optional `namespaces` prop). It
 * intentionally avoids additional filtering, heuristics, or normalization.
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Badge } from "../ui/badge";
import NamespaceLegendCore from "./NamespaceLegendCore";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical, X } from "lucide-react";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface ResizableNamespaceLegendProps {
  namespaces?: Record<string, string>;
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ namespaces, onClose }: ResizableNamespaceLegendProps) => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  // Persisted registry is the single source of truth for legend entries and colors.
  const namespaceRegistry = useOntologyStore((s) => (Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []));
  // Build palette map directly from persisted registry (store-only).
  const palette = (() => {
    try {
      const m: Record<string, string> = {};
      (namespaceRegistry || []).forEach((entry: any) => {
        try {
          const p = String(entry?.prefix || "");
          const c = String(entry?.color || "");
          if (p) m[p] = c || "";
        } catch (_) {}
      });
      return m;
    } catch (_) {
      return {};
    }
  })();

  // Derive the map we display: prefer explicit prop, otherwise use persisted registry (store-only).
  const displayNamespaces = useMemo(() => {
    try {
      if (namespaces && Object.keys(namespaces).length > 0) return namespaces;
      // Build a mapping from the persisted namespaceRegistry array.
      const map: Record<string, string> = {};
      (namespaceRegistry || []).forEach((e: any) => {
        try {
          const p = String(e?.prefix || "");
          const u = String(e?.namespace || "");
          if (p) map[p] = u;
        } catch (_) { /* ignore per-entry */ }
      });
      return map;
    } catch (_) {
      return namespaces || {};
    }
  }, [namespaces, namespaceRegistry, ontologiesVersion]);

  // Simple entries array reflecting the registered map exactly, sorted by prefix for stable order.
  const entries = useMemo(() => {
    return Object.entries(displayNamespaces)
      .map(([p, u]) => [String(p ?? ""), String(u ?? "")] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [displayNamespaces, ontologiesVersion, palette]);

  // Build palette map so legend colors match canvas palette (if available).

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

  // Local UI state for "Add namespace" flow
  const [showAdd, setShowAdd] = useState(false);
  const [newPrefix, setNewPrefix] = useState("");
  const [newUri, setNewUri] = useState("");
  const [error, setError] = useState("");
  // tick to force small re-renders when needed after adding a namespace
  const [tick, setTick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsScroll, setNeedsScroll] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      const { scrollHeight, clientHeight } = contentRef.current;
      setNeedsScroll(scrollHeight > clientHeight);
    }
  }, [entries, size]);

  const handlePointerDown = (e: React.PointerEvent, type: "drag" | "resize") => {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (_) { /* ignore */ }

    // Try to capture the pointer on the container so we continue receiving pointer events
    // even when the pointer leaves the visible element. This avoids using document-level
    // listeners which can interfere with React Flow pointer handling.
    try {
      const el = containerRef.current as any;
      if (el && typeof el.setPointerCapture === "function") {
        try { el.setPointerCapture((e as any).pointerId); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }

    if (type === "drag") {
      setIsDragging(true);
      setDragStart({ x: (e as any).clientX - position.x, y: (e as any).clientY - position.y });
    } else {
      setIsResizing(true);
      setResizeStart({ x: (e as any).clientX, y: (e as any).clientY, width: size.width, height: size.height });
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handlePointerMove = (e: PointerEvent) => {
      try {
        if (isDragging) {
          setPosition({ x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) });
        } else if (isResizing) {
          const newWidth = Math.max(200, resizeStart.width + (e.clientX - resizeStart.x));
          const newHeight = Math.max(150, resizeStart.height + (e.clientY - resizeStart.y));
          setSize({ width: newWidth, height: newHeight });
        }
      } catch (_) { /* ignore per-event errors */ }
    };

    const handlePointerUp = (e: PointerEvent) => {
      try {
        // release pointer capture if supported
        try {
          if (el && typeof (el as any).releasePointerCapture === "function") {
            try { (el as any).releasePointerCapture((e as any).pointerId); } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
      } catch (_) { /* ignore */ }
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      try {
        el.addEventListener("pointermove", handlePointerMove);
        el.addEventListener("pointerup", handlePointerUp);
        el.addEventListener("pointercancel", handlePointerUp);
      } catch (_) { /* ignore attach errors */ }
    }

    return () => {
      try {
        el.removeEventListener("pointermove", handlePointerMove);
        el.removeEventListener("pointerup", handlePointerUp);
        el.removeEventListener("pointercancel", handlePointerUp);
      } catch (_) { /* ignore detach errors */ }
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
        onPointerDown={(e) => handlePointerDown(e, "drag")}
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

      {/* Add-namespace UI (tailwind-styled controls) */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-sm px-2 py-1 rounded border bg-transparent hover:bg-muted"
            onClick={() => setShowAdd(true)}
          >
            Add namespace
          </button>
        </div>

        {showAdd && (
          <div className="ml-auto w-full max-w-full">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
            <Input
              aria-label="prefix"
              placeholder="prefix"
              className="w-full sm:w-24 text-sm min-w-0 flex-none bg-transparent !bg-transparent text-foreground !text-foreground placeholder:text-muted-foreground !placeholder:text-muted-foreground"
              value={newPrefix}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPrefix(String(e.target.value))}
            />
            <Input
              aria-label="namespace-uri"
              placeholder="https://example.org/"
              className="w-full sm:flex-1 text-sm min-w-0 bg-transparent !bg-transparent text-foreground !text-foreground placeholder:text-muted-foreground !placeholder:text-muted-foreground"
              value={newUri}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewUri(String(e.target.value))}
            />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-sm px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => {
                    try {
                      setError("");
                      const p = String(newPrefix || "").trim();
                      const u = String(newUri || "").trim();
                      const prefixValid = /^[A-Za-z][\w-]*$/.test(p);
                      const uriValid = /^https?:\/\/\S+/.test(u);
                      if (!prefixValid) {
                        setError("Invalid prefix (letters, digits, underscore, hyphen; must start with letter)");
                        return;
                      }
                      if (!uriValid) {
                        setError("Namespace must be an absolute http(s) URI");
                        return;
                      }
                      // Avoid duplicates
                      const ns = rdfManager && typeof rdfManager.getNamespaces === "function" ? rdfManager.getNamespaces() : {};
                      if (ns && Object.prototype.hasOwnProperty.call(ns, p)) {
                        setError("Prefix already registered");
                        return;
                      }
                      try {
                        // addNamespace will handle toast notification and idempotency
                        rdfManager && typeof rdfManager.addNamespace === "function" && rdfManager.addNamespace(p, u);
                      } catch (_) {
                        // ignore
                      }
                      // Force local refresh
                      setShowAdd(false);
                      setNewPrefix("");
                      setNewUri("");
                      setError("");
                      setTick((t) => t + 1);
                    } catch (e) {
                      setError("Failed to add namespace");
                    }
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="text-sm px-3 py-1 rounded border hover:bg-muted"
                  onClick={() => {
                    setShowAdd(false);
                    setNewPrefix("");
                    setNewUri("");
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {error && (
        <div className="px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <div
        ref={contentRef}
        className={`p-3 overflow-y-auto ${needsScroll ? "scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent" : ""}`}
        style={{ height: size.height - 60, overflowY: needsScroll ? "auto" : "hidden" }}
      >
        <NamespaceLegendCore entries={entries} palette={palette} />
      </div>

      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize bg-muted/50 rounded-tl-lg border-l border-t border-border/50"
        onPointerDown={(e) => handlePointerDown(e, "resize")}
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
