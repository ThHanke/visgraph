import React, { memo, useState, useCallback } from "react";
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  BaseEdge,
  useInternalNode,
  MarkerType,
} from "@xyflow/react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import PropertyList from "../ui/PropertyList";
import { getEdgeParams } from "./EdgeParams";
import { resolveEdgeRenderProps } from "./core/edgeStyle";
import type { LinkData } from "../../types/canvas";

/**
 * FloatingEdge
 *
 * Renders an edge path and a small badge label. Badge text resolution prefers:
 *  1) explicit label passed via props or data.label
 *  2) rdfs:label / prefixed form via computeTermDisplay (using RDF manager)
 *  3) short local name fallback
 *
 * Implementation keeps logic straightforward and avoids deep nesting to prevent
 * accidental syntax errors introduced during iterative edits.
 */
const FloatingEdge = memo((props: EdgeProps) => {
  const { id, source, target, style, data, markerEnd: propMarkerEnd } = props as any;
  const dataTyped = data as LinkData;

  const hasEdgeErrors = Array.isArray((dataTyped as any).reasoningErrors) && (dataTyped as any).reasoningErrors.length > 0;
  const hasEdgeWarnings = Array.isArray((dataTyped as any).reasoningWarnings) && (dataTyped as any).reasoningWarnings.length > 0;
  


  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // Wait until React Flow has measured the nodes and provided internals.
  if (!sourceNode || !targetNode) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode,
  );


  // Defensive guard: if geometry is not numeric, avoid rendering an invalid path.
  if (![sx, sy, tx, ty].every((v) => Number.isFinite(v))) {
    // Avoid rendering to prevent SVG "<path d='MNaN,...'>" errors.
    return null;
  }

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos as any,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos as any,
    curvature: 0.25,
  });

  // Resolve badge text using centralized helper so new and persisted edges share formatting.
  // Prefer mapper-provided prefixed property when available (propertyPrefixed), then fall back to label fields.
  let badgeText = "";

  const { edgeStyle, markerEnd, markerSize } = resolveEdgeRenderProps({ id, style, data });
  const finalMarkerEnd =
    (props as any).markerEnd ??
    propMarkerEnd ??
    markerEnd ??
    { type: (MarkerType as any)?.Arrow ?? "arrow" };

  // 1) prefixed property from mapper -> props/data.propertyPrefixed
  badgeText = String((dataTyped as any)?.propertyPrefixed || (props as any)?.label || (dataTyped as any)?.label || "").trim();

  const [isHovered, setIsHovered] = useState(false);
  const onHoverEnter = useCallback(() => setIsHovered(true), []);
  const onHoverLeave = useCallback(() => setIsHovered(false), []);

  return (
    <>

      <g className={`edge-container ${isHovered ? "vg-edge--hover" : ""}`} onMouseEnter={onHoverEnter} onMouseLeave={onHoverLeave}>
        <BaseEdge id={id} path={edgePath} markerEnd={finalMarkerEnd} style={edgeStyle} />
      </g>
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
          className="edge-label-renderer__custom-edge nodrag nopan pointer-events-auto"
        >
          {badgeText ? (
            <Tooltip delayDuration={250}>
              <TooltipTrigger asChild>
                  <button
                  type="button"
                  className="p-0 bg-transparent border-0 pointer-events-auto"
                  onMouseEnter={onHoverEnter}
                  onMouseLeave={onHoverLeave}
                >
                  <Badge
                    variant={hasEdgeErrors ? "destructive" : "secondary"}
                    className={
                      hasEdgeErrors
                        ? "text-xs px-2 py-1 shadow-md border cursor-pointer border-destructive text-destructive"
                        : hasEdgeWarnings
                          ? "text-xs px-2 py-1 shadow-md border cursor-pointer bg-amber-100 text-amber-700 border-amber-300"
                          : "text-xs px-2 py-1 shadow-md border cursor-pointer"
                    }
                  >
                    {badgeText}
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="space-y-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground break-words whitespace-pre-wrap">
                        {String(dataTyped.propertyPrefixed || dataTyped.label || badgeText)}
                      </div>
                      <div className="text-xs text-muted-foreground break-words mt-1">
                        {String(dataTyped.propertyUri || "")}
                      </div>
                    </div>
                    {dataTyped.color ? (
                      <div
                        className="w-6 h-6 rounded-full border"
                        style={{ background: String(dataTyped.color) }}
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Source IRI</div>
                      <div className="text-xs text-foreground break-words">{(sourceNode && sourceNode.data && sourceNode.data.iri) ? String(sourceNode.data.iri) : String(source)}</div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Target IRI</div>
                      <div className="text-xs text-foreground break-words">{(targetNode && targetNode.data && targetNode.data.iri) ? String(targetNode.data.iri) : String(target)}</div>
                    </div>
                  </div>

                  {Array.isArray(dataTyped.reasoningWarnings) && dataTyped.reasoningWarnings.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-amber-600 mb-1">Reasoning warnings</div>
                      <ul className="text-xs text-amber-700 space-y-0.5">
                        {dataTyped.reasoningWarnings.map((w: any, i: number) => (
                          <li key={i} className="break-words whitespace-pre-wrap">{String(w)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {Array.isArray(dataTyped.reasoningErrors) && dataTyped.reasoningErrors.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-destructive mb-1">Reasoning errors</div>
                      <ul className="text-xs text-destructive space-y-0.5">
                        {dataTyped.reasoningErrors.map((e: any, i: number) => (
                          <li key={i} className="break-words whitespace-pre-wrap">{String(e)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

FloatingEdge.displayName = "FloatingEdge";

export default FloatingEdge;
