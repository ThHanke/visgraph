import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as go from 'gojs';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useReasoningStore } from '../../stores/reasoningStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { CanvasToolbar } from './CanvasToolbar';
import { ResizableNamespaceLegend } from './ResizableNamespaceLegend';
import { ReasoningIndicator } from './ReasoningIndicator';
import { ReasoningReportModal } from './ReasoningReportModal';
import { AutoComplete } from '../ui/AutoComplete';
import { Progress } from '../ui/progress';
import { NodePropertyEditor } from './NodePropertyEditor';
import { LinkPropertyEditor } from './LinkPropertyEditor';
import { toast } from 'sonner';
import { AnnotationPropertyDialog } from './AnnotationPropertyDialog';

export const GoJSCanvas = () => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const diagramInstanceRef = useRef<go.Diagram | null>(null);
  const [showLegend, setShowLegend] = useState(false);
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
  const [viewMode, setViewMode] = useState<'abox' | 'tbox'>('abox');
  
  const { loadedOntologies, availableClasses, availableProperties, loadOntologyFromRDF, loadKnowledgeGraph, exportGraph, updateEntity } = useOntologyStore();
  
  // Get all entities for autocomplete
  const allEntities = loadedOntologies.flatMap(ontology => [
    ...ontology.classes.map(cls => ({
      uri: cls.uri,
      label: cls.label,
      namespace: cls.namespace,
      rdfType: 'owl:Class' as const,
      description: `Class from ${ontology.name}`
    })),
    ...ontology.properties.map(prop => ({
      uri: prop.uri,
      label: prop.label,
      namespace: prop.namespace,
      rdfType: prop.uri.includes('ObjectProperty') ? 'owl:ObjectProperty' : 'owl:AnnotationProperty' as const,
      description: `Property from ${ontology.name}`
    }))
  ]);
  const { startReasoning } = useReasoningStore();
  const { settings, updateSettings, isHydrated } = useSettingsStore();

  // Helper function to get GoJS layout by type
  const getLayoutByType = useCallback((layoutType: string) => {
    const $ = go.GraphObject.make;
    
    switch (layoutType) {
      case 'force':
        return $(go.ForceDirectedLayout, {
          defaultSpringLength: 120,
          defaultElectricalCharge: 200,
          maxIterations: 200,
          epsilonDistance: 0.5,
          infinityDistance: 1000
        });
      case 'layered':
        return $(go.LayeredDigraphLayout, {
          direction: 0,
          layerSpacing: 50,
          columnSpacing: 20
        });
      case 'hierarchical':
        return $(go.TreeLayout, {
          angle: 90,
          layerSpacing: 50,
          nodeSpacing: 20
        });
      case 'tree':
        return $(go.TreeLayout, {
          angle: 0,
          layerSpacing: 50,
          nodeSpacing: 20
        });
      case 'circular':
        return $(go.CircularLayout, {
          radius: 200,
          spacing: 50
        });
      case 'grid':
        return $(go.GridLayout, {
          cellSize: new go.Size(200, 150),
          spacing: new go.Size(10, 10)
        });
      default:
        return $(go.ForceDirectedLayout, {
          defaultSpringLength: 120,
          defaultElectricalCharge: 200,
          maxIterations: 200
        });
    }
  }, []);

  // Function to change layout and save to settings
  const changeLayout = useCallback((layoutType: 'force' | 'hierarchical' | 'circular' | 'grid' | 'tree' | 'layered') => {
    const diagram = diagramInstanceRef.current;
    if (!diagram) return;

    // Save to settings
    updateSettings({ layoutAlgorithm: layoutType });

    // Apply layout to diagram
    diagram.startTransaction('change layout');
    diagram.layout = getLayoutByType(layoutType);
    diagram.commitTransaction('change layout');
    diagram.layoutDiagram(true);
  }, [getLayoutByType, updateSettings]);

  // Initialize with proper filtering
  useEffect(() => {
    const diagram = diagramInstanceRef.current;
    if (!diagram) return;

    // Force initial filtering when view mode or data changes
    setTimeout(() => {
      filterNodesByViewMode();
    }, 100);
  }, [viewMode, loadedOntologies]);

  const filterNodesByViewMode = useCallback(() => {
    const diagram = diagramInstanceRef.current;
    if (!diagram) return;

    diagram.startTransaction('update view mode');
    diagram.nodes.each(node => {
      const data = node.data;
      // T-box: entities with rdf:type Class, ObjectProperty, AnnotationProperty, or DatatypeProperty
      const isTBoxEntity = data.rdfTypes && data.rdfTypes.some((type: string) => 
        type.includes('Class') || 
        type.includes('ObjectProperty') || 
        type.includes('AnnotationProperty') || 
        type.includes('DatatypeProperty')
      );
      const shouldShow = viewMode === 'tbox' ? isTBoxEntity : !isTBoxEntity;
      diagram.model.setDataProperty(data, 'visible', shouldShow);
    });
    diagram.commitTransaction('update view mode');
  }, [viewMode]);

  // Initialize GoJS diagram - wait for settings to be hydrated  
  useEffect(() => {
    if (!diagramRef.current || !isHydrated) {
      console.log('Waiting for diagram ref or settings hydration...', { hasRef: !!diagramRef.current, isHydrated });
      return;
    }

    const $ = go.GraphObject.make;
    
    try {
      const layoutAlgorithm = settings.layoutAlgorithm || 'layered';
      console.log(`Initializing diagram with layout: ${layoutAlgorithm}`);
      
      const diagram = $(go.Diagram, diagramRef.current, {
        'undoManager.isEnabled': true,
        'toolManager.hoverDelay': 100,
        'animationManager.isEnabled': false,
        initialContentAlignment: go.Spot.Center,
        layout: getLayoutByType(layoutAlgorithm),
        model: new go.GraphLinksModel()
      });

    // Helper function to get namespace color
    const getNamespaceColor = (namespace: string) => {
      const namespaceColors = {
        'foaf': '#9333ea',
        'org': '#059669',
        'rdfs': '#f59e0b',
        'owl': '#0ea5e9',
        'rdf': '#0891b2',
        'skos': '#d97706',
        'dc': '#a855f7',
        'dct': '#6366f1',
        'xsd': '#06b6d4',
        'iof': '#ec4899',
        ':': '#ec4899',
        'reasoning': '#eab308',
        'default': '#64748b'
      };
      return namespaceColors[namespace as keyof typeof namespaceColors] || namespaceColors.default;
    };

    // Node template - using proper GoJS structure
    diagram.nodeTemplate = $(go.Node, 'Auto',
      { selectionAdorned: true, resizable: true },

      // Main auto panel with rounded border
      $(go.Shape, 'RoundedRectangle',
        { fill: 'white', stroke: '#888', strokeWidth: 1 },
        new go.Binding('fill', '', (data) => data.backgroundColor || 'white'),
        new go.Binding('stroke', '', (data) => {
          if (data.hasValidationErrors) return '#ef4444';
          return getNamespaceColor(data.namespace) || '#888';
        })
      ),

      $(go.Panel, 'Vertical',
        { stretch: go.GraphObject.Fill },

        // Integrated header inside nested Auto panel
        $(go.Panel, 'Auto',
          {
            stretch: go.GraphObject.Horizontal,
          },
          new go.Binding('background', '', (data) => {
            const color = getNamespaceColor(data.namespace);
            return color || '#2E8B57';
          }),
          $(go.Shape, 'Rectangle', { fill: null, stroke: null }),
          $(go.TextBlock,
            {
              margin: new go.Margin(6, 8),
              font: 'bold 12px Inter, sans-serif',
              stroke: 'white'
            },
            new go.Binding('text', '', (data) => {
              const uri = data.uri || data.iri;
              let shortUri = 'unknown';
              if (uri) {
                const parts = uri.split(/[/#]/);
                shortUri = parts[parts.length - 1] || parts[parts.length - 2] || uri;
              }

              let type = '';
              // For A-box view, show the actual semantic type (e.g., iof:MeasurementProcess)
              if (data.entityType === 'individual' && data.rdfTypes) {
                const meaningfulType = data.rdfTypes.find((t: string) => 
                  !t.includes('NamedIndividual')
                );
                if (meaningfulType) {
                  const prefixMap = {
                    'https://spec.industrialontologies.org/ontology/core/Core/': 'iof:',
                    'http://www.w3.org/2002/07/owl#': 'owl:',
                    'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
                    'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
                    'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/': ':'
                  };
                  
                  for (const [namespace, prefix] of Object.entries(prefixMap)) {
                    if (meaningfulType.startsWith(namespace)) {
                      type = meaningfulType.replace(namespace, prefix);
                      break;
                    }
                  }
                  if (!type) type = meaningfulType;
                }
              } else {
                type = data.rdfType || 'unknown:type';
              }

              return `${shortUri} — ${type}`;
            })
          )
        ),

        // Body: table of annotations
        $(go.Panel, 'Table',
          {
            stretch: go.GraphObject.Fill,
            defaultRowSeparatorStroke: '#ddd',
            padding: 6
          },
          new go.Binding('itemArray', '', (data) => {
            const annotations = [];
            
            if (data.annotationProperties) {
              data.annotationProperties.forEach((prop: any) => {
                annotations.push({
                  key: prop.property,
                  value: prop.value
                });
              });
            }
            
            return annotations.slice(0, 5); // Limit to 5 properties
          }),
          {
            itemTemplate:
              $(go.Panel, 'TableRow',
                $(go.TextBlock,
                  {
                    column: 0,
                    margin: 2,
                    font: '11px Inter, sans-serif',
                    stroke: '#333',
                    alignment: go.Spot.Left,
                    maxSize: new go.Size(80, NaN),
                    overflow: go.TextOverflow.Ellipsis
                  },
                  new go.Binding('text', 'key')
                ),
                $(go.TextBlock,
                  {
                    column: 1,
                    margin: 2,
                    font: '11px Inter, sans-serif',
                    stroke: '#555',
                    alignment: go.Spot.Left,
                    maxSize: new go.Size(120, NaN),
                    overflow: go.TextOverflow.Ellipsis
                  },
                  new go.Binding('text', 'value')
                )
              )
          }
        )
      ),

      // Double-click to edit
      {
        doubleClick: (e, obj) => {
          const nodeData = obj.part?.data;
          if (nodeData) {
            console.log('Node template double-clicked, nodeData:', nodeData);
            setSelectedNode(nodeData);
            setShowNodeEditor(true);
          }
        }
      },

      // Add location binding
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
      new go.Binding('visible', 'visible', (vis) => vis !== false)
    );

    // Link template with proper labels and hover effects
    diagram.linkTemplate = $(go.Link,
      {
        routing: go.Link.AvoidsNodes,
        curve: go.Link.JumpOver,
        corner: 5,
        selectionAdornmentTemplate: $(go.Adornment, 'Link',
          $(go.Shape, { isPanelMain: true, stroke: '#7c3aed', strokeWidth: 3 }),
          $(go.Shape, { toArrow: 'Standard', fill: '#7c3aed', stroke: null })
        ),
        toolTip: $(go.Adornment, 'Auto',
          $(go.Shape, { fill: '#fefce8', stroke: '#facc15', strokeWidth: 2 }),
          $(go.Panel, 'Vertical',
            { margin: 8 },
            $(go.TextBlock, 
              { 
                font: 'bold 11px Inter, sans-serif',
                stroke: '#a16207',
                maxSize: new go.Size(250, NaN),
                wrap: go.TextBlock.WrapFit
              },
              new go.Binding('text', 'propertyUri', (uri) => `Property: ${uri || 'unknown'}`)
            ),
            $(go.TextBlock, 
              { 
                font: '10px Inter, sans-serif',
                stroke: '#a16207',
                margin: new go.Margin(2, 0, 0, 0),
                maxSize: new go.Size(250, NaN),
                wrap: go.TextBlock.WrapFit
              },
              new go.Binding('text', 'rdfType', (type) => `RDF Type: ${type || 'unknown'}`)
            )
          )
        ),
        // Add mouse enter/leave for highlighting
        mouseEnter: (e, obj) => {
          const link = obj.part as go.Link;
          if (link) {
            const shape = link.findObject('SHAPE') as go.Shape;
            const arrow = link.findObject('ARROWHEAD') as go.Shape;
            const label = link.findObject('LABEL') as go.TextBlock;
            
            if (shape) shape.stroke = '#7c3aed';
            if (shape) shape.strokeWidth = 3;
            if (arrow) arrow.fill = '#7c3aed';
            if (label) label.background = '#e0e7ff';
            (diagram.div as any).style.cursor = 'pointer';
          }
        },
        mouseLeave: (e, obj) => {
          const link = obj.part as go.Link;
          if (link) {
            const hasError = link.data.hasReasoningError;
            const shape = link.findObject('SHAPE') as go.Shape;
            const arrow = link.findObject('ARROWHEAD') as go.Shape;
            const label = link.findObject('LABEL') as go.TextBlock;
            
            if (shape) shape.stroke = hasError ? '#ef4444' : '#64748b';
            if (shape) shape.strokeWidth = 2;
            if (arrow) arrow.fill = hasError ? '#ef4444' : '#64748b';
            if (label) label.background = '#ffffff';
            (diagram.div as any).style.cursor = 'auto';
          }
        }
      },
      $(go.Shape, 
        { 
          name: 'SHAPE',
          strokeWidth: 2, 
          stroke: '#64748b' 
        },
        new go.Binding('stroke', 'hasReasoningError', (hasError) => hasError ? '#ef4444' : '#64748b')
      ),
      $(go.Shape, 
        { 
          name: 'ARROWHEAD',
          toArrow: 'Standard', 
          fill: '#64748b', 
          stroke: null 
        },
        new go.Binding('fill', 'hasReasoningError', (hasError) => hasError ? '#ef4444' : '#64748b')
      ),
      $(go.TextBlock,
        {
          name: 'LABEL',
          segmentIndex: 0,
          segmentFraction: 0.5,
          segmentOffset: new go.Point(0, -10),
          background: 'rgba(255, 255, 255, 0.9)',
          font: '10px Inter, sans-serif',
          stroke: '#1e293b',
          margin: new go.Margin(3, 6, 3, 6),
          maxSize: new go.Size(120, NaN),
          wrap: go.TextBlock.WrapFit,
          textAlign: 'center',
          editable: false
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
          diagram.startTransaction('update reasoning errors');
          // Clear previous error markings
          nodes.forEach(node => {
            diagram.model.setDataProperty(node, 'hasReasoningError', false);
          });
          
          // Mark nodes and edges with reasoning errors
          if (result.errors.length > 0) {
            result.errors.forEach(error => {
              if (error.nodeId) {
                const node = diagram.findNodeForKey(error.nodeId);
                if (node) {
                  diagram.model.setDataProperty(node.data, 'hasReasoningError', true);
                }
              }
              if (error.edgeId) {
                const link = diagram.findLinkForKey(error.edgeId);
                if (link) {
                  diagram.model.setDataProperty(link.data, 'hasReasoningError', true);
                }
              }
            });
          }
          diagram.commitTransaction('update reasoning errors');
        }).catch(error => {
          console.error('Reasoning failed:', error);
        });
      }
    });

    // Apply initial view filtering
    setTimeout(() => {
      diagram.startTransaction('initial filter');
      diagram.nodes.each(node => {
        const data = node.data;
        const isTBoxEntity = data.rdfType && (
          data.rdfType.includes('Class') || 
          data.rdfType.includes('ObjectProperty') || 
          data.rdfType.includes('AnnotationProperty') || 
          data.rdfType.includes('DatatypeProperty')
        );
        const shouldShow = viewMode === 'tbox' ? isTBoxEntity : !isTBoxEntity;
        diagram.model.setDataProperty(data, 'visible', shouldShow);
      });
      diagram.commitTransaction('initial filter');
    }, 200);

    // Enable linking tool for creating connections
    diagram.toolManager.linkingTool.temporaryLink.routing = go.Link.Orthogonal;
    diagram.toolManager.linkingTool.temporaryLink.curve = go.Link.JumpOver;
    diagram.toolManager.relinkingTool.isEnabled = true;

    // Add double-click listeners for editing
    diagram.addDiagramListener('ObjectDoubleClicked', (e) => {
      const obj = e.subject.part;
      if (obj instanceof go.Node) {
        console.log('Node double-clicked, obj.data:', obj.data);
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
        const goNodes = currentGraph.nodes.map(node => {
          // Filter out owl:NamedIndividual for display purposes
          const meaningfulTypes = (node.rdfTypes || [node.rdfType]).filter(type => 
            type && !type.includes('NamedIndividual')
          );
          const displayType = meaningfulTypes.length > 0 ? meaningfulTypes[0] : node.rdfType;
          
          return {
            key: node.id,
            uri: node.uri,
            localName: node.individualName,
            label: node.annotationProperties?.find(p => p.propertyUri.includes('label'))?.value || node.individualName,
            classType: node.classType,
            individualName: node.individualName,
            namespace: node.namespace,
            rdfType: node.rdfType,
            rdfTypes: node.rdfTypes || [node.rdfType],
            displayType,
            entityType: node.entityType || 'individual',
            literalProperties: node.literalProperties || [],
            annotationProperties: node.annotationProperties || [],
            loc: node.position ? `${node.position.x} ${node.position.y}` : `${Math.random() * 800} ${Math.random() * 600}`,
            visible: true
          };
        });
        
        // Convert parsed edges to GoJS format
        const goLinks = currentGraph.edges.map(edge => ({
          from: edge.source,
          to: edge.target,
          label: edge.label,
          propertyType: edge.propertyType,
          propertyUri: edge.propertyUri,
          namespace: edge.namespace,
          rdfType: edge.rdfType
        }));
        
        // Set model without transaction since we're replacing the entire model
        diagram.model = new go.GraphLinksModel(goNodes, goLinks);
        
        // Apply initial filtering after model is set
        setTimeout(() => {
          filterNodesByViewMode();
        }, 50);
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

  const onAddNode = useCallback((entityUri: string) => {
    if (!diagramInstanceRef.current) return;

    const diagram = diagramInstanceRef.current;
    const entity = allEntities.find(e => e.uri === entityUri);
    if (!entity) return;

    diagram.startTransaction('add node');
    
    const nodeData = {
      key: `node-${Date.now()}`,
      uri: entity.uri,
      classType: entity.label,
      individualName: `${entity.label}_${Date.now()}`,
      namespace: entity.namespace,
      rdfType: entity.rdfType,
      entityType: entity.rdfType === 'owl:Class' ? 'class' : 'individual',
      literalProperties: [],
      annotationProperties: [],
      loc: '0 0'
    };
    
    diagram.model.addNodeData(nodeData);
    diagram.commitTransaction('add node');
  }, [allEntities]);

  const onLoadFile = useCallback(async (file: File | any) => {
    setIsLoading(true);
    setLoadingMessage('Reading file...');
    setLoadingProgress(10);
    
    try {
      let text: string;
      
      // Handle URL loading
      if (file.type === 'url' || typeof file === 'string' || file.url) {
        const url = file.url || file;
        setLoadingMessage('Fetching from URL...');
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch: ${response.statusText}`);
        }
        text = await response.text();
      } else {
        // Handle file upload
        text = await file.text();
      }
      
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
      diagram.model.setDataProperty(node.data, 'annotationProperties', properties);
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
    try {
      // Map interface format to RDF manager format
      const rdfFormat = format === 'owl-xml' ? 'rdf-xml' : format;
      const content = await exportGraph(rdfFormat as 'turtle' | 'json-ld' | 'rdf-xml');
      const blob = new Blob([content], { 
        type: format === 'json-ld' ? 'application/ld+json' : format === 'owl-xml' ? 'application/rdf+xml' : 'text/turtle'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.${format === 'owl-xml' ? 'owl' : format === 'json-ld' ? 'jsonld' : 'ttl'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success(`Graph exported as ${format.toUpperCase()}`);
    } catch (error) {
      toast.error('Export failed');
      console.error('Export error:', error);
    }
  }, [exportGraph]);

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
      <CanvasToolbar 
        onAddNode={onAddNode}
        onToggleLegend={() => setShowLegend(!showLegend)}
        showLegend={showLegend}
        onExport={handleExport}
        onLoadFile={onLoadFile}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onLayoutChange={changeLayout}
        availableEntities={allEntities}
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

      {showLegend && <ResizableNamespaceLegend onClose={() => setShowLegend(false)} />}

      <ReasoningIndicator onOpenReport={() => setShowReasoningReport(true)} />
      
      <ReasoningReportModal 
        open={showReasoningReport}
        onOpenChange={setShowReasoningReport}
      />

      <NodePropertyEditor
        open={showNodeEditor}
        onOpenChange={(open) => {
          console.log('GoJSCanvas: NodePropertyEditor onOpenChange called with:', open);
          setShowNodeEditor(open);
        }}
        nodeData={selectedNode}
        availableEntities={allEntities}
        onSave={(updatedData) => {
          console.log('NodePropertyEditor onSave called with:', updatedData);
          
          // Update the entity in the RDF store FIRST
          const entityUri = updatedData.uri || updatedData.iri;
          if (entityUri && updatedData.annotationProperties) {
            console.log('Updating entity in RDF store:', entityUri);
            
            updateEntity(entityUri, {
              type: updatedData.displayType || updatedData.classType, // Use the meaningful type
              rdfTypes: updatedData.rdfTypes, // Update all types
              annotationProperties: updatedData.annotationProperties.map((prop: any) => ({
                propertyUri: prop.key || prop.property,
                value: prop.value,
                type: prop.type || 'xsd:string'
              }))
            });
          }
          
          // Update the GoJS diagram WITHOUT triggering Modified event
          if (selectedNode && diagramInstanceRef.current) {
            const diagram = diagramInstanceRef.current;
            
            // Use skipsUndoManager to avoid triggering change events
            diagram.skipsUndoManager = true;
            diagram.startTransaction('update node properties');
            
            // Update all node properties including rdfTypes
            Object.keys(updatedData).forEach(key => {
              diagram.model.setDataProperty(selectedNode, key, updatedData[key]);
            });
            
            diagram.commitTransaction('update node properties');
            diagram.skipsUndoManager = false;
          }
        }}
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