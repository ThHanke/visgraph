import React, { useCallback } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  Controls,
  Background,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import FloatingEdge from './FloatingEdge';

/**
 * Temporary mock component to display hard-coded nodes & edges using our custom edge type.
 * This bypasses the app's graph / RDF mapping and is intended for quick visual verification.
 */

const initialNodes = [
  { id: '1', data: { label: 'choose' }, position: { x: 0, y: 0 } },
  { id: '2', data: { label: 'your' }, position: { x: 200, y: 0 } },
  { id: '3', data: { label: 'desired' }, position: { x: 0, y: 120 } },
  { id: '4', data: { label: 'edge' }, position: { x: 200, y: 120 } },
  { id: '5', data: { label: 'type' }, position: { x: 0, y: 240 } },
];

const initialEdges = [
  { id: 'e1', type: 'floating', source: '1', target: '2', data: { label: 'floating' } },
  { id: 'e2', type: 'floating', source: '2', target: '3', data: { label: 'floating' } },
  { id: 'e3', type: 'floating', source: '3', target: '4', data: { label: 'floating' } },
  { id: 'e4', type: 'floating', source: '4', target: '5', data: { label: 'floating' } },
];

const MockEdgeFlow: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={{}}
        edgeTypes={{ floating: FloatingEdge }}
        fitView
      >
        <Controls />
        <Background gap={16} />
      </ReactFlow>
    </div>
  );
};

export default MockEdgeFlow;
