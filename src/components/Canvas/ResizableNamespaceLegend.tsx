/**
 * ResizableNamespaceLegend
 *
 * Thin UI wrapper over RDFManagerImpl namespace methods.
 * All state mutations go through the impl; this component is display-only.
 * Colors are derived on demand from buildPaletteMap — never stored.
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import NamespaceLegendCore from "./NamespaceLegendCore";
import { useOntologyStore } from "@/stores/ontologyStore";
import { GripVertical } from "lucide-react";
import { Input } from "../ui/input";
import { buildPaletteMap } from "./core/namespacePalette";

interface ResizableNamespaceLegendProps {
  onClose?: () => void;
}

export const ResizableNamespaceLegend = ({ onClose: _onClose }: ResizableNamespaceLegendProps) => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const namespaceRegistry = useOntologyStore((s) =>
    Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : [],
  );

  const palette = useMemo(
    () => buildPaletteMap(namespaceRegistry.map((e) => e.prefix)),
    [namespaceRegistry],
  );

  const entries = useMemo(
    () =>
      namespaceRegistry
        .map((e: any) => [String(e.prefix ?? ""), String(e.uri ?? e.namespace ?? "")] as [string, string])
        .sort(([a], [b]) => a.localeCompare(b)),
    [namespaceRegistry],
  );

  const calculateInitialWidth = () => Math.min(420, window.innerWidth * 0.32);
  const [position, setPosition] = useState(() => ({
    x: Math.max(16, window.innerWidth - calculateInitialWidth() - 16),
    y: 80,
  }));
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const [showAdd, setShowAdd] = useState(false);
  const [newPrefix, setNewPrefix] = useState("");
  const [newUri, setNewUri] = useState("");
  const [addError, setAddError] = useState("");

  const [editingEntry, setEditingEntry] = useState<{ prefix: string; uri: string } | null>(null);
  const [editPrefix, setEditPrefix] = useState("");
  const [editUri, setEditUri] = useState("");
  const [editError, setEditError] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (el) {
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    }
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handlePointerMove = (e: PointerEvent) => {
      if (isDragging) setPosition({ x: Math.max(0, e.clientX - dragStart.x), y: Math.max(0, e.clientY - dragStart.y) });
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (el) {
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      }
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

  const setNamespaceRegistry = useOntologyStore((s) => s.setNamespaceRegistry);

  const handleRemoveNamespace = useCallback(
    (prefix: string) => {
      const remaining = namespaceRegistry.filter((e: any) => e.prefix !== prefix);
      setNamespaceRegistry(remaining);
      if (rdfManager) {
        const nsMap: Record<string, string> = {};
        for (const e of remaining) {
          const uri = (e as any).uri ?? (e as any).namespace ?? "";
          if (uri) nsMap[e.prefix] = uri;
        }
        if (typeof (rdfManager as any).setNamespaces === "function") {
          (rdfManager as any).setNamespaces(nsMap, { replace: true });
        }
        if (typeof (rdfManager as any).emitAllSubjects === "function") {
          (rdfManager as any).emitAllSubjects();
        }
      }
    },
    [rdfManager, namespaceRegistry, setNamespaceRegistry],
  );

  const handleEditStart = useCallback((prefix: string, uri: string) => {
    setEditingEntry({ prefix, uri });
    setEditPrefix(prefix);
    setEditUri(uri);
    setEditError("");
  }, []);

  const handleEditSave = useCallback(async () => {
    try {
      setEditError("");
      if (!editingEntry) return;
      const nextPrefix = editPrefix.trim();
      const nextUri = editUri.trim();

      const prefixValid = nextPrefix === "" || /^[A-Za-z][\w-]*$/.test(nextPrefix);
      const uriValid = /^https?:\/\/\S+/.test(nextUri);
      if (!prefixValid) {
        setEditError("Invalid prefix (letters, digits, underscore, hyphen; must start with letter)");
        return;
      }
      if (!uriValid) {
        setEditError("Namespace must be an absolute http(s) URI");
        return;
      }

      const prefixConflict =
        nextPrefix !== editingEntry.prefix &&
        namespaceRegistry.some((e) => e.prefix === nextPrefix);
      if (prefixConflict) {
        setEditError(`Prefix "${nextPrefix}" is already in use.`);
        return;
      }

      const uriChanged = nextUri !== editingEntry.uri;
      const prefixChanged = nextPrefix !== editingEntry.prefix;

      if (!uriChanged && !prefixChanged) {
        setEditingEntry(null);
        setEditPrefix("");
        setEditUri("");
        setEditError("");
        return;
      }

      if (uriChanged && rdfManager) {
        try {
          await rdfManager.renameNamespaceUri(editingEntry.uri, nextUri);
        } catch (err) {
          setEditError("IRI rename failed. Check the console for details.");
          console.error("[ResizableNamespaceLegend] renameNamespaceUri failed", err);
          return;
        }
      }

      if (prefixChanged && rdfManager) {
        rdfManager.removeNamespace(editingEntry.prefix);
      }

      if (rdfManager) {
        rdfManager.addNamespace(nextPrefix, nextUri);
      }

      setEditingEntry(null);
      setEditPrefix("");
      setEditUri("");
      setEditError("");
    } catch (err) {
      setEditError("Failed to save namespace edit");
    }
  }, [editingEntry, editPrefix, editUri, namespaceRegistry, rdfManager]);

  const handleAddSave = useCallback(() => {
    try {
      setAddError("");
      const p = String(newPrefix || "").trim();
      const u = String(newUri || "").trim();
      const prefixValid = /^[A-Za-z][\w-]*$/.test(p);
      const uriValid = /^https?:\/\/\S+/.test(u);
      if (!prefixValid) {
        setAddError("Invalid prefix (letters, digits, underscore, hyphen; must start with letter)");
        return;
      }
      if (!uriValid) {
        setAddError("Namespace must be an absolute http(s) URI");
        return;
      }

      const existing = namespaceRegistry.find((e) => e.prefix === p);
      if (existing) {
        const msg =
          existing.uri === u
            ? `Namespace "${p}" already points to "${u}". Replace it anyway?`
            : `Namespace "${p}" is currently "${existing.uri}". Replace with "${u}"?`;
        const confirmFn = typeof globalThis !== "undefined" && typeof (globalThis as any).confirm === "function"
          ? (globalThis as any).confirm.bind(globalThis)
          : null;
        if (confirmFn && !confirmFn(msg)) return;
      }

      if (rdfManager) {
        rdfManager.addNamespace(p, u);
      }

      setShowAdd(false);
      setNewPrefix("");
      setNewUri("");
      setAddError("");
    } catch (e) {
      setAddError("Failed to add namespace");
    }
  }, [newPrefix, newUri, namespaceRegistry, rdfManager]);

  return (
    <div
      ref={containerRef}
      className={`absolute bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg select-none min-w-[240px] max-w-[420px] w-[min(32vw,420px)] ${showAdd || !!editingEntry ? "min-h-[240px]" : "min-h-[140px]"} max-h-[60vh] z-50`}
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
                <button type="button" className="text-sm px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white" onClick={handleAddSave}>
                  Save
                </button>
                <button
                  type="button"
                  className="text-sm px-3 py-1 rounded border hover:bg-muted"
                  onClick={() => { setShowAdd(false); setNewPrefix(""); setNewUri(""); setAddError(""); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {addError && <div className="px-3 py-2 text-sm text-red-600">{addError}</div>}

      <div
        className="p-3 overflow-auto min-w-0"
        style={{ maxHeight: "calc(60vh - 10rem)" }}
      >
        {editingEntry ? (
          <div className="mb-3 border rounded p-2 bg-muted/30">
            <div className="flex flex-col gap-2">
              <Input
                aria-label="edit-prefix"
                placeholder="prefix"
                className="w-full text-sm min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground"
                value={editPrefix}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditPrefix(String(e.target.value))}
              />
              <Input
                aria-label="edit-namespace-uri"
                placeholder="https://example.org/"
                className="w-full text-sm min-w-0 bg-transparent text-foreground placeholder:text-muted-foreground"
                value={editUri}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditUri(String(e.target.value))}
              />
              {editError && <div className="text-sm text-red-600">{editError}</div>}
              <div className="flex gap-2">
                <button type="button" className="text-sm px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white" onClick={() => { handleEditSave().catch(() => {}); }}>
                  Save
                </button>
                <button
                  type="button"
                  className="text-sm px-3 py-1 rounded border hover:bg-muted"
                  onClick={() => { setEditingEntry(null); setEditPrefix(""); setEditUri(""); setEditError(""); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {entries.length > 0 ? (
          <NamespaceLegendCore
            entries={entries}
            palette={palette}
            onRemoveEntry={(prefix, _uri) => handleRemoveNamespace(prefix)}
            onEditEntry={handleEditStart}
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
