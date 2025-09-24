import React, { memo, useEffect, useRef, useState, useMemo } from "react";
import {
  Handle,
  Position,
  NodeProps,
  useConnection,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { cn } from "../../lib/utils";
import { Edit3, AlertTriangle, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useOntologyStore } from "../../stores/ontologyStore";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { getNamespaceColorFromPalette } from "./helpers/namespaceHelpers";
import { shortLocalName, toPrefixed, computeTermDisplay } from "../../utils/termUtils";
import { debug } from "../../utils/startupDebug";

/**
 * A tighter-typed node data payload that mirrors the shapes used across the canvas.
 */
interface CustomOntologyNodeData {
  iri?: string;
  classType?: string;
  individualName?: string;
  namespace?: string;
  displayType?: string;
  rdfTypes?: string[] | null;
  properties?: Record<string, unknown>;
  annotationProperties?: Array<{ property?: string; value?: unknown }>;
  errors?: string[];
  [key: string]: unknown;
}

const _loggedFingerprints = new Set<string>();

function CustomOntologyNodeInner(props: NodeProps) {
  const { data, selected, id } = props;
  // Use React Flow's built-in connection hook so the node can render conditional handles
  // and participate in native "connection in progress" state (shows "Drop here" targets etc).
  const connection = useConnection();
  const updateNodeInternals = useUpdateNodeInternals();
  // Ensure React Flow knows about conditional handles when connection state changes.
  // This mirrors the example note: "If handles are conditionally rendered and not present initially,
  // you need to update the node internals".
  useEffect(() => {
    try {
      if (typeof id === "string") updateNodeInternals(String(id));
    } catch (_) {
      /* ignore */
    }
  }, [updateNodeInternals, connection?.inProgress, id]);

  const isTarget = !!(
    connection &&
    (connection as any).inProgress &&
    (connection as any).fromNode &&
    String((connection as any).fromNode.id) !== String(id)
  );
  const nodeData = (data ?? {}) as CustomOntologyNodeData;
  const individualNameInitial = String(
    nodeData.individualName ?? nodeData.iri ?? "",
  );
  const [individualName, setIndividualName] = useState(individualNameInitial);
  const showHandles = !!((connection as any)?.inProgress || !selected);

  const rdfManager = useOntologyStore((s) => s.rdfManager);
  // const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  const availableClasses = useOntologyStore((s) => s.availableClasses);
  const availableProperties = useOntologyStore((s) => s.availableProperties);

  const lastFp = useRef<string | null>(null);
  const rdfTypesKey = Array.isArray(nodeData.rdfTypes)
    ? nodeData.rdfTypes.join("|")
    : "";
  useEffect(() => {
    try {
      const uri = String(nodeData.iri || "");
      const fp = `${uri}|${String(nodeData.classType ?? "")}|${rdfTypesKey}|${String(nodeData.displayType ?? "")}`;
      if (lastFp.current === fp) return;
      lastFp.current = fp;
      if (_loggedFingerprints.has(fp)) return;
      _loggedFingerprints.add(fp);
      const payload = {
        uri,
        classType: nodeData.classType,
        rdfTypes: nodeData.rdfTypes,
        displayType: nodeData.displayType,
      };
      
    } catch (_) {
      /* ignore */
    }
  }, [
    nodeData.iri,
    nodeData.classType,
    rdfTypesKey,
    nodeData.displayType,
    nodeData.rdfTypes,
  ]);

  // Display helpers
  // Acquire palette before computing display values so memoized computeTermDisplay calls can use it.
  const palette = usePaletteFromRdfManager();

  // Compute display info for the node IRI and for the meaningful type (classType) if present.
  const { badgeText, subtitleText, headerDisplay, typesList } = useMemo(() => {
    try {
      const iri = String(nodeData.iri || "");
      const typeIri = nodeData.classType ? String(nodeData.classType) : undefined;

      const tdNode = rdfManager
        ? computeTermDisplay(iri || "", rdfManager as any, palette, {
            availableClasses,
            availableProperties,
          })
        : { prefixed: shortLocalName(iri || ""), short: shortLocalName(iri || ""), label: shortLocalName(iri || ""), iri };

      const tdType = typeIri && rdfManager
        ? computeTermDisplay(typeIri, rdfManager as any, palette, {
            availableClasses,
            availableProperties,
          })
        : undefined;

      // Title (visible): prefixed IRI of the node or short/local name or full IRI
      const headerDisp = tdNode.prefixed || tdNode.short || String(nodeData.iri || "");

      // Badge: prefixed IRI of meaningful type, or short/local name, or fallback to namespace/iri
      let badge = "";
      if (tdType) {
        badge = tdType.prefixed || tdType.short || String(typeIri || "");
      } else {
        // fallback: try to use toPrefixed on raw classType if possible
        try {
          if (nodeData.classType && rdfManager) {
            badge = toPrefixed(String(nodeData.classType), rdfManager as any);
          } else {
            badge = String(nodeData.classType || nodeData.namespace || "");
          }
        } catch (_) {
          badge = String(nodeData.classType || nodeData.namespace || "");
        }
      }

      const subtitle = tdNode.label || tdNode.prefixed || tdNode.short || String(nodeData.iri || "");

      // typesList (not used heavily) keep empty for now; could list rdfTypes expanded prefixed forms.
      const tList: string[] = [];
      if (Array.isArray(nodeData.rdfTypes)) {
        try {
          nodeData.rdfTypes.forEach((t) => {
            try {
              if (!t) return;
              if (rdfManager) {
                const td = computeTermDisplay(String(t), rdfManager as any, palette, {
                  availableClasses,
                  availableProperties,
                });
                tList.push(td.prefixed || td.short || td.iri);
              } else {
                tList.push(shortLocalName(String(t)));
              }
            } catch (_) {}
          });
        } catch (_) {}
      }

      return { badgeText: badge, subtitleText: subtitle, headerDisplay: headerDisp, typesList: tList };
    } catch (_) {
      return { badgeText: String(nodeData.classType || nodeData.namespace || ""), subtitleText: String(nodeData.label || shortLocalName(nodeData.iri || "")), headerDisplay: String(nodeData.label || shortLocalName(nodeData.iri || "")), typesList: [] as string[] };
    }
  }, [
    nodeData.classType,
    nodeData.label,
    nodeData.iri,
    palette,
  ]);

  // Color/palette resolution (strict: use central palette only)
  const namespace = String(nodeData.namespace ?? "");

  // Prefer an explicit paletteColor set on the node data (set by KnowledgeCanvas enrichment).
  // Then prefer a color derived from the node's classType namespace (most authoritative after mapping).
  // Finally fall back to namespace-based lookup or reverse-lookup against rdfManager namespaces.
  let resolvedPaletteColor: string | undefined = undefined;
  try {
    // 0) If the canvas enrichment already provided an authoritative paletteColor, prefer it.
    if (nodeData && (nodeData as any).paletteColor) {
      resolvedPaletteColor =
        String((nodeData as any).paletteColor || undefined) || undefined;
    }

    // 1) If we have a canonical classType (absolute IRI), prefer its palette mapping.
    //    This ensures the color follows the meaningful type, not the node IRI or namespace field.
    if (!resolvedPaletteColor && nodeData && nodeData.classType && rdfManager) {
      try {
        try {
          const pref = toPrefixed(String(nodeData.classType), rdfManager as any);
          const prefix = pref && pref.includes(":") ? pref.split(":")[0] : "";
          if (prefix) {
            resolvedPaletteColor = getNamespaceColorFromPalette(palette, prefix) || undefined;
          }
        } catch (_) {
          /* ignore prefixed resolution failures */
        }
      } catch (_) {
        /* ignore */
      }
    }

    // 2) Direct palette lookup using the node's namespace (may be a prefix or a short key)
    if (!resolvedPaletteColor) {
      try {
        resolvedPaletteColor =
          getNamespaceColorFromPalette(
            palette,
            String(nodeData.namespace ?? ""),
          ) || undefined;
      } catch (_) {
        resolvedPaletteColor = undefined;
      }
    }
  } catch (_) {
    resolvedPaletteColor = undefined;
  }

  
  const DEFAULT_PALETTE_COLOR = "#e5e7eb";
  const badgeColor = resolvedPaletteColor || DEFAULT_PALETTE_COLOR;
  const leftColor = badgeColor;

  const themeBg =
    typeof document !== "undefined"
      ? (
          getComputedStyle(document.documentElement).getPropertyValue(
            "--node-bg",
          ) || ""
        ).trim() || "#ffffff"
      : "#ffffff";
  const hasErrors =
    Array.isArray(nodeData.errors) && nodeData.errors.length > 0;

  const annotations: Array<{ term: string; value: string }> = [];
  if (
    Array.isArray(nodeData.annotationProperties) &&
    nodeData.annotationProperties.length > 0
  ) {
    nodeData.annotationProperties.forEach((ap) => {
      const propertyIri = String(
        (ap && (ap as any).propertyUri) ||
          (ap && (ap as any).property) ||
          (ap && (ap as any).term) ||
          (ap && (ap as any).key) ||
          "",
      );
      const rawValue = ap && (ap as any).value;
      if (!propertyIri) return;
      if (rawValue === undefined || rawValue === null) return;
      const valueStr = String(rawValue);
      if (valueStr.trim() === "") return;
      const term = (() => {
        if (propertyIri.startsWith("_:")) return propertyIri;
        try {
          return toPrefixed(propertyIri, rdfManager as any);
        } catch (_) {
          return shortLocalName(propertyIri);
        }
      })();
      annotations.push({ term, value: valueStr });
    });
  } else if (nodeData.properties && typeof nodeData.properties === "object") {
    Object.entries(nodeData.properties)
      .slice(0, 6)
      .forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        const valueStr = String(v);
        if (valueStr.trim() === "") return;
          const term = (() => {
          const keyStr = String(k);
          if (keyStr.startsWith("_:")) return keyStr;
          try {
            return toPrefixed(keyStr, rdfManager as any);
          } catch (_) {
            return shortLocalName(keyStr);
          }
        })();
        annotations.push({ term, value: valueStr });
      });
  }

  const typePresentButNotLoaded =
    !nodeData.classType &&
    Array.isArray(nodeData.rdfTypes) &&
    nodeData.rdfTypes.some(
      (t) => Boolean(t) && !/NamedIndividual/i.test(String(t)),
    );

  useEffect(() => {
    setIndividualName(individualNameInitial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeData.iri, nodeData.individualName]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastMeasuredRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = (w: number, h: number) => {
      try {
        const cb = (data as any)?.onSizeMeasured;
        const last = lastMeasuredRef.current;
        if (last && Math.abs(last.w - w) < 2 && Math.abs(last.h - h) < 2) {
          return;
        }
        lastMeasuredRef.current = { w, h };
        if (typeof cb === "function") {
          try {
            cb(Math.round(w), Math.round(h));
          } catch (_) {
            /* ignore callback errors */
          }
        }
      } catch (_) {
        /* ignore */
      }
    };
    report(el.offsetWidth, el.offsetHeight);
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          report(cr.width, cr.height);
        }
      });
      ro.observe(el);
    } catch (_) {
      const onWin = () => report(el.offsetWidth, el.offsetHeight);
      window.addEventListener("resize", onWin);
      return () => {
        window.removeEventListener("resize", onWin);
      };
    }
    return () => {
      try {
        if (ro) ro.disconnect();
      } catch (_) {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef]);

  useEffect(() => {
    try {
      const el = rootRef.current;
      if (!el) return;
      const wrapper: HTMLElement | null =
        typeof el.closest === "function"
          ? (el as any).closest(".react-flow__node")
          : el.parentElement || null;
      if (!wrapper || !wrapper.style) return;
      const colorToApply = badgeColor || leftColor;
      
      if (colorToApply) {
        try {
          wrapper.style.setProperty(
            "--node-leftbar-color",
            String(colorToApply),
          );
        } catch (_) {
          try {
            wrapper.style.setProperty(
              "--node-leftbar-color",
              String(colorToApply),
            );
          } catch (_) {
            /* ignore */
          }
        }
      } else {
        try {
          wrapper.style.removeProperty("--node-leftbar-color");
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }, [badgeColor, leftColor]);

  const canonicalIri = String(nodeData.iri ?? "");
  const headerTitle = canonicalIri;

  // Use the node id (IRI) directly as the handle id per project convention.
  const handleId = String(id || "");

  // Connection helpers removed — canvas now relies on React Flow native handle drag.
  // Click-to-connect bridge (vg:start-connection / vg:end-connection) was removed to
  // simplify behavior and rely on React Flow's built-in connection lifecycle.

  // When the user interacts with the node, use pointer events for more reliable behavior.
  // onPointerDown starts a pending connection; onPointerUp ends it (if pending). We stop propagation
  // so inner interactive elements don't swallow the gesture. Also emit lightweight debug logs.
  return (
    <div
      ref={rootRef}
      className={cn(
        "inline-flex overflow-hidden",
        selected ? "ring-2 ring-primary" : "",
      )}
    >
      <div
        className="px-4 py-3 min-w-0 flex-1 w-auto"
        style={{ background: themeBg }}
      >
        <div className="flex items-center gap-3 mb-2">
          <div
            className="text-sm font-bold text-foreground truncate"
            title={headerTitle}
          >
            {headerDisplay}
          </div>

          <div
            className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-black flex items-center gap-1"
            style={{
              background: badgeColor
                ? `var(--node-leftbar-color, ${badgeColor})`
                : undefined,
              border: badgeColor
                ? `1px solid ${darken(badgeColor, 0.12)}`
                : undefined,
            }}
          >
            <span className="truncate">
              {badgeText || nodeData.classType || (namespace ? namespace : "unknown")}
            </span>
          </div>

          {hasErrors && (
            <div className="ml-auto">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="h-6 w-6 p-0 text-destructive flex items-center justify-center"
                    aria-label="Errors"
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64">
                  <div className="space-y-2 text-sm">
                    <div className="font-medium">Validation Errors</div>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      {nodeData.errors?.map((e, idx) => (
                        <li key={idx}>{String(e)}</li>
                      ))}
                    </ul>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        <div className="text-sm text-muted-foreground mb-3">
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {subtitleText}
          </div>
        </div>

        <div className="pt-2 border-t border-gray-100">
          {annotations.length === 0 ? (
            <div className="text-xs text-muted-foreground">No annotations</div>
          ) : (
            <div className="space-y-2">
              {annotations.map((a, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-[110px_1fr] gap-2 text-sm"
                >
                  <div className="font-medium text-xs text-muted-foreground truncate">
                    {a.term}
                  </div>
                  <div className="text-xs text-foreground truncate">
                    {a.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {typePresentButNotLoaded && (
          <div className="mt-2 text-xs text-muted-foreground">
            Type present but ontology not loaded
          </div>
        )}
      </div>

      {/* Match example: render source on the Right and target on the Left, with the same conditional logic.
            This mirrors the provided example so native handle-drag shows the live connection correctly. */}
      {showHandles && (
        <>
          <Handle
            id={handleId}
            type="source"
            position={Position.Right}
            className="!bg-transparent !border-0"
            isConnectable={true}
          />
          {(!(connection as any)?.inProgress || isTarget) && (
            <Handle
              id={handleId}
              type="target"
              position={Position.Left}
              className="!bg-transparent !border-0"
              isConnectable={true}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Small color utility to darken a hex color by a factor (0-1).
 */
function darken(hex: string, amount: number) {
  try {
    const c = hex.replace("#", "");
    const num = parseInt(
      c.length === 3
        ? c
            .split("")
            .map((s) => s + s)
            .join("")
        : c,
      16,
    );
    let r = (num >> 16) & 0xff;
    let g = (num >> 8) & 0xff;
    let b = num & 0xff;
    r = Math.max(0, Math.min(255, Math.round(r * (1 - amount))));
    g = Math.max(0, Math.min(255, Math.round(g * (1 - amount))));
    b = Math.max(0, Math.min(255, Math.round(b * (1 - amount))));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  } catch (_) {
    return hex;
  }
}

export const CustomOntologyNode = memo(CustomOntologyNodeInner);
CustomOntologyNode.displayName = "CustomOntologyNode";
