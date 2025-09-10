import React, { memo } from 'react';
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  useInternalNode,
} from '@xyflow/react';
import { Badge } from '../ui/badge';
import { debug } from '../../utils/startupDebug';
import { getEdgeParams } from './floatingInitialElements';

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

  try {
    debug('floatingEdge.internalNodes', {
      id,
      source,
      target,
      sourceNodePresent: !!sourceNode,
      targetNodePresent: !!targetNode,
      sPos: sourceNode?.internals?.positionAbsolute || sourceNode?.position || null,
      tPos: targetNode?.internals?.positionAbsolute || targetNode?.position || null
    });
  } catch (_) { /* ignore debug failures */ }

  // Wait until React Flow has measured the nodes and provided internals.
  if (!sourceNode || !targetNode) {
    try { debug('floatingEdge.waitingInternals', { id, source, target }); } catch (_) { /* ignore */ }
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);
  try { debug('floatingEdge.params', { sx, sy, tx, ty, sourcePos, targetPos }); } catch (_) { /* ignore */ }

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos as any,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos as any,
    curvature: 0.25,
  });
  try { debug('floatingEdge.path', { edgePathLength: edgePath.length, labelX, labelY }); } catch (_) { /* ignore */ }

  const badgeText = (data as any)?.label || (data as any)?.propertyType || '';

  return (
    <>
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
        style={style}
      />

      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-auto"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
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
