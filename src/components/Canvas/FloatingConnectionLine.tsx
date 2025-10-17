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
    <g className="edge-container">
      <path
        className="animated"
        d={edgePath}
      />
      <circle
        cx={tx || toX}
        cy={ty || toY}
        r={3}
        className="edge-connection-circle"
        onPointerDown={(ev: any) => {
          // Temporarily let the underlying node receive pointer events by disabling
          // pointer-events on the handle for the duration of the press. Restore on pointerup.
          try {
            const el = ev.currentTarget as HTMLElement;
            // Keep previous inline styles untouched where possible
            el.style.pointerEvents = "none";
            // Optionally lower z-index to ensure the node is above visually for the event
            el.style.zIndex = "0";
            const restore = () => {
              try {
                el.style.pointerEvents = "";
                el.style.zIndex = "";
              } catch (_) {
                // ignore
              }
            };
            // Restore once when pointer is released (capture to ensure we get it)
            window.addEventListener("pointerup", restore, { once: true, capture: true } as any);
          } catch (_) {
            // ignore any DOM errors
          }
        }}
      />
    </g>
  );
};

export default FloatingConnectionLine;
