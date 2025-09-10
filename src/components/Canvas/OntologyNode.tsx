import { memo, useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Edit3, AlertTriangle, Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import { useOntologyStore } from '../../stores/ontologyStore';
import { computeBadgeText } from './core/nodeDisplay';
import { debug, fallback } from '../../utils/startupDebug';

interface OntologyNodeData {
  classType: string;
  individualName: string;
  namespace: string;
  properties?: Record<string, any>;
  errors?: string[];
}

export const OntologyNode = memo(({ data, selected }: NodeProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const nodeData = data as any;
  const [individualName, setIndividualName] = useState(nodeData.individualName);


  // Retrieve rdfManager and availableClasses for badge computation
  const rdfManager = useOntologyStore.getState().rdfManager;
  const availableClasses = useOntologyStore.getState().availableClasses;

  // Diagnostic logging: only log when key node fields actually change to avoid render-loop spam.
  const _lastDebugFp = useRef<string | null>(null);
  useEffect(() => {
    try {
      const uri = nodeData?.uri || nodeData?.iri;
      const types = Array.isArray(nodeData?.rdfTypes) ? nodeData.rdfTypes.join('|') : '';
      const fp = `${uri}|${nodeData?.classType || ''}|${types}|${String(nodeData?.displayType || '')}`;
      if (_lastDebugFp.current === fp) return;
      _lastDebugFp.current = fp;

      const payload = {
        uri,
        classType: nodeData?.classType,
        rdfTypes: nodeData?.rdfTypes,
        displayType: nodeData?.displayType
      };

      // gated debug emission; keep console.debug for visibility in dev
      try { debug('OntologyNode.displayInfo', payload); } catch (_) { /* ignore */ }
      try { console.debug('OntologyNode.displayInfo', payload); } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
    // stringify rdfTypes as a dependency to detect changes without causing deep compare issues
  }, [nodeData?.uri, nodeData?.classType, (nodeData?.rdfTypes || []).join('|'), nodeData?.displayType]);

  const displayedTypeShort = computeBadgeText(nodeData, rdfManager, availableClasses);

  // Flag that indicates there are rdf:type triples present, but their class definitions are not loaded.
  const typePresentButNotLoaded = !nodeData.classType && Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.some((t: any) => t && !/NamedIndividual/i.test(String(t)));

  const namespaceColors: Record<string, string> = {
    foaf: 'bg-namespace-lavender border-namespace-lavender/30',
    org: 'bg-namespace-mint border-namespace-mint/30',
    rdfs: 'bg-namespace-peach border-namespace-peach/30',
    owl: 'bg-namespace-sky border-namespace-sky/30',
    default: 'bg-namespace-powder border-namespace-powder/30'
  };

  const nodeColor = namespaceColors[nodeData.namespace] || namespaceColors.default;
  const hasErrors = nodeData.errors && nodeData.errors.length > 0;

  return (
    <div 
      className={cn(
        'min-w-[180px] rounded-xl border-2 shadow-node backdrop-blur-sm transition-all duration-300',
        nodeColor,
        selected && 'ring-2 ring-primary ring-opacity-50',
        hasErrors && 'ring-2 ring-destructive ring-opacity-60'
      )}
    >
      {/* Class Type Header */}
      <div className="px-4 py-2 border-b border-white/20 bg-white/10 rounded-t-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-medium bg-white/20 text-foreground/80">
              {displayedTypeShort
                || nodeData.classType
                || (nodeData.uri || nodeData.iri ? computeBadgeText(nodeData, rdfManager, availableClasses) : '')
                || (nodeData.namespace ? `${nodeData.namespace}:${nodeData.classType || ''}` : '')
                || 'unknown'}
            </Badge>

            {typePresentButNotLoaded && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground">
                    <Info className="h-3 w-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64" side="top">
                  <div className="space-y-1 text-xs">
                    <div className="font-medium">Type available but ontology not loaded</div>
                    <div className="text-muted-foreground">
                      rdf:type triples for this node include a class, but that class's definition (ontology) is not currently loaded into the store. This is expected behavior and not an error.
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasErrors && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" side="top">
                  <div className="space-y-2">
                    <h4 className="font-medium text-sm flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                      Validation Errors
                    </h4>
                    <ul className="space-y-1">
                      {nodeData.errors?.map((error: string, index: number) => (
                        <li key={index} className="text-xs text-muted-foreground">{error}</li>
                      ))}
                    </ul>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground">
                  <Info className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" side="top">
                <div className="space-y-3">
                  <h4 className="font-medium text-sm">Node Properties</h4>
                  <div className="space-y-2">
                    {Object.entries(nodeData.properties || {}).map(([key, value]: [string, any]) => (
                      <div key={key} className="flex justify-between text-xs">
                        <span className="font-medium text-muted-foreground">{key}:</span>
                        <span className="text-foreground">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {/* Individual Name */}
      <div className="p-4">
        <div className="flex items-center gap-2">
          {isEditing ? (
            <input
              type="text"
              value={individualName}
              onChange={(e) => setIndividualName(e.target.value)}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setIsEditing(false);
                if (e.key === 'Escape') {
                  setIndividualName(nodeData.individualName);
                  setIsEditing(false);
                }
              }}
              className="flex-1 px-2 py-1 text-sm bg-white/20 border border-white/30 rounded nodrag"
              autoFocus
            />
          ) : (
            <>
              <span className="flex-1 font-medium text-sm text-foreground/90 truncate">
                {individualName}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => setIsEditing(true)}
              >
                <Edit3 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Connection Handles */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-primary !border-primary-foreground !border-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 !bg-primary !border-primary-foreground !border-2"
      />
    </div>
  );
});

OntologyNode.displayName = 'OntologyNode';
