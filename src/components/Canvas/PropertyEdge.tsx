import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  EdgeProps,
} from '@xyflow/react';
import { Badge } from '../ui/badge';

interface PropertyEdgeData {
  propertyType: string;
  label: string;
  namespace: string;
}

export const PropertyEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const namespaceColors: Record<string, string> = {
    foaf: 'bg-namespace-lavender text-foreground border-namespace-lavender/30',
    org: 'bg-namespace-mint text-foreground border-namespace-mint/30',
    rdfs: 'bg-namespace-peach text-foreground border-namespace-peach/30',
    owl: 'bg-namespace-sky text-foreground border-namespace-sky/30',
    default: 'bg-namespace-powder text-foreground border-namespace-powder/30'
  };

  const badgeColor = namespaceColors[(data as any)?.namespace || 'default'] || namespaceColors.default;

  return (
    <>
      <BaseEdge 
        path={edgePath} 
        style={{
          stroke: selected ? 'hsl(var(--primary))' : 'hsl(var(--edge-default))',
          strokeWidth: selected ? 3 : 2,
        }}
        markerEnd="url(#react-flow__arrowclosed)"
      />
      <EdgeLabelRenderer>
        <div
          className="absolute pointer-events-auto"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
        >
          <Badge 
            variant="secondary" 
            className={`text-xs px-2 py-1 shadow-md backdrop-blur-sm ${badgeColor}`}
          >
            {(data as any)?.label || (data as any)?.propertyType || 'property'}
          </Badge>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

PropertyEdge.displayName = 'PropertyEdge';