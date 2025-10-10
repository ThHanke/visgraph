/**
 * ResizableNamespaceLegend (simplified)
 *
 * This version removes the custom JS resize logic and relies on Tailwind/CSS
 * for sizing constraints and internal scrolling. Drag-to-reposition is kept.
 *
 * Goals:
 * - Remove size state and resize handlers (prevent inner overflow from breaking layout)
 * - Keep header drag behavior so users can reposition the legend
 * - Use Tailwind classes for min/max widths and heights (viewport-relative)
 * - Ensure the content area is overflow-auto so long lists scroll instead of overflowing
 */

import React, { useState, useRef, useEffect, useMemo } from "react";
import NamespaceLegendCore from "./NamespaceLegendCore";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical } from "lucide-react";
import { Input } from "../ui/input";
import { buildPaletteMap } from "./core/namespacePalette";

interface ResizableNamespaceLegendProps {
  namespaces?: Record<string, string>;
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ namespaces, onClose }: ResizableNamespaceLegendProps) => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  const namespaceRegistry = useOntologyStore((s) => (Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []));
  const setNamespaceRegistry = useOntologyStore((s) => s.setNamespaceRegistry);

  // Build palette map directly from persisted registry (store-only).
  const palette = (() => {
    try {
      const m: Record<string, string> = {};
      (namespaceRegistry || []).forEach((entry: any) => {
        try {
          const p = entry && (entry.prefix !== undefined && entry.prefix !== null) ? String(entry.prefix) : "";
          const c = entry && (entry.color !== undefined && entry.color !== null) ? String(entry.color) : "";
          if (p) m[p] = c || "";
        } catch (_) {
          /* ignore per-entry */
        }
      });
      return m;
    } catch (_) {
      return {};
    }
  })();

  const displayNamespaces = useMemo(() => {
    try {
      if (namespaces && Object.keys(namespaces).length > 0) return namespaces;

      const mapFromRegistry: Record<string, string> = {};
      try {
        (namespaceRegistry || []).forEach((e: any) => {
          try {
            const p = e && (e.prefix !== undefined && e.prefix !== null) ? String(e.prefix) : "";
            const u = e && (e.namespace !== undefined && e.namespace !== null) ? String(e.namespace) : "";
            if (p) mapFromRegistry[p] = u;
          } catch (_) { /* ignore per-entry */ }
        });
      } catch (_) { /* ignore registry read errors */ }

      return mapFromRegistry;
    } catch (_) {
      return namespaces || {};
    }
  }, [namespaces, namespaceRegistry, ontologiesVersion]);

  const entries = useMemo(() => {
    return Object.entries(displayNamespaces)
      .map(([p, u]) => [String(p ?? ""), String(u ?? "")] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [displayNamespaces, ontologiesVersion, palette]);

  // Compute a reasonable default width based on viewport (used to position the legend initially).
  const calculateInitialWidth = () => {
    return Math.min(420, window.innerWidth * 0.32);
  };

  // Keep only position and drag state (no JS resize)
  const [position, setPosition] = useState(() => ({ x: Math.max(16, window.innerWidth - calculateInitialWidth() - 16), y: 16 }));
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Local UI state for "Add namespace" flow
  const [showAdd, setShowAdd] = useState(false);
  const [newPrefix, setNewPrefix] = useState("");
  const [newUri, setNewUri] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const el = containerRef.current as any;
    if (el && typeof el.setPointerCapture === "function") {
      try {
        el.setPointerCapture((e as any).pointerId);
      } catch (_) { /* ignore */ }
    }

    setIsDragging(true);
    setDragStart({ x: (e as any).clientX - position.x, y: (e as any).clientY - position.y });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) {
        setPosition({ x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) });
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      try {
        if (el && typeof (el as any).releasePointerCapture === "function") {
          try { (el as any).releasePointerCapture((e as any).pointerId); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      setIsDragging(false);
    };

    if (isDragging) {
      el.addEventListener("pointermove", handlePointerMove);
      el.addEventListener("pointerup", handlePointerUp);
      el.addEventListener("pointercancel", handlePointerUp);
    }

    return () => {
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerUp);
      el.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isDragging, dragStart]);

  if (!entries || entries.length === 0) return null;

  return (
    <div
      ref={containerRef}
      // Keep left/top inline so drag updates position, but let Tailwind control sizing.
      // When the add form is open increase min-height so the stacked inputs are visible.
      className={`absolute bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg select-none min-w-[240px] max-w-[420px] w-[min(32vw,420px)] ${showAdd ? "min-h-[240px]" : "min-h-[140px]"} max-h-[60vh] z-50`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="flex items-center justify-between p-3 border-b cursor-move bg-muted/50 rounded-t-lg"
        onPointerDown={handlePointerDown}
      >
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-foreground" />
          <h3 className="text-foreground text-sm font-semibold">Namespace Legend</h3>
        </div>
      </div>

      {/* Add-namespace UI */}
      <div className="px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-foreground text-sm px-2 py-1 rounded border bg-transparent hover:bg-muted"
            onClick={() => setShowAdd((s) => !s)}
          >
            Add namespace
          </button>
        </div>

        {showAdd && (
          <div className="mt-2 w-full">
            <div className="flex flex-col gap-2 w-full">
              <Input
                aria-label="prefix"
                placeholder="prefix"
                className="w-full text-sm min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground"
                value={newPrefix}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPrefix(String(e.target.value))}
              />
              <Input
                aria-label="namespace-uri"
                placeholder="https://example.org/"
                className="w-full text-sm min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground break-words"
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
                      const currentNsMap: Record<string, string> = {};
                      try {
                        (namespaceRegistry || []).forEach((entry: any) => {
                          try {
                            const key = entry && (entry.prefix !== undefined && entry.prefix !== null) ? String(entry.prefix) : "";
                            const uri = entry && (entry.namespace !== undefined && entry.namespace !== null) ? String(entry.namespace) : "";
                            if (key) currentNsMap[key] = uri;
                          } catch (_) { /* ignore per-entry */ }
                        });
                      } catch (_) { /* ignore */ }
                      if (currentNsMap && Object.prototype.hasOwnProperty.call(currentNsMap, p)) {
                        setError("Prefix already registered");
                        return;
                      }
                      try {
                        if (rdfManager && typeof rdfManager.addNamespace === "function") {
                          try { rdfManager.addNamespace(p, u); } catch (_) { /* ignore */ }
                        }
                      } catch (_) { /* ignore */ }

                      // Update the persisted namespace registry in the store so the legend refreshes immediately.
                      try {
                        const mgr = rdfManager;
                        const nsMap = mgr && typeof (mgr as any).getNamespaces === "function" ? (mgr as any).getNamespaces() : {};
                        const prefixes = Object.keys(nsMap || []).sort();
                        const paletteMap = buildPaletteMap(prefixes || []);
                        const registry = (prefixes || []).map((pr) => {
                          try {
                            return { prefix: String(pr), namespace: String((nsMap as any)[pr] || ""), color: String((paletteMap as any)[pr] || "") };
                          } catch (_) {
                            return { prefix: String(pr), namespace: String((nsMap as any)[pr] || ""), color: "" };
                          }
                        });
                        try {
                          if (typeof setNamespaceRegistry === "function") setNamespaceRegistry(registry);
                          else if ((useOntologyStore as any).setState && typeof (useOntologyStore as any).setState === "function") {
                            try { (useOntologyStore as any).setState((s:any) => ({ namespaceRegistry: registry })); } catch (_) { /* ignore */ }
                          }
                        } catch (_) { /* ignore */ }
                      } catch (_) { /* ignore */ }

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
        className="p-3 overflow-auto min-w-0"
        // make the content scrollable and bounded by the container's max-height.
        // Use a slightly larger subtraction to account for header + add-form heights when open.
        style={{ maxHeight: "calc(60vh - 10rem)" }}
      >
        <NamespaceLegendCore entries={entries} palette={palette} />
      </div>
    </div>
  );
};

export default ResizableNamespaceLegend;
