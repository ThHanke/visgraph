import React, { memo } from 'react';
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  BaseEdge,
  useInternalNode,
} from '@xyflow/react';
import { Badge } from '../ui/badge';
import { debug } from '../../utils/startupDebug';
import { getEdgeParams } from './EdgeParams';

/**
 * FloatingEdge (docs-style)
 *
 * This implementation strictly follows the React Flow example:
 *  - rely on useInternalNode(source/target)
 *  - return null until both internals are available
 *  - compute anchors with getEdgeParams(...)
 *  - call getBezierPath(...) and render a single <path> for the edge
 *  - use the provided markerEnd and style props (do not create per-edge <defs>)
 *
 * The EdgeLabelRenderer remains to show a badge at the computed label coordinates.
 */

const FloatingEdge = memo((props: EdgeProps) => {
  const {
    id,
    source,
    target,
    markerEnd,
    style,
    data,
  } = props;

  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);


  // Wait until React Flow has measured the nodes and provided internals.
  if (!sourceNode || !targetNode) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos as any,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos as any,
    curvature: 0.25,
  });
  const badgeText = (props as any)?.label || (data as any)?.label || (data as any)?.propertyType || '';

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
            <Badge variant="secondary" className="text-xs px-2 py-1 shadow-md border">
              {badgeText}
            </Badge>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

FloatingEdge.displayName = 'FloatingEdge';

export default FloatingEdge;
