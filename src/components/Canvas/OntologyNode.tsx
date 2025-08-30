import { memo, useState } from 'react';
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
          <Badge variant="secondary" className="text-xs font-medium bg-white/20 text-foreground/80">
            {nodeData.namespace}:{nodeData.classType}
          </Badge>
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