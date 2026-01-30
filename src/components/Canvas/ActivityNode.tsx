/**
 * @fileoverview ActivityNode component for PROV-O Activity execution
 * Displays prov:Activity nodes with execution controls
 */

import React, { memo, useState, useCallback, useMemo } from 'react';
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

      // Query for prov:hadPlan
      const planQuads = await worker.call('getQuads', {
        subject: activityIri,
        predicate: 'http://www.w3.org/ns/prov#hadPlan',
        graphName: 'urn:vg:data',
      });

      if (!planQuads || planQuads.length === 0) {
        throw new Error('No prov:hadPlan found for this activity');
      }

      const planIri = planQuads[0].object.value;

      // Query plan's prov:used to find code and requirements
      const planUsedQuads = await worker.call('getQuads', {
        subject: planIri,
        predicate: 'http://www.w3.org/ns/prov#used',
        graphName: 'urn:vg:data',
      });

      let codeUrl = '';
      let requirementsUrl = '';

      for (const quad of planUsedQuads) {
        const entityIri = quad.object.value;

        // Get atLocation for this entity
        const locationQuads = await worker.call('getQuads', {
          subject: entityIri,
          predicate: 'http://www.w3.org/ns/prov#atLocation',
          graphName: 'urn:vg:data',
        });

        if (locationQuads && locationQuads.length > 0) {
          const location = locationQuads[0].object.value;

          // Check if this is code or requirements based on label or IRI
          const labelQuads = await worker.call('getQuads', {
            subject: entityIri,
            predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
            graphName: 'urn:vg:data',
          });

          const labelText = labelQuads?.[0]?.object?.value?.toLowerCase() || entityIri.toLowerCase();

          if (labelText.includes('code') || labelText.includes('.py')) {
            codeUrl = location;
          } else if (labelText.includes('requirements') || labelText.includes('requirement')) {
            requirementsUrl = location;
          }
        }
      }

      if (!codeUrl) {
        throw new Error('No Python code URL found in plan');
      }

      // Query for activity's prov:used to find input entities
      const activityUsedQuads = await worker.call('getQuads', {
        subject: activityIri,
        predicate: 'http://www.w3.org/ns/prov#used',
        graphName: 'urn:vg:data',
      });

      const inputIris = activityUsedQuads.map((q: any) => q.object.value);

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
          <div
            className="px-4 py-3 min-w-0 flex-1 w-auto bg-white dark:bg-gray-900"
            onPointerEnter={() => {
              if (!selected) {
                setHoverOpen(true);
              }
            }}
            onPointerLeave={() => {
              if (!selected) {
                setHoverOpen(false);
              }
            }}
          >
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

        <TooltipContent side="top">
          <div className="text-left text-sm space-y-2 max-w-[32rem]">
            <div className="font-semibold break-words">{headerDisplay}</div>
            <div className="text-xs text-muted-foreground">PROV-O Activity</div>
            <div className="text-xs">Status: {statusDisplay}</div>
            {iri && (
              <div className="text-xs text-muted-foreground mt-1 break-words">{String(iri)}</div>
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
