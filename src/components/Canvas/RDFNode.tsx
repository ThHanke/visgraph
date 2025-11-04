 
import React, { memo, useEffect, useRef, useMemo, useState } from "react";
import {
  Handle, 
  Position,
  NodeProps,
  useConnection,
} from "@xyflow/react";
import { cn } from "../../lib/utils";
import { toPrefixed } from "../../utils/termUtils";
import { NodeData } from "../../types/canvas";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";


function RDFNodeImpl(props: NodeProps) {
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
  // Header/title: prefer explicit mapped displayPrefixed -> label -> displayShort -> short local name.
  const headerDisp =
    (nodeData.displayPrefixed as string);

  let badge = "";
  // Prefer: mapper-provided displayClassType, then computed prefixed classDisplayPrefixed,
  // then node-level displayPrefixed, then raw classType, then short local name.
  badge = String(nodeData.displayclassType || "");

  // Subtitle: prefer explicit subtitle, then humanLabel, then label, then displayPrefixed/displayShort, then short local name.
  const subtitle =
    (nodeData.subtitle as string);
  return { badgeText: badge, subtitleText: subtitle, headerDisplay: headerDisp, typesList: nodeData.rdfTypes};
  }, [
    nodeData.classType,
    nodeData.label,
    nodeData.subtitle,
    nodeData.iri,
    nodeData.displayPrefixed,
    nodeData.displayShort,
    nodeData.primaryTypeIri,
    nodeData.rdfTypes,
  ]);

  const nodeColor = nodeData.color;
  
  
  const hasErrors =
    Array.isArray(nodeData.errors) && nodeData.errors.length > 0;

  const hasReasoningError =
    Array.isArray((nodeData as any).reasoningErrors) && (nodeData as any).reasoningErrors.length > 0;
  const hasReasoningWarning =
    Array.isArray((nodeData as any).reasoningWarnings) && (nodeData as any).reasoningWarnings.length > 0;

  const reasoningClass = hasReasoningError
    ? "border-2 border-destructive ring-4 ring-destructive/20"
    : hasReasoningWarning
      ? "border-2 border-amber-500 ring-4 ring-amber-300"
      : "";


  const annotations: Array<{ term: string; value: string }> = [];
  if (Array.isArray(nodeData.properties) && nodeData.properties.length > 0) {
    (nodeData.properties as Array<{ property: string; value: any }>).slice(0, 6).forEach((ap) => {
      {
        const propertyIri = String((ap && ap.property) || "");
        const rawValue = ap && ap.value;
        if (!propertyIri) return;
        if (rawValue === undefined || rawValue === null) return;
        const valueStr = String(rawValue);
        if (valueStr.trim() === "") return;
        const term = (() => {
          if (propertyIri.startsWith("_:")) return propertyIri;
          try {
            const p = toPrefixed(propertyIri);
            // Only accept a prefixed form when it differs from the raw IRI; otherwise keep the raw IRI.
            return p && String(p) !== String(propertyIri) ? String(p) : String(propertyIri);
          } catch (_) {
            return String(propertyIri);
          }
        })();
        annotations.push({ term, value: valueStr });
      }
    });
  }

  const typePresentButNotLoaded =
    !nodeData.classType &&
    Array.isArray(nodeData.rdfTypes) &&
    nodeData.rdfTypes.some((t) => Boolean(t));


  const rootRef = useRef<HTMLDivElement | null>(null);
  // Track hover-open state for selected nodes so we can open tooltips even when pointer events
  // are intercepted by overlays/handles. We compute hover by listening to global mousemove while
  // the node is selected to avoid touching pointer-events on handles.
  const [hoverOpen, setHoverOpen] = useState(false);
  // const lastMeasuredRef = useRef<{ w: number; h: number } | null>(null);

  // Listen to global mousemove and compute whether the pointer is inside this
  // node's bounding rect. We do this for all nodes (selected or not) because
  // pointerenter may be intercepted by overlay handles; global detection is more
  // reliable and still lightweight for a single node element.
  React.useEffect(() => {
    const nodeEl = rootRef.current;
    if (!nodeEl) return;

    const onMove = (e: MouseEvent) => {
      try {
        const rect = nodeEl.getBoundingClientRect();
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        setHoverOpen(inside);
      } catch (_) {
        // ignore
      }
    };

    window.addEventListener("mousemove", onMove, { capture: true });
    // Also listen for pointerdown to immediately close (avoids sticking open after clicks)
    const onDown = () => setHoverOpen(false);
    window.addEventListener("pointerdown", onDown, { capture: true });

    return () => {
      window.removeEventListener("mousemove", onMove, { capture: true });
      window.removeEventListener("pointerdown", onDown, { capture: true });
      setHoverOpen(false);
    };
  }, []);


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
        "flex items-stretch overflow-hidden rounded-md shadow-sm box-border border-solid",
        selected ? "ring-2 ring-primary" : "",
        reasoningClass
      )}
    >
      {/* Left namespace color bar — explicit element so Tailwind can style layout; color is dynamic */}
      <div
        aria-hidden="true"
        className="w-2 flex-none"
        style={{ background: nodeColor || "transparent" }}
      />

      {/* Always use a controlled Tooltip to avoid switching between controlled/uncontrolled.
          hoverOpen is updated by either local pointer events (unselected) or the global
          mousemove probe (selected). */}
      <Tooltip delayDuration={250} open={hoverOpen} onOpenChange={setHoverOpen}>
        <TooltipTrigger asChild>
          <div
            className="px-4 py-3 min-w-0 flex-1 w-auto node-bg"
            onPointerEnter={() => {
              // For unselected nodes we open tooltip on direct pointer events.
              if (!selected) {
                try { setHoverOpen(true); } catch (_) { /* ignore */ }
              }
            }}
            onPointerLeave={() => {
              if (!selected) {
                try { setHoverOpen(false); } catch (_) { /* ignore */ }
              }
            }}
          >
            <div className="flex items-center gap-3 mb-2">
              <div
                className="text-sm font-bold text-foreground truncate"
                aria-label={headerDisplay}
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

              {hasErrors}
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
        </TooltipTrigger>

        <TooltipContent side="top">
          <div className="text-left text-sm space-y-2 max-w-[32rem]">
            <div className="font-semibold break-words whitespace-pre-wrap">{headerDisplay}</div>
            <div className="text-xs text-muted-foreground">{badgeText || nodeData.classType}</div>
            {subtitleText && <div className="text-xs text-muted-foreground break-words whitespace-pre-wrap">{subtitleText}</div>}

            <div className="mt-2">
              <div className="font-medium text-xs text-muted-foreground mb-1">Annotations</div>
              {annotations.length === 0 ? (
                <div className="text-xs text-muted-foreground">No annotations</div>
              ) : (
                <ul className="text-sm space-y-1">
                  {annotations.map((a, i) => (
                    <li key={i} className="flex gap-2">
                      <div className="w-28 text-xs text-muted-foreground truncate">{a.term}</div>
                      <div className="text-xs text-foreground truncate">{a.value}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {Array.isArray(typesList) && typesList.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-muted-foreground font-medium">Types</div>
                <ul className="text-xs space-y-0.5">
                  {typesList.map((t, idx) => {
                    const termDisplay = (() => {
                      try {
                        const p = toPrefixed(String(t));
                        return p && String(p) !== String(t) ? String(p) : String(t);
                      } catch (_) {
                        return String(t);
                      }
                    })();
                    return <li key={idx} className="break-words whitespace-pre-wrap">{termDisplay}</li>;
                  })}
                </ul>
              </div>
            )}

            {Array.isArray((nodeData as any).reasoningErrors) && (nodeData as any).reasoningErrors.length > 0 && (
              <div>
                <div className="text-xs font-medium text-destructive mb-1">Reasoning errors</div>
                <ul className="text-xs text-destructive space-y-0.5">
                  {(nodeData as any).reasoningErrors.map((m: any, i: number) => (
                    <li key={i} className="break-words whitespace-pre-wrap">{String(m)}</li>
                  ))}
                </ul>
              </div>
            )}

            {Array.isArray((nodeData as any).reasoningWarnings) && (nodeData as any).reasoningWarnings.length > 0 && (
              <div>
                <div className="text-xs font-medium text-amber-600 mb-1">Reasoning warnings</div>
                <ul className="text-xs text-amber-700 space-y-0.5">
                  {(nodeData as any).reasoningWarnings.map((m: any, i: number) => (
                    <li key={i} className="break-words whitespace-pre-wrap">{String(m)}</li>
                  ))}
                </ul>
              </div>
            )}

            {nodeData.iri && <div className="text-xs text-muted-foreground mt-1 break-words whitespace-pre-wrap">{String(nodeData.iri)}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
      {/* In this case we don't need to use useUpdateNodeInternals, since !isConnecting is true at the beginning and all handles are rendered initially. */}
      {showHandles && (
        <Handle
          className="customHandle"
          position={Position.Right}
          type="source"
          onPointerDown={() => {
            { console.log("[VG_DEBUG] handle pointerdown", { nodeId: id, handle: "source" }); }
          }}
          onPointerUp={() => {
            { console.log("[VG_DEBUG] handle pointerup", { nodeId: id, handle: "source" }); }
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
            { console.log("[VG_DEBUG] handle pointerdown", { nodeId: id, handle: "target" }); }
          }}
          onPointerUp={() => {
            { console.log("[VG_DEBUG] handle pointerup", { nodeId: id, handle: "target" }); }
          }}
        />
      )}

    </div>
  );
}


export const RDFNode = memo(RDFNodeImpl);
RDFNode.displayName = "RDFNode";
