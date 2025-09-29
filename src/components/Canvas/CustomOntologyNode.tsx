/* eslint-disable no-empty */
import React, { memo, useEffect, useRef, useMemo } from "react";
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
import { shortLocalName, toPrefixed } from "../../utils/termUtils";
import { debug } from "../../utils/startupDebug";
import { NodeData } from "../../types/canvas";

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
  const nodeData = (data ?? {}) as NodeData;
  const showHandles = !!((connection as any)?.inProgress || !selected);

  // const rdfManager = useOntologyStore((s) => s.rdfManager);
  // // const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  // const availableClasses = useOntologyStore((s) => s.availableClasses);
  // const availableProperties = useOntologyStore((s) => s.availableProperties);

  const lastFp = useRef<string | null>(null);
  const rdfTypesKey = Array.isArray(nodeData.rdfTypes)
    ? nodeData.rdfTypes.join("|")
    : "";
  useEffect(() => {
    try {
      const uri = String(nodeData.iri || "");
      const fp = `${uri}`;
      if (lastFp.current === fp) return;
      lastFp.current = fp;
      if (_loggedFingerprints.has(fp)) return;
      _loggedFingerprints.add(fp);
      const payload = {
        uri,
      };
      try {
        if (typeof debug === "function") {
          try { debug("node.fingerprint", payload); } catch (_) {}
        }
      } catch (_) {}
    } catch (_) {
      /* ignore */
    }
  }, [
    nodeData.iri,
  ]);

  // Compute display info for the node IRI and for the meaningful type (classType) if present.
  const { badgeText, subtitleText, headerDisplay, typesList } = useMemo(() => {
  // Header/title: prefer explicit mapped displayPrefixed -> label -> displayShort -> short local name.
  const headerDisp =
    (nodeData.displayPrefixed as string);

  // Badge: prefer the mapped/class display for the classType (if present).
  // Compute a prefixed form for the classType using the effectiveRegistry. Avoid runtime
  // exceptions by falling back to raw values.
  
  let badge = "";
  // Prefer: mapper-provided displayClassType, then computed prefixed classDisplayPrefixed,
  // then node-level displayPrefixed, then raw classType, then short local name.
  badge = String(nodeData.displayclassType || "");

  // Subtitle: prefer humanLabel, then label, then displayPrefixed/displayShort, then short local name.
  const subtitle =
    (nodeData.label as string) ||
    (nodeData.displayPrefixed as string);
  return { badgeText: badge, subtitleText: subtitle, headerDisplay: headerDisp, typesList: nodeData.rdfTypes};
  }, [
    nodeData.classType,
    nodeData.label,
    nodeData.iri,
    nodeData.displayPrefixed,
    nodeData.displayShort,
    nodeData.primaryTypeIri,
    nodeData.rdfTypes,
  ]);

  
  const DEFAULT_PALETTE_COLOR = "#e5e7eb";
  const nodeColor = nodeData.color || DEFAULT_PALETTE_COLOR;

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
  if (Array.isArray(nodeData.properties) && nodeData.properties.length > 0) {
    (nodeData.properties as Array<{ property: string; value: any }>).slice(0, 6).forEach((ap) => {
      try {
        const propertyIri = String((ap && ap.property) || "");
        const rawValue = ap && ap.value;
        if (!propertyIri) return;
        if (rawValue === undefined || rawValue === null) return;
        const valueStr = String(rawValue);
        if (valueStr.trim() === "") return;
        const term = (() => {
          if (propertyIri.startsWith("_:")) return propertyIri;
            try {
              return toPrefixed(propertyIri);
            } catch (_) {
              return shortLocalName(propertyIri);
            }
        })();
        annotations.push({ term, value: valueStr });
      } catch (_) {
        /* ignore per-entry */
      }
    });
  }

  const typePresentButNotLoaded =
    !nodeData.classType &&
    Array.isArray(nodeData.rdfTypes) &&
    nodeData.rdfTypes.some(
      (t) => Boolean(t) && !/NamedIndividual/i.test(String(t)),
    );


  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastMeasuredRef = useRef<{ w: number; h: number } | null>(null);

  // Size reporting removed — component is now pure/read-only and does not observe element size.
  // Any measurement responsibilities belong to parent/layout code if needed.

  // Removed direct DOM mutation. Visual color is applied inline in render to keep component pure/read-only.

  const headerTitle = nodeData.displayPrefixed;

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
              background: nodeColor,
              border: nodeColor ? `1px solid ${darken(nodeColor, 0.12)}` : undefined,
            }}
          >
            <span className="truncate">
              {badgeText || nodeData.classType}
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
