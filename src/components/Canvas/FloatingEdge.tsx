import React, { memo } from "react";
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  BaseEdge,
  useInternalNode,
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
  const finalMarkerEnd = (props as any).markerEnd ?? propMarkerEnd ?? markerEnd;

  // 1) prefixed property from mapper -> props/data.propertyPrefixed
  badgeText = String((dataTyped as any)?.propertyPrefixed || (props as any)?.label || (dataTyped as any)?.label || "").trim();

  return (
    <>

      <BaseEdge id={id} path={edgePath} markerEnd={finalMarkerEnd} style={edgeStyle} />
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
                >
                  <Badge
                    variant="secondary"
                    className="text-xs px-2 py-1 shadow-md border cursor-pointer"
                  >
                    {badgeText}
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="space-y-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground truncate">
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
                      <div className="text-xs font-medium text-muted-foreground mb-1">Source Node</div>
                      <PropertyList
                        items={
                          sourceNode && sourceNode.data
                            ? [
                                { key: "IRI", value: sourceNode.data.iri },
                                { key: "Label", value: sourceNode.data.label },
                                { key: "Display", value: sourceNode.data.displayPrefixed || sourceNode.data.displayShort },
                                { key: "Class", value: sourceNode.data.classType || sourceNode.data.displayclassType },
                                ...(Array.isArray(sourceNode.data.properties)
                                  ? (sourceNode.data.properties as Array<{ property: string; value: any }>).map((p) => ({
                                      key: String(p.property || ""),
                                      value: p.value,
                                    }))
                                  : []),
                              ]
                            : []
                        }
                        searchable={false}
                        maxHeight="max-h-36"
                      />
                    </div>

                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Target Node</div>
                      <PropertyList
                        items={
                          targetNode && targetNode.data
                            ? [
                                { key: "IRI", value: targetNode.data.iri },
                                { key: "Label", value: targetNode.data.label },
                                { key: "Display", value: targetNode.data.displayPrefixed || targetNode.data.displayShort },
                                { key: "Class", value: targetNode.data.classType || targetNode.data.displayclassType },
                                ...(Array.isArray(targetNode.data.properties)
                                  ? (targetNode.data.properties as Array<{ property: string; value: any }>).map((p) => ({
                                      key: String(p.property || ""),
                                      value: p.value,
                                    }))
                                  : []),
                              ]
                            : []
                        }
                        searchable={false}
                        maxHeight="max-h-36"
                      />
                    </div>
                  </div>

                  {Array.isArray(dataTyped.reasoningErrors) && dataTyped.reasoningErrors.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-destructive mb-1">Reasoning errors</div>
                      <ul className="text-xs text-destructive space-y-0.5">
                        {dataTyped.reasoningErrors.map((e: any, i: number) => (
                          <li key={i} className="truncate">{String(e)}</li>
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
