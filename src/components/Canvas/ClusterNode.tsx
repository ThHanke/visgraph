import React, { memo, useCallback } from "react";
import { Handle, Position, NodeProps, useConnection } from "@xyflow/react";
import { cn } from "../../lib/utils";
import type { NodeData } from "../../types/canvas";

interface ClusterNodeData extends NodeData {
  clusterType: 'cluster';
  parentIri: string;
  nodeIds: string[];
  edgeIds: string[];
  nodeCount: number;
  color?: string;
  topTypes?: Array<{ type: string; count: number; color?: string }>;
}

function ClusterNodeImpl(props: NodeProps<ClusterNodeData>) {
  const { data, selected, id } = props;
  
  // Use connection state like RDFNode to conditionally show handles
  const connection = useConnection() as {
    inProgress?: boolean;
    fromNode?: { id?: string; measured?: { id?: string } };
  };

  const connectionInProgress = Boolean(connection?.inProgress);
  const connectionFromNodeId =
    connection?.fromNode?.id ??
    connection?.fromNode?.measured?.id ??
    "";
  
  const isTarget = Boolean(connectionInProgress && connectionFromNodeId && connectionFromNodeId !== String(id));
  // Match RDFNode: always show handles for edge connections
  const showHandles = !!(connectionInProgress || !selected);

  // Handle click: if already selected, expand; otherwise just select (React Flow handles that)
  const handleClick = useCallback((e: React.MouseEvent) => {
    // If already selected, trigger expansion and stop propagation
    if (selected) {
      e.stopPropagation();
      console.log('[ClusterNode] Second click detected, expanding cluster:', id);
      // Call global expand function exposed by KnowledgeCanvas
      if (typeof (window as any).__VG_EXPAND_CLUSTER === 'function') {
        (window as any).__VG_EXPAND_CLUSTER(String(id));
      }
    }
    // First click: let event bubble to React Flow for selection
  }, [selected, id]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Prevent double-click from opening editor
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Allow mouseDown to propagate so dragging works
    // but mark it as a cluster node interaction
  }, []);

  // Determine width based on whether we have type badges
  const hasTypes = data.topTypes && data.topTypes.length > 0;
  // Calculate dynamic width: base width + estimated badge widths
  // Each badge is roughly 60-80px depending on content
  const badgeCount = data.topTypes?.length || 0;
  const estimatedBadgeWidth = badgeCount > 0 ? badgeCount * 75 : 0;
  const nodeWidth = hasTypes ? Math.max(180, 100 + estimatedBadgeWidth) : 100;
  const nodeHeight = 70;

  return (
    <div
      className={cn(
        "cluster-node flex items-center justify-between cursor-pointer transition-all",
        "node-bg border-[3px] shadow-md px-4 gap-3",
        selected ? "ring-2 ring-primary shadow-lg" : ""
      )}
      style={{
        width: nodeWidth,
        height: nodeHeight,
        borderRadius: '35px',
        ['--node-color' as any]: data.color || '#6366f1',
        borderColor: data.color || '#6366f1',
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
    >
      {/* Left side: Node count */}
      <div className={cn(
        "text-center text-foreground select-none pointer-events-none",
        hasTypes ? "min-w-[50px]" : ""
      )}>
        <div className="text-2xl font-bold">
          {data.nodeCount}
        </div>
        <div className="text-[9px] mt-0.5">
          nodes
        </div>
      </div>
      
      {/* Right side: Type badges */}
      {hasTypes && (
        <div className="flex flex-col gap-1 items-end select-none pointer-events-none">
          {data.topTypes!.map((typeInfo, idx) => (
            <div
              key={idx}
              className="node-badge inline-block px-1.5 py-0.5 rounded-lg text-[8px] font-semibold whitespace-nowrap"
              style={{
                ['--node-color' as any]: typeInfo.color || 'rgba(255, 255, 255, 0.25)',
              }}
            >
              <span className="truncate text-foreground-dark">
                {typeInfo.type} ({typeInfo.count})
              </span>
            </div>
          ))}
        </div>
      )}
      
      {/* Both source and target handles covering the entire node */}
      {showHandles && (
        <Handle
          position={Position.Right}
          type="source"
          style={{
            width: `${nodeWidth}px`,
            height: `${nodeHeight}px`,
            borderRadius: '40px',
            left: '0',
            top: '0',
            transform: 'none',
            border: 'none',
            background: 'transparent',
            pointerEvents: 'all',
            opacity: 0,
          }}
        />
      )}
      {(showHandles || isTarget) && (
        <Handle
          position={Position.Left}
          type="target"
          isConnectableStart={false}
          style={{
            width: `${nodeWidth}px`,
            height: `${nodeHeight}px`,
            borderRadius: '40px',
            left: '0',
            top: '0',
            transform: 'none',
            border: 'none',
            background: 'transparent',
            pointerEvents: 'all',
            opacity: 0,
          }}
        />
      )}
    </div>
  );
}

export const ClusterNode = memo(ClusterNodeImpl);
ClusterNode.displayName = "ClusterNode";
