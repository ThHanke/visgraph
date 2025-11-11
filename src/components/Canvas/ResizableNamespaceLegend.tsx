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

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import NamespaceLegendCore from "./NamespaceLegendCore";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical } from "lucide-react";
import { Input } from "../ui/input";
import { buildPaletteMap } from "./core/namespacePalette";
import { ensureDefaultNamespaceMap } from "@/constants/namespaces";

interface ResizableNamespaceLegendProps {
  namespaces?: Record<string, string>;
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ namespaces, onClose }: ResizableNamespaceLegendProps) => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  const namespaceRegistry = useOntologyStore((s) => (Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []));
  const setNamespaceRegistry = useOntologyStore((s) => s.setNamespaceRegistry);

  const registryEntries = Array.isArray(namespaceRegistry) ? namespaceRegistry : [];

  const commitRegistryUpdate = useCallback(
    (mutator: (draft: Map<string, { namespace: string; color: string }>) => void): Record<string, string> => {
      const draft = new Map<string, { namespace: string; color: string }>();
      try {
        for (const entry of registryEntries) {
          if (!entry || entry.prefix === undefined || entry.prefix === null) continue;
          const prefix = String(entry.prefix);
          const namespace = entry && entry.namespace !== undefined && entry.namespace !== null ? String(entry.namespace) : "";
          const color = entry && entry.color !== undefined && entry.color !== null ? String(entry.color) : "";
          draft.set(prefix, { namespace, color });
        }
      } catch (_) {
        /* ignore prepopulation errors */
      }

      mutator(draft);

      const prefixes = Array.from(draft.keys()).sort((a, b) => a.localeCompare(b));
      const paletteMap = buildPaletteMap(prefixes);
      const nextRegistry = prefixes.map((prefix) => {
        const info = draft.get(prefix)!;
        const preservedColor = typeof info.color === "string" ? info.color : "";
        const color =
          preservedColor && preservedColor.trim().length > 0
            ? preservedColor
            : String(paletteMap[prefix] ?? "");
        draft.set(prefix, { namespace: info.namespace, color });
        return {
          prefix,
          namespace: info.namespace,
          color,
        };
      });

      try {
        if (typeof setNamespaceRegistry === "function") {
          setNamespaceRegistry(nextRegistry);
        } else if ((useOntologyStore as any).setState && typeof (useOntologyStore as any).setState === "function") {
          (useOntologyStore as any).setState(() => ({ namespaceRegistry: nextRegistry }));
        }
      } catch (_) {
        /* ignore setter failures */
      }

      const nsMap: Record<string, string> = {};
      for (const prefix of prefixes) {
        const info = draft.get(prefix);
        if (!info) continue;
        nsMap[prefix] = info.namespace;
      }
      return ensureDefaultNamespaceMap(nsMap);
    },
    [registryEntries, setNamespaceRegistry],
  );

  const palette = useMemo(() => {
    const colorMap: Record<string, string> = {};
    try {
      for (const entry of registryEntries) {
        if (!entry || entry.prefix === undefined || entry.prefix === null) continue;
        const prefix = String(entry.prefix);
        const color = entry && entry.color !== undefined && entry.color !== null ? String(entry.color) : "";
        colorMap[prefix] = color || "";
      }
    } catch (_) {
      /* ignore palette derivation errors */
    }
    return colorMap;
  }, [registryEntries]);

  const displayNamespaces = useMemo(() => {
    try {
      if (namespaces && Object.keys(namespaces).length > 0) {
        return ensureDefaultNamespaceMap(namespaces);
      }

      const mapFromRegistry: Record<string, string> = {};
      try {
        (registryEntries || []).forEach((e: any) => {
          try {
            if (!e || e.prefix === undefined || e.prefix === null) return;
            const p = String(e.prefix);
            const u = e && (e.namespace !== undefined && e.namespace !== null) ? String(e.namespace) : "";
            mapFromRegistry[p] = u;
          } catch (_) { /* ignore per-entry */ }
        });
      } catch (_) { /* ignore registry read errors */ }

      return ensureDefaultNamespaceMap(mapFromRegistry);
    } catch (_) {
      return ensureDefaultNamespaceMap(namespaces || {});
    }
  }, [namespaces, registryEntries, ontologiesVersion]);

  const realEntries = useMemo(() => {
    return Object.entries(displayNamespaces)
      .map(([p, u]) => [String(p ?? ""), String(u ?? "")] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [displayNamespaces, ontologiesVersion]);

  const entries = realEntries;

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

  const handleRemoveNamespace = useCallback(
    (prefix: string, uri: string) => {
      const targetPrefix = String(prefix ?? "");
      const targetUri = String(uri ?? "");

      const nextMap = commitRegistryUpdate((draft) => {
        if (targetPrefix && draft.has(targetPrefix)) {
          draft.delete(targetPrefix);
          return;
        }
        if (targetUri) {
          for (const [key, info] of draft.entries()) {
            if (info.namespace === targetUri) {
              draft.delete(key);
            }
          }
        }
      });

      try {
        if (rdfManager && typeof rdfManager.setNamespaces === "function") {
          rdfManager.setNamespaces(nextMap, { replace: true });
        }
      } catch (_) {
        /* ignore namespace sync failures */
      }

      try {
        if (rdfManager && typeof (rdfManager as any).emitAllSubjects === "function") {
          const result = (rdfManager as any).emitAllSubjects();
          if (result && typeof result.catch === "function") {
            result.catch(() => {});
          }
        }
      } catch (_) {
        /* ignore emit failures */
      }
    },
    [commitRegistryUpdate, rdfManager],
  );

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
                      const existingUri = Object.prototype.hasOwnProperty.call(displayNamespaces, p)
                        ? String(displayNamespaces[p] ?? "")
                        : undefined;
                      if (existingUri !== undefined) {
                        const message =
                          existingUri === u
                            ? `Namespace "${p}" already points to "${u}". Replace it anyway?`
                            : `Namespace "${p}" is currently "${existingUri}". Replace with "${u}"?`;
                        const confirmFn =
                          typeof globalThis !== "undefined" &&
                          typeof (globalThis as any).confirm === "function"
                            ? (globalThis as any).confirm.bind(globalThis)
                            : null;
                        const shouldOverwrite = confirmFn ? confirmFn(message) : true;
                        if (!shouldOverwrite) {
                          return;
                        }
                      }
                      const nsMap = commitRegistryUpdate((draft) => {
                        draft.set(p, {
                          namespace: u,
                          color: draft.get(p)?.color ?? "",
                        });
                      });
                      try {
                        if (rdfManager && typeof rdfManager.addNamespace === "function") {
                          rdfManager.addNamespace(p, u);
                        }
                      } catch (_) { /* ignore */ }

                      try {
                        if (rdfManager && typeof rdfManager.setNamespaces === "function") {
                          rdfManager.setNamespaces(nsMap, { replace: true });
                        }
                      } catch (_) { /* ignore */ }

                      try {
                        if (rdfManager && typeof (rdfManager as any).emitAllSubjects === "function") {
                          const result = (rdfManager as any).emitAllSubjects();
                          if (result && typeof result.catch === "function") {
                            result.catch(() => {});
                          }
                        }
                      } catch (_) {
                        /* ignore emit failures */
                      }

                      setShowAdd(false);
                      setNewPrefix("");
                      setNewUri("");
                      setError("");
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
        {entries.length > 0 ? (
          <NamespaceLegendCore
            entries={entries}
            palette={palette}
            onRemoveEntry={handleRemoveNamespace}
          />
        ) : (
          <div className="text-xs text-muted-foreground">
            No namespaces yet. Use "Add namespace" above to register one.
          </div>
        )}
      </div>
    </div>
  );
};

export default ResizableNamespaceLegend;
