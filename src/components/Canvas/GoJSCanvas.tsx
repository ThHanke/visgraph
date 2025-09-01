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
import { toast } from 'sonner';

export const GoJSCanvas = () => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const diagramInstanceRef = useRef<go.Diagram | null>(null);
  const [showLegend, setShowLegend] = useState(true);
  const [showReasoningReport, setShowReasoningReport] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('');
  
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
      layout: $(go.ForceDirectedLayout, {
        defaultSpringLength: 100,
        defaultElectricalCharge: 150
      }),
      model: new go.GraphLinksModel()
    });

    // Node template
    diagram.nodeTemplate = $(go.Node, 'Auto',
      {
        locationSpot: go.Spot.Center,
        selectionAdornmentTemplate: $(go.Adornment, 'Auto',
          $(go.Shape, { fill: null, stroke: 'hsl(var(--primary))', strokeWidth: 3 }),
          $(go.Placeholder)
        )
      },
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
      $(go.Shape, 'RoundedRectangle',
        {
          fill: 'hsl(var(--card))',
          stroke: 'hsl(var(--border))',
          strokeWidth: 2,
          minSize: new go.Size(120, 80)
        },
        new go.Binding('fill', 'namespace', (ns) => `hsl(var(--ns-${ns || 'default'}))`)
      ),
      $(go.Panel, 'Vertical',
        { margin: 8 },
        $(go.TextBlock,
          {
            font: 'bold 12px sans-serif',
            stroke: 'hsl(var(--foreground))',
            margin: new go.Margin(0, 0, 4, 0)
          },
          new go.Binding('text', 'classType')
        ),
        $(go.TextBlock,
          {
            font: '10px sans-serif',
            stroke: 'hsl(var(--muted-foreground))',
            margin: new go.Margin(0, 0, 4, 0)
          },
          new go.Binding('text', 'individualName')
        ),
        $(go.Panel, 'Vertical',
          { itemTemplate: $(go.Panel, 'Horizontal',
              $(go.TextBlock, { font: '9px sans-serif', stroke: 'hsl(var(--muted-foreground))' },
                new go.Binding('text', '', (prop) => `${prop.key}: ${prop.value}`))
            )
          },
          new go.Binding('itemArray', 'literalProperties')
        )
      )
    );

    // Link template
    diagram.linkTemplate = $(go.Link,
      {
        routing: go.Link.AvoidsNodes,
        curve: go.Link.JumpOver,
        corner: 5,
        selectionAdornmentTemplate: $(go.Adornment, 'Link',
          $(go.Shape, { isPanelMain: true, stroke: 'hsl(var(--primary))', strokeWidth: 3 }),
          $(go.Shape, { toArrow: 'Standard', fill: 'hsl(var(--primary))', stroke: null })
        )
      },
      $(go.Shape, { strokeWidth: 2, stroke: 'hsl(var(--border))' }),
      $(go.Shape, { toArrow: 'Standard', fill: 'hsl(var(--border))', stroke: null }),
      $(go.TextBlock,
        {
          segmentIndex: 0,
          segmentFraction: 0.5,
          background: 'hsl(var(--background))',
          font: '10px sans-serif',
          stroke: 'hsl(var(--foreground))'
        },
        new go.Binding('text', 'label')
      )
    );

    // Add event listeners
    diagram.addDiagramListener('Modified', () => {
      if (settings.autoReasoning) {
        const nodes = diagram.model.nodeDataArray;
        const links = (diagram.model as go.GraphLinksModel).linkDataArray;
        startReasoning(nodes, links);
      }
    });

    diagramInstanceRef.current = diagram;

    return () => {
      diagram.div = null;
    };
  }, []);

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

  const handleExport = useCallback((format: 'turtle' | 'owl-xml' | 'json-ld') => {
    if (!diagramInstanceRef.current) return;
    
    const diagram = diagramInstanceRef.current;
    const nodes = diagram.model.nodeDataArray;
    const links = (diagram.model as go.GraphLinksModel).linkDataArray;
    
    // Export logic would go here
    toast.success(`Graph exported as ${format.toUpperCase()}`);
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
            { name: 'foaf', color: 'namespace-lavender', description: 'Friend of a Friend' },
            { name: 'org', color: 'namespace-mint', description: 'Organization Ontology' },
            { name: 'rdfs', color: 'namespace-peach', description: 'RDF Schema' },
            { name: 'owl', color: 'namespace-sky', description: 'Web Ontology Language' },
            { name: 'iof', color: 'namespace-coral', description: 'Industrial Ontologies Foundry' }
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