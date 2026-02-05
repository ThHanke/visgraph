import React, { memo } from "react";
import { 
  EdgeProps, 
  getBezierPath,
  EdgeLabelRenderer,
  BaseEdge,
  MarkerType,
} from "@xyflow/react";
import type { LinkData } from "../../types/canvas";

interface ClusterEdgeData extends LinkData {
  edgeType: 'cluster';
  aggregatedCount: number;
  originalEdgeIds: string[];
}

function ClusterEdgeImpl(props: EdgeProps<ClusterEdgeData>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
  } = props;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const aggregatedCount = data?.aggregatedCount || 1;
  const propertyLabel = data?.label || data?.propertyPrefixed || '';
  const showCount = aggregatedCount > 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd="url(#arrow)"
        style={{
          stroke: '#9ca3af',
          strokeWidth: 2,
        }}
      />
      
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
          className="nodrag nopan"
        >
          <div className="bg-primary text-primary-foreground px-2 py-1 rounded text-xs font-medium shadow-sm border border-primary/20">
            {propertyLabel && (
              <div style={{ marginBottom: showCount ? 2 : 0 }}>
                {propertyLabel}
              </div>
            )}
            {showCount && (
              <div className="text-xs font-semibold opacity-90">
                ×{aggregatedCount} edges
              </div>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
      
      {/* Arrow marker definition */}
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
        </marker>
      </defs>
    </>
  );
}

export const ClusterEdge = memo(ClusterEdgeImpl);
ClusterEdge.displayName = "ClusterEdge";

export default ClusterEdge;
