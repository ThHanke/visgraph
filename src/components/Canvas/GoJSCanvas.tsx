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
  
  const { loadedOntologies, availableClasses, availableProperties, loadOntologyFromRDF, loadKnowledgeGraph } = useOntologyStore();
  
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
  const { settings } = useSettingsStore();

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

    // Single unified node template with proper header/body structure
    diagram.nodeTemplate = $(go.Node, 'Auto',
      {
        locationSpot: go.Spot.Center,
        selectionAdornmentTemplate: $(go.Adornment, 'Auto',
          $(go.Shape, { fill: null, stroke: '#7c3aed', strokeWidth: 3 }),
          $(go.Placeholder)
        ),
        // Add mouse enter/leave for highlighting
        mouseEnter: (e, obj) => {
          const node = obj.part as go.Node;
          if (node && node.data) {
            const shape = node.findObject('SHAPE') as go.Shape;
            const headerShape = node.findObject('HEADER_SHAPE') as go.Shape;
            if (shape) shape.strokeWidth = 3;
            if (headerShape) headerShape.strokeWidth = 3;
            (diagram.div as any).style.cursor = 'pointer';
          }
        },
        mouseLeave: (e, obj) => {
          const node = obj.part as go.Node;
          if (node && node.data) {
            const shape = node.findObject('SHAPE') as go.Shape;
            const headerShape = node.findObject('HEADER_SHAPE') as go.Shape;
            const hasError = node.data.hasReasoningError;
            if (shape) shape.strokeWidth = hasError ? 4 : 2;
            if (headerShape) headerShape.strokeWidth = hasError ? 4 : 2;
            (diagram.div as any).style.cursor = 'auto';
          }
        },
        // Add click handler for annotation properties
        click: (e, obj) => {
          const node = obj.part as go.Node;
          if (node && node.data) {
            setSelectedNode(node.data);
            setShowNodeEditor(true);
          }
        },
        // Tooltip for node details
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
              new go.Binding('text', 'uri', (uri) => `URI: ${uri || 'unknown'}`)
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
        )
      },
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
      new go.Binding('visible', 'visible', (vis) => vis !== false),
      
      // Main container shape with border color from namespace
      $(go.Shape, 'RoundedRectangle',
        {
          name: 'SHAPE',
          strokeWidth: 2,
          fill: '#ffffff',
          minSize: new go.Size(160, 90),
          parameter1: 8,
          portId: '', 
          fromLinkable: true, 
          toLinkable: true
        },
        new go.Binding('stroke', 'namespace', (ns) => {
          const namespaceColors = {
            'foaf': 'hsl(250 75% 40%)',
            'org': 'hsl(160 70% 25%)',
            'rdfs': 'hsl(25 85% 45%)',
            'owl': 'hsl(200 80% 35%)',
            'rdf': 'hsl(190 75% 30%)',
            'skos': 'hsl(40 80% 40%)',
            'dc': 'hsl(290 70% 40%)',
            'dct': 'hsl(240 65% 35%)',
            'xsd': 'hsl(180 60% 30%)',
            'iof': 'hsl(330 70% 40%)',
            ':': 'hsl(330 70% 40%)',
            'reasoning': 'hsl(55 80% 65%)',
            'default': 'hsl(215 25% 40%)'
          };
          return namespaceColors[ns as keyof typeof namespaceColors] || namespaceColors.default;
        }),
        new go.Binding('strokeWidth', 'hasReasoningError', (hasError) => hasError ? 4 : 2)
      ),
      
      // Vertical panel for header and body
      $(go.Panel, 'Vertical',
        { margin: 0 },
        
        // Header section with colored background
        $(go.Panel, 'Auto',
          $(go.Shape, 'RoundedRectangle',
            {
              name: 'HEADER_SHAPE',
              strokeWidth: 0,
              minSize: new go.Size(158, 35),
              parameter1: 8,
              parameter2: 8 | 2  // Only round top corners
            },
            new go.Binding('fill', 'namespace', (ns) => {
              const namespaceColors = {
                'foaf': 'hsl(250 75% 60%)',
                'org': 'hsl(160 70% 45%)',
                'rdfs': 'hsl(25 85% 65%)',
                'owl': 'hsl(200 80% 55%)',
                'rdf': 'hsl(190 75% 50%)',
                'skos': 'hsl(40 80% 60%)',
                'dc': 'hsl(290 70% 60%)',
                'dct': 'hsl(240 65% 55%)',
                'xsd': 'hsl(180 60% 50%)',
                'iof': 'hsl(330 70% 60%)',
                ':': 'hsl(330 70% 60%)',
                'reasoning': 'hsl(55 90% 85%)',
                'default': 'hsl(215 25% 60%)'
              };
              return namespaceColors[ns as keyof typeof namespaceColors] || namespaceColors.default;
            })
          ),
          $(go.Panel, 'Vertical',
            { margin: 4, alignment: go.Spot.Center },
            // Shortened URI
            $(go.TextBlock,
              {
                font: 'bold 10px Inter, sans-serif',
                stroke: '#ffffff',
                maxSize: new go.Size(140, NaN),
                wrap: go.TextBlock.WrapFit,
                textAlign: 'center'
              },
              new go.Binding('text', 'uri', (uri) => {
                // Shorten URI using base prefix
                if (uri && uri.startsWith('https://github.com/Mat-O-Lab/IOFMaterialsTutorial/')) {
                  return uri.replace('https://github.com/Mat-O-Lab/IOFMaterialsTutorial/', ':');
                }
                // Try other common prefixes
                const prefixMap = {
                  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
                  'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
                  'http://www.w3.org/2002/07/owl#': 'owl:',
                  'http://xmlns.com/foaf/0.1/': 'foaf:',
                  'https://spec.industrialontologies.org/ontology/core/Core/': 'iof:'
                };
                
                for (const [namespace, prefix] of Object.entries(prefixMap)) {
                  if (uri && uri.startsWith(namespace)) {
                    return uri.replace(namespace, prefix);
                  }
                }
                return uri || 'unknown:uri';
              })
            ),
            // RDF Type - show meaningful type only
            $(go.TextBlock,
              {
                font: '8px Inter, sans-serif',
                stroke: '#f8f9fa',
                margin: new go.Margin(1, 0, 0, 0),
                maxSize: new go.Size(140, NaN),
                wrap: go.TextBlock.WrapFit,
                textAlign: 'center'
              },
              new go.Binding('text', '', (data) => {
                // For A-box view, show the actual semantic type (e.g., iof:MeasurementProcess)
                if (data.entityType === 'individual' && data.rdfTypes) {
                  // Find the non-owl:NamedIndividual type
                  const meaningfulType = data.rdfTypes.find((type: string) => 
                    !type.includes('NamedIndividual')
                  );
                  if (meaningfulType) {
                    // Shorten with prefixes
                    const prefixMap = {
                      'https://spec.industrialontologies.org/ontology/core/Core/': 'iof:',
                      'http://www.w3.org/2002/07/owl#': 'owl:',
                      'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
                      'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
                      'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/': ':'
                    };
                    
                    for (const [namespace, prefix] of Object.entries(prefixMap)) {
                      if (meaningfulType.startsWith(namespace)) {
                        return meaningfulType.replace(namespace, prefix);
                      }
                    }
                    return meaningfulType;
                  }
                }
                // For T-box view, show the meta-type
                return data.rdfType || 'unknown:type';
              })
            )
          )
        ),
        
        // Body section with white background
        $(go.Panel, 'Auto',
          { margin: new go.Margin(0, 1, 1, 1) },
          $(go.Shape, 'RoundedRectangle',
            {
              fill: '#ffffff',
              strokeWidth: 0,
              minSize: new go.Size(156, 50),
              parameter1: 6,
              parameter2: 1 | 2  // Only round bottom corners
            }
          ),
          $(go.Panel, 'Vertical',
            { margin: 6, alignment: go.Spot.Center },
            // rdfs:label
            $(go.TextBlock,
              {
                font: 'bold 12px Inter, sans-serif',
                stroke: '#1e293b',
                margin: new go.Margin(0, 0, 4, 0),
                maxSize: new go.Size(140, NaN),
                wrap: go.TextBlock.WrapFit,
                textAlign: 'center'
              },
              new go.Binding('text', 'annotationProperties', (props) => {
                const labelProp = props?.find((p: any) => p.propertyUri === 'rdfs:label');
                return labelProp?.value || 'No label';
              })
            ),
            // Other annotation properties
            $(go.Panel, 'Vertical',
              { 
                maxSize: new go.Size(140, 30),
                itemTemplate: $(go.Panel, 'Horizontal',
                  { margin: new go.Margin(1, 0, 1, 0) },
                  $(go.TextBlock, 
                    { 
                      font: '8px Inter, sans-serif', 
                      stroke: '#6b7280',
                      maxSize: new go.Size(140, NaN),
                      wrap: go.TextBlock.WrapFit
                    },
                    new go.Binding('text', '', (prop) => `${prop.propertyUri}: ${prop.value}`)
                  )
                )
              },
              new go.Binding('itemArray', 'annotationProperties', (props) => 
                props?.filter((p: any) => p.propertyUri !== 'rdfs:label').slice(0, 2) || []
              )
            )
          )
        )
      )
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
          segmentOffset: new go.Point(0, -15),
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
      
      // Export with proper prefixes
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
        viewMode={viewMode}
        onViewModeChange={setViewMode}
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

      {showLegend && (
        <NamespaceLegend 
          className="absolute top-20 right-4 z-10"
          namespaces={(() => {
            const diagram = diagramInstanceRef.current;
            if (!diagram) return [];
            
            // Get all unique namespaces from visible nodes
            const visibleNamespaces = new Set<string>();
            diagram.nodes.each(node => {
              if (node.visible && node.data.namespace) {
                visibleNamespaces.add(node.data.namespace);
              }
            });
            
            const namespaceColors = {
              ':': { color: 'hsl(330 70% 60%)', description: 'Base URI (IOF Materials Tutorial)', uri: 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/' },
              'foaf': { color: 'hsl(250 75% 60%)', description: 'Friend of a Friend', uri: 'http://xmlns.com/foaf/0.1/' },
              'org': { color: 'hsl(160 70% 45%)', description: 'Organization Ontology', uri: 'http://www.w3.org/ns/org#' },
              'rdfs': { color: 'hsl(25 85% 65%)', description: 'RDF Schema', uri: 'http://www.w3.org/2000/01/rdf-schema#' },
              'owl': { color: 'hsl(200 80% 55%)', description: 'Web Ontology Language', uri: 'http://www.w3.org/2002/07/owl#' },
              'rdf': { color: 'hsl(190 75% 50%)', description: 'Resource Description Framework', uri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' },
              'skos': { color: 'hsl(40 80% 60%)', description: 'Simple Knowledge Organization System', uri: 'http://www.w3.org/2004/02/skos/core#' },
              'dc': { color: 'hsl(290 70% 60%)', description: 'Dublin Core', uri: 'http://purl.org/dc/elements/1.1/' },
              'iof': { color: 'hsl(330 70% 60%)', description: 'Industrial Ontologies Foundry', uri: 'https://spec.industrialontologies.org/ontology/core/Core/' },
              'reasoning': { color: 'hsl(55 90% 85%)', description: 'Reasoning Results', uri: '' }
            };
            
            return Array.from(visibleNamespaces).map(ns => ({
              name: ns,
              color: namespaceColors[ns as keyof typeof namespaceColors]?.color || 'hsl(215 25% 60%)',
              description: namespaceColors[ns as keyof typeof namespaceColors]?.description || 'Unknown namespace',
              uri: namespaceColors[ns as keyof typeof namespaceColors]?.uri
            }));
          })()}
        />
      )}

      <ReasoningIndicator onOpenReport={() => setShowReasoningReport(true)} />
      
      <ReasoningReportModal 
        open={showReasoningReport}
        onOpenChange={setShowReasoningReport}
      />

      <AnnotationPropertyDialog
        nodeId={selectedNode?.key || ''}
        availableProperties={allEntities.filter(e => e.rdfType === 'owl:AnnotationProperty')}
        currentProperties={selectedNode?.annotationProperties || []}
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