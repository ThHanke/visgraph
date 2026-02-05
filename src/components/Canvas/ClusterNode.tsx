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

  return (
    <div
      className={cn(
        "cluster-node flex items-center justify-center cursor-pointer transition-all",
        selected ? "ring-4 ring-primary" : ""
      )}
      style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        backgroundColor: data.color || '#6366f1',
        border: '3px solid white',
        boxShadow: selected ? '0 4px 16px rgba(0,0,0,0.25)' : '0 4px 12px rgba(0,0,0,0.15)',
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
    >
      <div style={{ textAlign: 'center', color: 'white', userSelect: 'none', pointerEvents: 'none' }}>
        <div style={{ fontSize: 24, fontWeight: 'bold' }}>
          {data.nodeCount}
        </div>
        <div style={{ fontSize: 10, marginTop: 4 }}>
          nodes
        </div>
      </div>
      
      {/* Both source and target handles covering the entire circular node */}
      {showHandles && (
        <Handle
          position={Position.Right}
          type="source"
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
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
            width: '80px',
            height: '80px',
            borderRadius: '50%',
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
