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
  const { id, source, target, style, data } = props;
  const dataTyped = data as LinkData;
  try { console.debug('[VG] FloatingEdge.render', { id, style }); } catch (_) { void 0; }


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

  const { edgeStyle, safeMarkerId, markerUrl, markerSize } = resolveEdgeRenderProps({ id, style, data });

  // 1) prefixed property from mapper -> props/data.propertyPrefixed
  badgeText = String((dataTyped as any)?.propertyPrefixed || (props as any)?.label || (dataTyped as any)?.label || "").trim();

  return (
    <>

      <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none', color: edgeStyle.color }} aria-hidden>
        <defs>
          <marker id={safeMarkerId} markerUnits="userSpaceOnUse" markerWidth={markerSize} markerHeight={markerSize} refX="6" refY="3" orient="auto" viewBox="0 0 6 6">
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
      </svg>
      <BaseEdge id={id} path={edgePath} markerEnd={markerUrl} style={edgeStyle} />
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
