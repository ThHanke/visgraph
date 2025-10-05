import React from "react";
import { getBezierPath } from "@xyflow/react";
import { getEdgeParams } from "./EdgeParams";

type Props = any;

const FloatingConnectionLine: React.FC<Props> = ({
  toX,
  toY,
  fromPosition,
  toPosition,
  fromNode,
}) => {
  if (!fromNode) {
    return null;
  }

  // Create a mock target node at the cursor position
  const targetNode = {
    id: "connection-target",
    measured: {
      width: 1,
      height: 1,
    },
    internals: {
      positionAbsolute: { x: toX, y: toY },
    },
  };

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    fromNode as any,
    targetNode as any,
  );

  const [edgePath] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos || fromPosition,
    targetPosition: targetPos || toPosition,
    targetX: tx || toX,
    targetY: ty || toY,
  });

  return (
    <g className="edge-container" style={{ color: 'hsl(var(--edge-default))' }}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="animated"
        d={edgePath}
      />
      <circle
        cx={tx || toX}
        cy={ty || toY}
        fill="currentColor"
        r={3}
        stroke="currentColor"
        strokeWidth={1.5}
      />
    </g>
  );
};

export default FloatingConnectionLine;
