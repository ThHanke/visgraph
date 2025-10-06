 
import React, { memo, useEffect, useRef, useMemo } from "react";
import {
  Handle, 
  Position,
  NodeProps,
  useConnection,
} from "@xyflow/react";
import { cn } from "../../lib/utils";
import { Edit3, AlertTriangle, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
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

  // // const rdfManager = useOntologyStore((s) => s.rdfManager);
  // // // const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  // // const availableClasses = useOntologyStore((s) => s.availableClasses);
  // // const availableProperties = useOntologyStore((s) => s.availableProperties);

  // const lastFp = useRef<string | null>(null);
  // const rdfTypesKey = Array.isArray(nodeData.rdfTypes)
  //   ? nodeData.rdfTypes.join("|")
  //   : "";
  // useEffect(() => {
  //   try {
  //     const uri = String(nodeData.iri || "");
  //     const fp = `${uri}`;
  //     if (lastFp.current === fp) return;
  //     lastFp.current = fp;
  //     if (_loggedFingerprints.has(fp)) return;
  //     _loggedFingerprints.add(fp);
  //     const payload = {
  //       uri,
  //     };
  //   } catch (_) {
  //     /* ignore */
  //   }
  // }, [
  //   nodeData.iri,
  // ]);

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

  
  // Simple helpers to choose readable badge foreground for a given hex color.
  function hexToRgb(hex?: string) {
    if (!hex) return null;
    const c = hex.replace("#", "");
    const full = c.length === 3 ? c.split("").map((s) => s + s).join("") : c;
    const num = parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  // function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }) {
  //   const srgb = [r, g, b].map((v) => {
  //     const s = v / 255;
  //     return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  //   });
  //   return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  // }

  // function pickBadgeForeground(hex?: string) {
  //   const rgb = hexToRgb(hex || "");
  //   // const L = relativeLuminance(rgb);
  //   // contrast with white = (1.05)/(L+0.05), contrast with black = (L+0.05)/0.05
  //   const contrastWhite = (1.05) / (L + 0.05);
  //   const contrastBlack = (L + 0.05) / 0.05;
  //   // prefer white if it has higher contrast, otherwise dark gray
  //   return contrastWhite >= contrastBlack ? "#ffffff" : "#111827";
  // }

  const nodeColor = nodeData.color;
  
  
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
  // const lastMeasuredRef = useRef<{ w: number; h: number } | null>(null);


  // Size reporting removed — component is now pure/read-only and does not observe element size.
  // Any measurement responsibilities belong to parent/layout code if needed.
  // Use the node id (IRI) directly as the handle id per project convention.
  // const handleId = String(id || "");
  // NOTE: Do not URL-encode or escape the handle id here — we rely on the mapper
  // to use plain IRIs for handle attachment so edges reference source/target directly.
  // Keeping the raw IRI in the handle id matches the project's canonical representation.
  // Be aware: some characters in raw IRIs may produce invalid DOM ids; this project
  // intentionally uses IRIs as node ids and React Flow accepts those as handle ids.

  // Connection helpers removed — canvas now relies on React Flow native handle drag.
  // Click-to-connect bridge (vg:start-connection / vg:end-connection) was removed to
  // simplify behavior and rely on React Flow's built-in connection lifecycle.

  // When the user interacts with the node, use pointer events for more reliable behavior.
  // onPointerDown starts a pending connection; onPointerUp ends it (if pending). We stop propagation
  // so inner interactive elements don't swallow the gesture. Also emit lightweight debug logs.
  // const label = nodeData.iri;
//   return (
//     <div className="customNode">
//       <div
//         className="customNodeBody"
//         style={{
//           borderStyle: isTarget ? 'dashed' : 'solid',
//           backgroundColor: isTarget ? '#ffcce3' : '#ccd9f6',
//         }}
//       >
//         {/* If handles are conditionally rendered and not present initially, you need to update the node internals https://reactflow.dev/docs/api/hooks/use-update-node-internals/ */}
//         {/* In this case we don't need to use useUpdateNodeInternals, since !isConnecting is true at the beginning and all handles are rendered initially. */}
//         {!connection.inProgress && <Handle className="customHandle" position={Position.Right} type="source" />}
//         {/* We want to disable the target handle, if the connection was started from this node */}
//         {(!connection.inProgress || isTarget) && (
//           <Handle className="customHandle" position={Position.Left} type="target" isConnectableStart={false} />
//         )}
//         {label}
//       </div>
//     </div>
//   );
// }
  return (
    <div
      ref={rootRef}
      style={{
        ['--node-color' as any]: nodeColor || 'transparent',
      }}
      className={cn(
        "flex items-stretch overflow-hidden rounded-md shadow-sm",
        selected ? "ring-2 ring-primary" : "",
      )}
    >
      {/* Left namespace color bar — explicit element so Tailwind can style layout; color is dynamic */}
      <div
        aria-hidden="true"
        className="w-2 flex-none"
        style={{ background: nodeColor || "transparent" }}
      />

      <div className="px-4 py-3 min-w-0 flex-1 w-auto node-bg">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="text-sm font-bold text-foreground truncate"
            title={headerDisplay}
          >
            {headerDisplay}
          </div>

          <div
            className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold flex items-center gap-1 node-badge"
            style={{
              ['--node-color' as any]: nodeColor || 'transparent',
            }}
            aria-hidden="true"
          >
            <span className="truncate text-foreground-dark">
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

        <div className="pt-2 border-t border-border">
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
