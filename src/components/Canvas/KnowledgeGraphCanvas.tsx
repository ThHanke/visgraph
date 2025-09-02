import { useCallback, useState, useEffect } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { OntologyNode } from './OntologyNode';
import { PropertyEdge } from './PropertyEdge';
import { CanvasToolbar } from './CanvasToolbar';
import { NamespaceLegend } from './NamespaceLegend';
import { ReasoningIndicator } from './ReasoningIndicator';
import { ReasoningReportModal } from './ReasoningReportModal';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useReasoningStore } from '../../stores/reasoningStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { GraphExporter } from '../../utils/graphExporter';

const nodeTypes = {
  ontologyNode: OntologyNode,
};

const edgeTypes = {
  propertyEdge: PropertyEdge,
};

const initialNodes: Node[] = [
  {
    id: '1',
    type: 'ontologyNode',
    position: { x: 250, y: 150 },
    data: {
      classType: 'Person',
      individualName: 'John Doe',
      namespace: 'foaf',
      properties: {
        'foaf:name': 'John Doe',
        'foaf:age': '30'
      },
      errors: []
    }
  },
  {
    id: '2',
    type: 'ontologyNode',
    position: { x: 500, y: 150 },
    data: {
      classType: 'Organization',
      individualName: 'ACME Corp',
      namespace: 'org',
      properties: {
        'org:name': 'ACME Corp',
        'org:sector': 'Technology'
      },
      errors: []
    }
  }
];

const initialEdges: Edge[] = [
  {
    id: 'e1-2',
    source: '1',
    target: '2',
    type: 'propertyEdge',
    data: {
      propertyType: 'foaf:memberOf',
      label: 'member of',
      namespace: 'foaf'
    }
  }
];

export const KnowledgeGraphCanvas = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [showLegend, setShowLegend] = useState(true);
  const [showReasoningReport, setShowReasoningReport] = useState(false);
  const [viewMode, setViewMode] = useState<'abox' | 'tbox'>('abox');
  
  const { loadedOntologies } = useOntologyStore();
  const { startReasoning } = useReasoningStore();
  const { settings } = useSettingsStore();

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({
      ...params,
      type: 'propertyEdge',
      data: {
        propertyType: 'rdfs:relatedTo',
        label: 'related to',
        namespace: 'rdfs'
      }
    }, eds)),
    [setEdges]
  );

  const onAddNode = useCallback((classType: string, namespace: string) => {
    const newNode: Node = {
      id: `node-${Date.now()}`,
      type: 'ontologyNode',
      position: { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 },
      data: {
        classType,
        individualName: `${classType}_${Date.now()}`,
        namespace,
        properties: {},
        errors: []
      }
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes]);

  const handleExport = useCallback(async (format: 'turtle' | 'owl-xml' | 'json-ld') => {
    try {
      const { exportGraph } = await import('../../utils/graphExporter');
      const exportedData = await exportGraph(nodes as any, edges as any, format);
      
      // Create and download file
      const blob = new Blob([exportedData], { 
        type: format === 'json-ld' ? 'application/json' : 'text/plain' 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-graph.${format === 'owl-xml' ? 'owl' : format === 'json-ld' ? 'jsonld' : 'ttl'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
    }
  }, [nodes, edges]);

  // Auto-reasoning when graph changes
  useEffect(() => {
    if (settings.autoReasoning && nodes.length > 0) {
      const debounceTimer = setTimeout(() => {
        startReasoning(nodes, edges);
      }, 1000); // Debounce reasoning calls

      return () => clearTimeout(debounceTimer);
    }
  }, [nodes, edges, settings.autoReasoning, startReasoning]);

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
      <CanvasToolbar 
        onAddNode={onAddNode}
        onToggleLegend={() => setShowLegend(!showLegend)}
        showLegend={showLegend}
        onExport={handleExport}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
      
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        className="knowledge-graph-canvas"
        style={{ backgroundColor: 'hsl(var(--canvas-bg))' }}
        connectionLineStyle={{
          strokeWidth: 2,
          stroke: 'hsl(var(--primary))',
        }}
        defaultEdgeOptions={{
          type: 'propertyEdge',
          style: { strokeWidth: 2 },
        }}
      >
        <Background 
          variant={BackgroundVariant.Dots} 
          gap={20}
          size={1}
          color="hsl(var(--canvas-grid))"
        />
        <Controls className="!bg-card !border-border !shadow-glass" />
        <MiniMap 
          className="!bg-card !border-border !shadow-glass"
          nodeColor={(node) => {
            const namespace = node.data?.namespace || 'default';
            return `hsl(var(--ns-${namespace}))`;
          }}
        />
      </ReactFlow>

      {showLegend && (
        <NamespaceLegend 
          className="absolute top-20 right-4 z-10"
          namespaces={[
            { name: 'foaf', color: 'namespace-lavender', description: 'Friend of a Friend' },
            { name: 'org', color: 'namespace-mint', description: 'Organization Ontology' },
            { name: 'rdfs', color: 'namespace-peach', description: 'RDF Schema' },
            { name: 'owl', color: 'namespace-sky', description: 'Web Ontology Language' }
          ]}
        />
      )}

      <ReasoningIndicator onOpenReport={() => setShowReasoningReport(true)} />
      
      <ReasoningReportModal 
        open={showReasoningReport}
        onOpenChange={setShowReasoningReport}
      />
    </div>
  );
};