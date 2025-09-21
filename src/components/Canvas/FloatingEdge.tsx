import React, { memo } from "react";
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  BaseEdge,
  useInternalNode,
} from "@xyflow/react";
import { Badge } from "../ui/badge";
import { getEdgeParams } from "./EdgeParams";
import { useOntologyStore } from "../../stores/ontologyStore";
import { computeTermDisplay } from "../../utils/termUtils";

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
  const { id, source, target, markerEnd, style, data } = props;

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
  let badgeText = "";

  // 1) explicit label from props/data
  badgeText = String((props as any)?.label || (data as any)?.label || "").trim();

  // 2) if no explicit label, compute strict display via computeTermDisplay using RDF manager.
  //    Strict policy: if no rdf manager is available or computeTermDisplay fails, leave label empty.
  if (!badgeText) {
    try {
      const rawPred = (data as any)?.propertyUri || (data as any)?.propertyType || "";
      const ms = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : undefined;
      const rdfMgr =
        ms && typeof (ms as any).getRdfManager === "function"
          ? (ms as any).getRdfManager()
          : (ms && (ms as any).rdfManager)
          ? (ms as any).rdfManager
          : undefined;
      try {
        if (rdfMgr && rawPred) {
          const td = computeTermDisplay(String(rawPred), rdfMgr as any);
          badgeText = String(td.prefixed || td.short || "");
        } else {
          badgeText = "";
        }
      } catch (_) {
        badgeText = "";
      }
    } catch (_) {
      badgeText = "";
    }
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
          className="edge-label-renderer__custom-edge nodrag nopan"
        >
          {badgeText ? (
            <Badge
              variant="secondary"
              className="text-xs px-2 py-1 shadow-md border"
            >
              {badgeText}
            </Badge>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

FloatingEdge.displayName = "FloatingEdge";

export default FloatingEdge;
