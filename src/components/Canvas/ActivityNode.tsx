/**
 * @fileoverview ActivityNode component for PROV-O Activity execution
 * Displays prov:Activity nodes with execution controls
 */

import React, { memo, useState, useCallback, useMemo, useEffect } from 'react';
import {
  Handle,
  Position,
  NodeProps,
  useConnection,
  useReactFlow,
} from '@xyflow/react';
import { cn } from '../../lib/utils';
import { computeTermDisplay, toPrefixed } from '../../utils/termUtils';
import type { NodeData } from '../../types/canvas';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { useOntologyStore } from '../../stores/ontologyStore';
import { getPyodideClient } from '../../utils/pyodideManager.workerClient';
import type { ExecuteResult } from '../../workers/pyodide.workerProtocol';
import { toast } from 'sonner';

interface TemplateVariable {
  iri: string;
  label: string;
  expectedType?: string;
  required?: boolean;
}

function ActivityNodeImpl(props: NodeProps) {
  const { data, selected, id } = props;
  const connection = useConnection() as {
    inProgress?: boolean;
    fromNode?: { id?: string; measured?: { id?: string } };
  };

  const connectionInProgress = Boolean(connection?.inProgress);
  const connectionFromNodeId =
    connection?.fromNode?.id ??
    connection?.fromNode?.measured?.id ??
    '';

  const isTarget = Boolean(
    connectionInProgress && connectionFromNodeId && connectionFromNodeId !== String(id)
  );
  const nodeData = (data ?? {}) as NodeData;
  const showHandles = !!(connectionInProgress || !selected);

  const [isExecuting, setIsExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState(0);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [templateInputs, setTemplateInputs] = useState<TemplateVariable[]>([]);
  const [templateOutputs, setTemplateOutputs] = useState<TemplateVariable[]>([]);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const {
    displayPrefixed,
    displayShort,
    label,
    iri,
    rdfTypes,
    humanLabel,
    executionStatus,
  } = nodeData as NodeData & {
    humanLabel?: string;
    executionStatus?: 'ready' | 'running' | 'complete' | 'error';
  };

  const getRdfManager = useOntologyStore((s) => s.getRdfManager);
  const { setNodes } = useReactFlow();

  // Listen to global mousemove to detect hover state (more reliable than onPointerEnter/Leave
  // because handles can intercept pointer events)
  React.useEffect(() => {
    const nodeEl = rootRef.current;
    if (!nodeEl) return;

    const onMove = (e: MouseEvent) => {
      const rect = nodeEl.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      setHoverOpen(inside);
    };

    window.addEventListener('mousemove', onMove, { capture: true });
    const onDown = () => setHoverOpen(false);
    window.addEventListener('pointerdown', onDown, { capture: true });

    return () => {
      window.removeEventListener('mousemove', onMove, { capture: true });
      window.removeEventListener('pointerdown', onDown, { capture: true });
      setHoverOpen(false);
    };
  }, []);

  // Load template variable information when component mounts
  useEffect(() => {
    let mounted = true;

    const loadTemplateVariables = async () => {
      try {
        setLoadingTemplate(true);
        const rdfManager = getRdfManager();
        if (!rdfManager) return;

        const worker = (rdfManager as any).worker;
        if (!worker || typeof worker.call !== 'function') return;

        const activityIri = String(iri);

        // Query for p-plan:correspondsToStep to find the template Step
        const stepQuads = await worker.call('getQuads', {
          subject: activityIri,
          predicate: 'http://purl.org/net/p-plan#correspondsToStep',
          graphName: 'urn:vg:data',
        });

        if (!stepQuads || stepQuads.length === 0) return;
        const stepIri = stepQuads[0].object.value;

        // Query input variables (p-plan:isInputVarOf pointing to this step)
        const inputVarQuads = await worker.call('getQuads', {
          predicate: 'http://purl.org/net/p-plan#isInputVarOf',
          object: { termType: 'NamedNode', value: stepIri },
          graphName: 'urn:vg:workflows',
        });

        // Query output variables (p-plan:isOutputVarOf pointing to this step)
        const outputVarQuads = await worker.call('getQuads', {
          predicate: 'http://purl.org/net/p-plan#isOutputVarOf',
          object: { termType: 'NamedNode', value: stepIri },
          graphName: 'urn:vg:workflows',
        });

        // Helper to get variable details
        const getVariableDetails = async (varIri: string): Promise<TemplateVariable> => {
          const labelQuads = await worker.call('getQuads', {
            subject: varIri,
            predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
            graphName: 'urn:vg:workflows',
          });
          const label = labelQuads?.[0]?.object?.value || varIri.split(/[#/]/).pop() || varIri;

          const typeQuads = await worker.call('getQuads', {
            subject: varIri,
            predicate: 'https://github.com/ThHanke/PyodideSemanticWorkflow#expectedType',
            graphName: 'urn:vg:workflows',
          });
          const expectedType = typeQuads?.[0]?.object?.value;

          const requiredQuads = await worker.call('getQuads', {
            subject: varIri,
            predicate: 'https://github.com/ThHanke/PyodideSemanticWorkflow#required',
            graphName: 'urn:vg:workflows',
          });
          const required = requiredQuads?.[0]?.object?.value === 'true';

          return { iri: varIri, label, expectedType, required };
        };

        // Load input variable details
        const inputs: TemplateVariable[] = [];
        for (const quad of inputVarQuads || []) {
          const varIri = quad.subject.value;
          const details = await getVariableDetails(varIri);
          inputs.push(details);
        }

        // Load output variable details
        const outputs: TemplateVariable[] = [];
        for (const quad of outputVarQuads || []) {
          const varIri = quad.subject.value;
          const details = await getVariableDetails(varIri);
          outputs.push(details);
        }

        if (mounted) {
          setTemplateInputs(inputs);
          setTemplateOutputs(outputs);
        }
      } catch (error) {
        console.error('[ActivityNode] Failed to load template variables:', error);
      } finally {
        if (mounted) {
          setLoadingTemplate(false);
        }
      }
    };

    loadTemplateVariables();

    return () => {
      mounted = false;
    };
  }, [iri, getRdfManager]);

  const { headerDisplay, statusDisplay, statusColor } = useMemo(() => {
    const headerCandidate =
      typeof displayPrefixed === 'string' && displayPrefixed.trim().length > 0
        ? displayPrefixed
        : typeof displayShort === 'string' && displayShort.trim().length > 0
          ? displayShort
          : typeof label === 'string'
            ? label
            : null;

    let computedHeader = headerCandidate;
    if (!computedHeader) {
      if (typeof iri === 'string' && iri.trim().length > 0) {
        try {
          const display = computeTermDisplay(iri);
          computedHeader = display.prefixed || display.short || display.iri;
        } catch {
          computedHeader = iri;
        }
      }
    }

    const status = executionStatus || 'ready';
    const statusText =
      status === 'ready'
        ? '○ Ready'
        : status === 'running'
          ? '⟳ Running'
          : status === 'complete'
            ? '✓ Complete'
            : '✗ Error';

    const color =
      status === 'ready'
        ? 'text-blue-600'
        : status === 'running'
          ? 'text-yellow-600'
          : status === 'complete'
            ? 'text-green-600'
            : 'text-red-600';

    return {
      headerDisplay: computedHeader ?? '',
      statusDisplay: statusText,
      statusColor: color,
    };
  }, [displayPrefixed, displayShort, label, iri, executionStatus]);

  const nodeColor = nodeData.color || '#9333ea'; // Purple for activities

  const handleExecute = useCallback(async (event: React.MouseEvent) => {
    // Prevent event from bubbling up to trigger node selection/dialog
    event.stopPropagation();
    
    if (isExecuting) return;

    // Deselect the node immediately so handles reappear and edges can reconnect
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id ? { ...node, selected: false } : node
      )
    );

    try {
      setIsExecuting(true);
      setExecutionProgress(0);

      const rdfManager = getRdfManager();
      if (!rdfManager) {
        throw new Error('RDF manager not available');
      }

      // Access the worker client directly
      const worker = (rdfManager as any).worker;
      if (!worker || typeof worker.call !== 'function') {
        throw new Error('RDF manager worker not available');
      }

      const activityIri = String(iri);

      // Query for activity's prov:used to find code and requirements resources
      // These are inherited from the template Step
      const activityUsedResourceQuads = await worker.call('getQuads', {
        subject: activityIri,
        predicate: 'http://www.w3.org/ns/prov#used',
        graphName: 'urn:vg:data',
      });

      console.log('[ActivityNode] Found prov:used quads:', activityUsedResourceQuads?.length || 0);
      console.log('[ActivityNode] prov:used resources:', activityUsedResourceQuads?.map((q: any) => q.object.value));

      let codeUrl = '';
      let requirementsUrl = '';

      // Process each resource the activity uses
      for (const quad of activityUsedResourceQuads) {
        const resourceIri = quad.object.value;
        console.log('[ActivityNode] Checking resource:', resourceIri);

        // Check if this resource has prov:atLocation (skip if it's an input Entity without atLocation)
        // Resources like spw:SumCode are in the workflows catalog, so query there
        const locationQuads = await worker.call('getQuads', {
          subject: resourceIri,
          predicate: 'http://www.w3.org/ns/prov#atLocation',
          graphName: 'urn:vg:workflows',  // Resources are defined in the catalog
        });

        console.log('[ActivityNode] Location quads for', resourceIri, ':', locationQuads?.length || 0);

        if (locationQuads && locationQuads.length > 0) {
          const location = locationQuads[0].object.value;
          console.log('[ActivityNode] Found location:', location);

          // Check if this is code or requirements based on rdf:type first (more reliable)
          const typeQuads = await worker.call('getQuads', {
            subject: resourceIri,
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            graphName: 'urn:vg:workflows',
          });

          const types = (typeQuads || []).map((q: any) => q.object.value);
          console.log('[ActivityNode] Resource types:', types);

          // Check if it's code based on type
          const isCode = types.some((t: string) => 
            t.includes('SoftwareSourceCode') || t.includes('Code')
          );

          if (isCode) {
            codeUrl = location;
            console.log('[ActivityNode] Set codeUrl:', codeUrl);
          } else {
            // Check label as fallback
            const labelQuads = await worker.call('getQuads', {
              subject: resourceIri,
              predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
              graphName: 'urn:vg:workflows',
            });

            const labelText = labelQuads?.[0]?.object?.value?.toLowerCase() || resourceIri.toLowerCase();

            if (labelText.includes('code') || labelText.includes('.py')) {
              codeUrl = location;
              console.log('[ActivityNode] Set codeUrl from label:', codeUrl);
            } else if (labelText.includes('requirements') || labelText.includes('requirement')) {
              requirementsUrl = location;
              console.log('[ActivityNode] Set requirementsUrl:', requirementsUrl);
            }
          }
        } else {
          console.log('[ActivityNode] No prov:atLocation found for resource:', resourceIri);
          
          // Try querying all graphs to see where this resource exists
          const allGraphsQuads = await worker.call('getQuads', {
            subject: resourceIri,
            predicate: 'http://www.w3.org/ns/prov#atLocation',
          });
          console.log('[ActivityNode] Checking all graphs for prov:atLocation:', allGraphsQuads?.length || 0);
          if (allGraphsQuads && allGraphsQuads.length > 0) {
            console.log('[ActivityNode] Found in graphs:', allGraphsQuads.map((q: any) => q.graph?.value || 'default'));
          }
        }
      }

      if (!codeUrl) {
        const errorMsg = `No Python code URL found for this activity.
        
Debug info:
- Activity IRI: ${activityIri}
- prov:used resources: ${activityUsedResourceQuads?.length || 0}
- Resources checked: ${activityUsedResourceQuads?.map((q: any) => q.object.value).join(', ')}

The activity should have prov:used triples pointing to resources (like spw:SumCode) 
that are defined in the workflows catalog (urn:vg:workflows) with prov:atLocation.`;
        
        throw new Error(errorMsg);
      }

      console.log('[ActivityNode] Resolved execution resources:', {
        codeUrl,
        requirementsUrl: requirementsUrl || '(none)',
      });

      // Query for activity's prov:used to find INPUT ENTITIES (prov:Entity, not code/requirements)
      // These are the data entities created during workflow instantiation
      const allUsedQuads = await worker.call('getQuads', {
        subject: activityIri,
        predicate: 'http://www.w3.org/ns/prov#used',
        graphName: 'urn:vg:data',
      });

      // Filter to only include entities that are prov:Entity (not resources like code)
      const inputIris: string[] = [];
      for (const quad of allUsedQuads) {
        const entityIri = quad.object.value;
        
        // Check if this is a prov:Entity (input entity, not code/requirements)
        const typeQuads = await worker.call('getQuads', {
          subject: entityIri,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: { termType: 'NamedNode', value: 'http://www.w3.org/ns/prov#Entity' },
          graphName: 'urn:vg:data',
        });

        if (typeQuads && typeQuads.length > 0) {
          inputIris.push(entityIri);
        }
      }

      console.log('[ActivityNode] Found prov:used inputs:', inputIris);

      // Also check for bfo:is_input_of relationships (if using BFO)
      try {
        const bfoInputQuads = await worker.call('getQuads', {
          predicate: 'https://example.org/bfo/is_input_of',
          object: { termType: 'NamedNode', value: activityIri },
          graphName: 'urn:vg:data',
        });

        console.log('[ActivityNode] Found bfo:is_input_of quads:', bfoInputQuads.length);

        // for (const quad of bfoInputQuads) {
        //   if (!inputIris.includes(quad.subject.value)) {
        //     inputIris.push(quad.subject.value);
        //   }
        // }
      } catch (err) {
        // BFO relationships might not exist - continue without them
        console.debug('[ActivityNode] No BFO relationships found', err);
      }

      console.log('[ActivityNode] Input IRIs:', inputIris);
      console.log('[ActivityNode] Activity IRI:', activityIri);

      // Export the EXISTING graph with just the relevant subjects
      // No need to load into temp graph - they're already in urn:vg:data
      const exportResult = await worker.call('exportGraph', {
        graphName: 'urn:vg:data',
        format: 'text/turtle',
        // TODO: Add filter parameter if available to only export relevant subjects
      });

      const inputTurtle = exportResult?.content || '';

      console.log('[ActivityNode] Input Turtle from existing graph:');
      console.log('='.repeat(80));
      console.log(inputTurtle);
      console.log('='.repeat(80));

      setExecutionProgress(20);

      // Execute via Pyodide worker
      const pyodideClient = getPyodideClient();

      // Subscribe to progress events
      const unsubscribe = pyodideClient.on('progress', (payload: any) => {
        if (payload && typeof payload.percent === 'number') {
          setExecutionProgress(Math.min(95, payload.percent));
        }
      });

      try {
        const result = await pyodideClient.call<'execute', ExecuteResult>('execute', {
          activityIri,
          codeUrl,
          requirementsUrl: requirementsUrl || undefined,
          inputTurtle,
        });

        setExecutionProgress(100);

        console.log('[ActivityNode] Output Turtle from Python:');
        console.log(result.outputTurtle);

        // Parse output using N3.js directly (client-side) to avoid ANY store operations
        const N3 = await import('n3');
        const parser = new N3.Parser();
        const quads = parser.parse(result.outputTurtle);

        console.log('[ActivityNode] Parsed', quads.length, 'output quads');
        console.log('[ActivityNode] Output subjects:', [...new Set(quads.map((q: any) => q.subject.value))]);

        // Convert to worker quad format
        const adds = quads.map((quad: any) => ({
          subject: { termType: quad.subject.termType, value: quad.subject.value },
          predicate: { termType: quad.predicate.termType, value: quad.predicate.value },
          object: quad.object.termType === 'Literal' ? {
            termType: 'Literal',
            value: quad.object.value,
            datatype: quad.object.datatype?.value,
            language: quad.object.language,
          } : { termType: quad.object.termType, value: quad.object.value },
          graph: { termType: 'NamedNode', value: 'urn:vg:data' },
        }));

        console.log('[ActivityNode] Applying batch');

        // Apply ONLY the output results with suppressSubjects to prevent ANY reconciliation
        await rdfManager.applyBatch(
          { adds, options: { suppressSubjects: false } },
          'urn:vg:data'
        );

        console.log('[ActivityNode] Output ingested, NO reconciliation triggered');

        toast.success(`Activity executed successfully in ${result.executionTime}ms`);
      } finally {
        unsubscribe();
      }
    } catch (err) {
      console.error('[ActivityNode] Execution failed', err);
      toast.error(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      setIsExecuting(false);
      setExecutionProgress(0);
    }
  }, [isExecuting, iri, getRdfManager, setNodes, id]);

  const playButtonDisabled = isExecuting || executionStatus === 'running';

  return (
    <div
      ref={rootRef}
      data-node-id={String(id)}
      style={{
        ['--node-color' as any]: nodeColor,
      }}
      className={cn(
        'flex items-stretch overflow-hidden rounded-md shadow-md box-border border-2',
        selected ? 'ring-2 ring-primary border-primary' : 'border-purple-500'
      )}
    >
      {/* Left color bar */}
      <div
        aria-hidden="true"
        className="w-2 flex-none"
        style={{ background: nodeColor }}
      />

      <Tooltip delayDuration={250} open={hoverOpen} onOpenChange={setHoverOpen}>
        <TooltipTrigger asChild>
          <div className="px-4 py-3 min-w-0 flex-1 w-auto bg-white dark:bg-gray-900">
            {/* Header with title and play button */}
            <div className="flex items-center gap-3 mb-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-lg">🔧</span>
                <div
                  className="text-sm font-bold text-foreground truncate"
                  aria-label={headerDisplay}
                >
                  {headerDisplay}
                </div>
              </div>

              {/* Play button */}
              <button
                onClick={handleExecute}
                disabled={playButtonDisabled}
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-lg shadow-md transition-all duration-200',
                  'focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2',
                  playButtonDisabled
                    ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed opacity-50'
                    : 'bg-gradient-to-br from-purple-500 to-purple-700 hover:from-purple-600 hover:to-purple-800 hover:shadow-lg hover:scale-105 active:scale-95 cursor-pointer'
                )}
                title={isExecuting ? 'Executing...' : 'Execute activity'}
                aria-label={isExecuting ? 'Executing activity' : 'Execute activity'}
              >
                {isExecuting ? (
                  <svg 
                    className="w-5 h-5 text-white animate-spin" 
                    xmlns="http://www.w3.org/2000/svg" 
                    fill="none" 
                    viewBox="0 0 24 24"
                  >
                    <circle 
                      className="opacity-25" 
                      cx="12" 
                      cy="12" 
                      r="10" 
                      stroke="currentColor" 
                      strokeWidth="4"
                    />
                    <path 
                      className="opacity-75" 
                      fill="currentColor" 
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                ) : (
                  <svg 
                    className="w-5 h-5 text-white" 
                    fill="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            </div>

            {/* Status */}
            <div className="text-xs mb-2">
              <span className={cn('font-semibold', statusColor)}>{statusDisplay}</span>
            </div>

            {/* Progress bar when executing */}
            {isExecuting && (
              <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                <div
                  className="bg-purple-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${executionProgress}%` }}
                />
              </div>
            )}

            {/* Activity type badge */}
            <div className="text-xs text-muted-foreground">
              <span className="px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300">
                prov:Activity
              </span>
            </div>
          </div>
        </TooltipTrigger>

        <TooltipContent side="top" className="max-w-md">
          <div className="text-left text-sm space-y-2">
            <div className="font-semibold break-words">{headerDisplay}</div>
            <div className="text-xs text-muted-foreground">PROV-O Activity</div>
            <div className="text-xs">Status: {statusDisplay}</div>
            
            {/* Expected Inputs */}
            {templateInputs.length > 0 && (
              <div className="mt-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div className="text-xs font-semibold mb-1 text-purple-600 dark:text-purple-400">
                  Expected Inputs:
                </div>
                <ul className="text-xs space-y-1 ml-2">
                  {templateInputs.map((input) => (
                    <li key={input.iri} className="flex items-start gap-1">
                      <span className="text-purple-500 mt-0.5">→</span>
                      <div className="flex-1">
                        <span className="font-medium">{input.label}</span>
                        {input.required && (
                          <span className="text-red-500 ml-1" title="Required">*</span>
                        )}
                        {input.expectedType && (
                          <div className="text-muted-foreground text-[10px]">
                            Type: {input.expectedType.split(/[#/]/).pop()}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="text-[10px] text-muted-foreground mt-1 italic">
                  Connect QuantityValue nodes via prov:used edges
                </div>
              </div>
            )}

            {/* Expected Outputs */}
            {templateOutputs.length > 0 && (
              <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div className="text-xs font-semibold mb-1 text-green-600 dark:text-green-400">
                  Expected Outputs:
                </div>
                <ul className="text-xs space-y-1 ml-2">
                  {templateOutputs.map((output) => (
                    <li key={output.iri} className="flex items-start gap-1">
                      <span className="text-green-500 mt-0.5">←</span>
                      <div className="flex-1">
                        <span className="font-medium">{output.label}</span>
                        {output.expectedType && (
                          <div className="text-muted-foreground text-[10px]">
                            Type: {output.expectedType.split(/[#/]/).pop()}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="text-[10px] text-muted-foreground mt-1 italic">
                  Generated during execution
                </div>
              </div>
            )}

            {iri && (
              <div className="text-xs text-muted-foreground mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 break-all">
                {String(iri)}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>

      {/* Handles for connections */}
      {showHandles && (
        <Handle className="customHandle" position={Position.Right} type="source" />
      )}
      {(showHandles || isTarget) && (
        <Handle
          className="customHandle"
          position={Position.Left}
          type="target"
          isConnectableStart={false}
        />
      )}
    </div>
  );
}

export const ActivityNode = memo(ActivityNodeImpl);
ActivityNode.displayName = 'ActivityNode';
