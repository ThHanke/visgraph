import React, { memo, useEffect, useRef, useMemo, useState } from "react";
import {
  Handle,
  Position,
  NodeProps,
  useConnection,
} from "@xyflow/react";
import {
  NodeTooltip,
  NodeTooltipContent,
  NodeTooltipTrigger,
} from "@/components/node-tooltip";
import { cn } from "../../lib/utils";
import { Edit3, AlertTriangle, Info } from "lucide-react";
import PropertyList from "../ui/PropertyList";
import { shortLocalName, toPrefixed } from "../../utils/termUtils";
import { NodeData } from "../../types/canvas";


function CustomOntologyNodeImpl(props: NodeProps) {
  const { data, selected, id } = props;
  const connection = useConnection();

  const connectionInProgress = Boolean((connection as any)?.inProgress);
  const connectionFromNodeId = String(
    (connection as any)?.fromNode && ((connection as any).fromNode.id || ((connection as any).fromNode as any).measured && ((connection as any).fromNode as any).measured.id)
      ? String(((connection as any).fromNode.id || ""))
      : ""
  );
  
  const isTarget = Boolean(connectionInProgress && connectionFromNodeId && connectionFromNodeId !== String(id));
  const nodeData = (data ?? {}) as NodeData;
  const showHandles = !!(connectionInProgress || !selected);

  // Compute display info for the node IRI and for the meaningful type (classType) if present.
  const { badgeText, subtitleText, headerDisplay, typesList } = useMemo(() => {
    const headerDisp = (nodeData.displayPrefixed as string);
    let badge = "";
    badge = String(nodeData.displayclassType || "");
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

  // Simple helpers to choose readable badge foreground for a given hex color.
  function hexToRgb(hex?: string) {
    if (!hex) return null;
    const c = hex.replace("#", "");
    const full = c.length === 3 ? c.split("").map((s) => s + s).join("") : c;
    const num = parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }) {
    const srgb = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function pickBadgeForeground(hex?: string) {
    const rgb = hexToRgb(hex || "");
    if (!rgb) return "hsl(var(--node-foreground))";
    const L = relativeLuminance(rgb);
    const contrastWhite = (1.05) / (L + 0.05);
    const contrastBlack = (L + 0.05) / 0.05;
    return contrastWhite >= contrastBlack ? "#ffffff" : "#111827";
  }

  const nodeColor = nodeData.color;
  const nodeBadgeForeground = pickBadgeForeground(nodeColor);

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
  
  // Node rendering: keep node element simple and avoid popover/tooltip interfering with pointer events.
  // Use React Flow's NodeTooltip for the tooltip content (migration requested).
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
      // style={{ background: themeBg }}
    >
      <div className="flex items-center gap-3 mb-2">
        <div
          className="text-sm font-bold text-foreground truncate"
          title={headerDisplay}
        >
          {headerDisplay}
        </div>

        <div
          className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-black flex items-center gap-1"
          style={{
            background: nodeColor,
          }}
        >
          <span className="truncate">
            {badgeText || nodeData.classType}
          </span>
        </div>

        {hasErrors && (
          <div className="ml-auto">
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
    {/* In this case we don't need to use useUpdateNodeInternals, since !isConnecting is true at the beginning and all handles are rendered initially. */}
    {showHandles && (
      <Handle
        className="customHandle"
        position={Position.Right}
        type="source"
        onPointerDown={() => {
          try { console.log("[VG_DEBUG] handle pointerdown", { nodeId: id, handle: "source" }); } catch (_) { void 0; }
        }}
        onPointerUp={() => {
          try { console.log("[VG_DEBUG] handle pointerup", { nodeId: id, handle: "source" }); } catch (_) { void 0; }
        }}
      />
    )}
    {/* We want to disable the target handle, if the connection was started from this node */}
    {(showHandles || isTarget) && (
      <Handle
        className="customHandle"
        position={Position.Left}
        type="target"
        isConnectableStart={false}
        onPointerDown={() => {
          try { console.log("[VG_DEBUG] handle pointerdown", { nodeId: id, handle: "target" }); } catch (_) { void 0; }
        }}
        onPointerUp={() => {
          try { console.log("[VG_DEBUG] handle pointerup", { nodeId: id, handle: "target" }); } catch (_) { void 0; }
        }}
      />
    )}

  </div>
  );
}


export const CustomOntologyNode = memo(CustomOntologyNodeImpl);
CustomOntologyNode.displayName = "CustomOntologyNode";
