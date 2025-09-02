import { useEffect, useRef, useState, useCallback } from 'react';
import * as go from 'gojs';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useReasoningStore } from '../../stores/reasoningStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { CanvasToolbar } from './CanvasToolbar';
import { NamespaceLegend } from './NamespaceLegend';
import { ReasoningIndicator } from './ReasoningIndicator';
import { ReasoningReportModal } from './ReasoningReportModal';
import { AutoComplete } from '../ui/AutoComplete';
import { Progress } from '../ui/progress';
import { NodePropertyEditor } from './NodePropertyEditor';
import { LinkPropertyEditor } from './LinkPropertyEditor';
import { toast } from 'sonner';

export const GoJSCanvas = () => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const diagramInstanceRef = useRef<go.Diagram | null>(null);
  const [showLegend, setShowLegend] = useState(true);
  const [showReasoningReport, setShowReasoningReport] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [showNodeEditor, setShowNodeEditor] = useState(false);
  const [showLinkEditor, setShowLinkEditor] = useState(false);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [selectedLink, setSelectedLink] = useState<any>(null);
  const [linkSourceNode, setLinkSourceNode] = useState<any>(null);
  const [linkTargetNode, setLinkTargetNode] = useState<any>(null);
  
  const { loadedOntologies, availableClasses, availableProperties, loadOntologyFromRDF, loadKnowledgeGraph } = useOntologyStore();
  const { startReasoning } = useReasoningStore();
  const { settings } = useSettingsStore();

  // Initialize GoJS diagram
  useEffect(() => {
    if (!diagramRef.current) return;

    const $ = go.GraphObject.make;
    
    const diagram = $(go.Diagram, diagramRef.current, {
      'undoManager.isEnabled': true,
      'toolManager.hoverDelay': 100,
      'animationManager.isEnabled': false,
      initialContentAlignment: go.Spot.Center,
      layout: $(go.ForceDirectedLayout, {
        defaultSpringLength: 120,
        defaultElectricalCharge: 200,
        maxIterations: 200,
        epsilonDistance: 0.5,
        infinityDistance: 1000
      }),
      model: new go.GraphLinksModel()
    });

    // Node template with proper namespace coloring
    diagram.nodeTemplate = $(go.Node, 'Auto',
      {
        locationSpot: go.Spot.Center,
        selectionAdornmentTemplate: $(go.Adornment, 'Auto',
          $(go.Shape, { fill: null, stroke: '#7c3aed', strokeWidth: 3 }),
          $(go.Placeholder)
        )
      },
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
      $(go.Shape, 'RoundedRectangle',
        {
          fill: '#ffffff',
          stroke: '#e2e8f0',
          strokeWidth: 2,
          minSize: new go.Size(140, 100),
          portId: '',
          fromLinkable: true,
          toLinkable: true,
          cursor: 'pointer'
        },
        new go.Binding('fill', 'namespace', (ns) => {
          const namespaceColors = {
            'foaf': '#f3f0ff',      // lavender
            'org': '#f0fdf4',       // mint  
            'rdfs': '#fef7ed',      // peach
            'owl': '#eff6ff',       // sky
            'iof': '#fdf2f8',       // rose
            'rdf': '#f0f9ff',       // aqua
            'skos': '#fefce8',      // honey
            'dc': '#fcf8ff',        // orchid
            'dct': '#f8fafc',       // powder
            'xsd': '#f0fdfa',       // seafoam
            'reasoning': '#fefce8', // light yellow for reasoning entities
            'default': '#ffffff'
          };
          return namespaceColors[ns as keyof typeof namespaceColors] || namespaceColors.default;
        }),
        new go.Binding('stroke', 'hasReasoningError', (hasError) => hasError ? '#ef4444' : '#e2e8f0'),
        new go.Binding('strokeWidth', 'hasReasoningError', (hasError) => hasError ? 3 : 2)
      ),
      $(go.Panel, 'Vertical',
        { margin: 8, alignment: go.Spot.Center },
        // Class type (larger, bold)
        $(go.TextBlock,
          {
            font: 'bold 13px Inter, sans-serif',
            stroke: '#1e293b',
            margin: new go.Margin(0, 0, 4, 0),
            maxSize: new go.Size(120, NaN),
            wrap: go.TextBlock.WrapFit,
            textAlign: 'center'
          },
          new go.Binding('text', 'classType', (type) => type || 'Thing'),
          new go.Binding('stroke', 'hasReasoningError', (hasError) => hasError ? '#dc2626' : '#1e293b')
        ),
        // Individual name (smaller, normal)
        $(go.TextBlock,
          {
            font: '11px Inter, sans-serif',
            stroke: '#64748b',
            margin: new go.Margin(0, 0, 6, 0),
            maxSize: new go.Size(120, NaN),
            wrap: go.TextBlock.WrapFit,
            textAlign: 'center'
          },
          new go.Binding('text', 'individualName', (name) => name || ''),
          new go.Binding('visible', 'individualName', (name) => !!name)
        ),
        // Namespace badge
        $(go.TextBlock,
          {
            font: '9px Inter, sans-serif',
            stroke: '#475569',
            margin: new go.Margin(2, 6, 6, 6),
            background: '#f1f5f9'
          },
          new go.Binding('text', 'namespace', (ns) => ns || 'default'),
          new go.Binding('visible', 'namespace', (ns) => !!ns)
        ),
        // Literal properties (smaller text)
        $(go.Panel, 'Vertical',
          { 
            maxSize: new go.Size(120, 60),
            itemTemplate: $(go.Panel, 'Horizontal',
              { margin: new go.Margin(1, 0, 1, 0) },
              $(go.TextBlock, 
                { 
                  font: '9px Inter, sans-serif', 
                  stroke: '#64748b',
                  maxSize: new go.Size(120, NaN),
                  wrap: go.TextBlock.WrapFit
                },
                new go.Binding('text', '', (prop) => `${prop.key}: ${prop.value}`)
              )
            )
          },
          new go.Binding('itemArray', 'literalProperties', (props) => props || [])
        )
      )
    );

    // Link template with proper labels
    diagram.linkTemplate = $(go.Link,
      {
        routing: go.Link.AvoidsNodes,
        curve: go.Link.JumpOver,
        corner: 5,
        selectionAdornmentTemplate: $(go.Adornment, 'Link',
          $(go.Shape, { isPanelMain: true, stroke: '#7c3aed', strokeWidth: 3 }),
          $(go.Shape, { toArrow: 'Standard', fill: '#7c3aed', stroke: null })
        )
      },
      $(go.Shape, { strokeWidth: 2, stroke: '#64748b' }),
      $(go.Shape, { toArrow: 'Standard', fill: '#64748b', stroke: null }),
      $(go.TextBlock,
        {
          segmentIndex: 0,
          segmentFraction: 0.5,
          background: '#ffffff',
          font: '10px Inter, sans-serif',
          stroke: '#1e293b',
          margin: new go.Margin(2, 4, 2, 4),
          maxSize: new go.Size(150, NaN),
          wrap: go.TextBlock.WrapFit,
          textAlign: 'center'
        },
        new go.Binding('text', 'label', (label) => label || 'related'),
        new go.Binding('visible', 'label', (label) => !!label)
      )
    );

    // Add event listeners
    diagram.addDiagramListener('Modified', () => {
      if (settings.autoReasoning) {
        const nodes = diagram.model.nodeDataArray;
        const links = (diagram.model as go.GraphLinksModel).linkDataArray;
        startReasoning(nodes, links).then((result) => {
          // Mark nodes with reasoning errors
          if (result.errors.length > 0) {
            result.errors.forEach(error => {
              if (error.nodeId) {
                const node = diagram.findNodeForKey(error.nodeId);
                if (node) {
                  diagram.model.setDataProperty(node.data, 'hasReasoningError', true);
                }
              }
            });
          }
        });
      }
    });

    // Enable linking tool for creating connections
    diagram.toolManager.linkingTool.temporaryLink.routing = go.Link.Orthogonal;
    diagram.toolManager.linkingTool.temporaryLink.curve = go.Link.JumpOver;
    diagram.toolManager.relinkingTool.isEnabled = true;

    // Add double-click listeners for editing
    diagram.addDiagramListener('ObjectDoubleClicked', (e) => {
      const obj = e.subject.part;
      if (obj instanceof go.Node) {
        setSelectedNode(obj.data);
        setShowNodeEditor(true);
      } else if (obj instanceof go.Link) {
        const sourceNode = obj.fromNode?.data;
        const targetNode = obj.toNode?.data;
        setSelectedLink(obj.data);
        setLinkSourceNode(sourceNode);
        setLinkTargetNode(targetNode);
        setShowLinkEditor(true);
      }
    });

    // Handle new link creation
    diagram.addDiagramListener('LinkDrawn', (e) => {
      const link = e.subject;
      const sourceNode = link.fromNode?.data;
      const targetNode = link.toNode?.data;
      
      if (sourceNode && targetNode) {
        setSelectedLink(link.data);
        setLinkSourceNode(sourceNode);
        setLinkTargetNode(targetNode);
        setShowLinkEditor(true);
      }
    });

    diagramInstanceRef.current = diagram;

    return () => {
      diagram.div = null;
    };
  }, []);

  // Update diagram when currentGraph changes
  useEffect(() => {
    const diagram = diagramInstanceRef.current;
    if (!diagram || !loadedOntologies.length) return;

    const { currentGraph } = useOntologyStore.getState();
    if (currentGraph.nodes.length > 0 || currentGraph.edges.length > 0) {
      // Use a timeout to ensure any pending transactions are finished
      setTimeout(() => {
        // Convert parsed nodes to GoJS format
        const goNodes = currentGraph.nodes.map(node => ({
          key: node.id,
          classType: node.classType,
          individualName: node.individualName,
          namespace: node.namespace,
          literalProperties: node.literalProperties || [],
          loc: node.position ? `${node.position.x} ${node.position.y}` : `${Math.random() * 800} ${Math.random() * 600}`
        }));
        
        // Convert parsed edges to GoJS format
        const goLinks = currentGraph.edges.map(edge => ({
          from: edge.source,
          to: edge.target,
          label: edge.label,
          propertyType: edge.propertyType,
          namespace: edge.namespace
        }));
        
        // Set model without transaction since we're replacing the entire model
        diagram.model = new go.GraphLinksModel(goNodes, goLinks);
      }, 100);
    }
  }, [loadedOntologies]);

  // Load demo file on startup
  useEffect(() => {
    const loadDemoFile = async () => {
      if (settings.startupFileUrl) {
        setIsLoading(true);
        setLoadingMessage('Loading demo knowledge graph...');
        setLoadingProgress(10);
        
        try {
          await loadKnowledgeGraph(settings.startupFileUrl, {
            onProgress: (progress, message) => {
              setLoadingProgress(progress);
              setLoadingMessage(message);
            }
          });
          toast.success('Demo knowledge graph loaded successfully');
        } catch (error) {
          toast.error('Failed to load demo file');
          console.error(error);
        } finally {
          setIsLoading(false);
          setLoadingProgress(0);
          setLoadingMessage('');
        }
      }
    };

    loadDemoFile();
  }, [settings.startupFileUrl, loadKnowledgeGraph]);

  const onAddNode = useCallback((classType: string, namespace: string) => {
    if (!diagramInstanceRef.current) return;

    const diagram = diagramInstanceRef.current;
    diagram.startTransaction('add node');
    
    const nodeData = {
      key: `node-${Date.now()}`,
      classType,
      individualName: `${classType}_${Date.now()}`,
      namespace,
      literalProperties: [],
      loc: '0 0'
    };
    
    diagram.model.addNodeData(nodeData);
    diagram.commitTransaction('add node');
  }, []);

  const onLoadFile = useCallback(async (file: File) => {
    setIsLoading(true);
    setLoadingMessage('Reading file...');
    setLoadingProgress(10);
    
    try {
      const text = await file.text();
      setLoadingMessage('Parsing RDF...');
      setLoadingProgress(30);
      
      await loadKnowledgeGraph(text, {
        onProgress: (progress, message) => {
          setLoadingProgress(Math.max(progress, 30));
          setLoadingMessage(message);
        }
      });
      
      toast.success('Knowledge graph loaded successfully');
    } catch (error) {
      toast.error('Failed to load file');
      console.error(error);
    } finally {
      setIsLoading(false);
      setLoadingProgress(0);
      setLoadingMessage('');
    }
  }, [loadKnowledgeGraph]);

  const handleSaveNodeProperties = useCallback((properties: any[]) => {
    if (!diagramInstanceRef.current || !selectedNode) return;

    const diagram = diagramInstanceRef.current;
    diagram.startTransaction('update node properties');
    
    const node = diagram.findNodeForKey(selectedNode.key);
    if (node) {
      diagram.model.setDataProperty(node.data, 'literalProperties', properties);
    }
    
    diagram.commitTransaction('update node properties');
  }, [selectedNode]);

  const handleSaveLinkProperty = useCallback((propertyType: string, label: string) => {
    if (!diagramInstanceRef.current || !selectedLink) return;

    const diagram = diagramInstanceRef.current;
    diagram.startTransaction('update link property');
    
    const link = diagram.findLinkForKey(selectedLink.key || '');
    if (link) {
      diagram.model.setDataProperty(link.data, 'propertyType', propertyType);
      diagram.model.setDataProperty(link.data, 'label', label);
    }
    
    diagram.commitTransaction('update link property');
  }, [selectedLink]);

  const handleExport = useCallback(async (format: 'turtle' | 'owl-xml' | 'json-ld') => {
    if (!diagramInstanceRef.current) return;
    
    const diagram = diagramInstanceRef.current;
    const nodes = diagram.model.nodeDataArray;
    const links = (diagram.model as go.GraphLinksModel).linkDataArray;
    
    try {
      const { exportGraph } = await import('../../utils/graphExporter');
      // Convert GoJS data to our expected format
      const goJSNodes = nodes.map(node => ({
        key: node.key || node.id || `node-${Math.random()}`,
        classType: node.classType || 'Thing',
        individualName: node.individualName || node.key || 'Individual',
        namespace: node.namespace || 'default',
        literalProperties: node.literalProperties || []
      }));
      
      const goJSLinks = links.map(link => ({
        from: link.from || link.source,
        to: link.to || link.target,
        label: link.label || 'related',
        propertyType: link.propertyType || 'owl:related',
        namespace: link.namespace || 'owl'
      }));
      
      const exportedData = await exportGraph(goJSNodes, goJSLinks, format);
      
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
      
      toast.success(`Graph exported as ${format.toUpperCase()}`);
    } catch (error) {
      toast.error('Export failed');
      console.error('Export error:', error);
    }
  }, []);

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
      <CanvasToolbar 
        onAddNode={onAddNode}
        onToggleLegend={() => setShowLegend(!showLegend)}
        showLegend={showLegend}
        onExport={handleExport}
        onLoadFile={onLoadFile}
      />
      
      {isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-50 bg-card p-4 rounded-lg shadow-lg min-w-96">
          <div className="space-y-2">
            <div className="text-sm font-medium">{loadingMessage}</div>
            <Progress value={loadingProgress} className="w-full" />
            <div className="text-xs text-muted-foreground">{loadingProgress}%</div>
          </div>
        </div>
      )}
      
      <div
        ref={diagramRef}
        className="w-full h-full"
        style={{ backgroundColor: 'hsl(var(--canvas-bg))' }}
      />

      {showLegend && (
        <NamespaceLegend 
          className="absolute top-20 right-4 z-10"
          namespaces={[
            { name: 'foaf', color: '#f3f0ff', description: 'Friend of a Friend' },
            { name: 'org', color: '#f0fdf4', description: 'Organization Ontology' },
            { name: 'rdfs', color: '#fef7ed', description: 'RDF Schema' },
            { name: 'owl', color: '#eff6ff', description: 'Web Ontology Language' },
            { name: 'iof', color: '#fdf2f8', description: 'Industrial Ontologies Foundry' },
            { name: 'rdf', color: '#f0f9ff', description: 'Resource Description Framework' },
            { name: 'skos', color: '#fefce8', description: 'Simple Knowledge Organization System' },
            { name: 'dc', color: '#fcf8ff', description: 'Dublin Core' },
            { name: 'reasoning', color: '#fefce8', description: 'Reasoning Results' }
          ]}
        />
      )}

      <ReasoningIndicator onOpenReport={() => setShowReasoningReport(true)} />
      
      <ReasoningReportModal 
        open={showReasoningReport}
        onOpenChange={setShowReasoningReport}
      />

      <NodePropertyEditor
        open={showNodeEditor}
        onOpenChange={setShowNodeEditor}
        nodeData={selectedNode}
        onSave={handleSaveNodeProperties}
      />

      <LinkPropertyEditor
        open={showLinkEditor}
        onOpenChange={setShowLinkEditor}
        linkData={selectedLink}
        sourceNode={linkSourceNode}
        targetNode={linkTargetNode}
        onSave={handleSaveLinkProperty}
      />
    </div>
  );
};