import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Palette } from 'lucide-react';

interface Namespace {
  name: string;
  color: string;
  description: string;
  count?: number;
}

interface NamespaceLegendProps {
  namespaces: Namespace[];
  className?: string;
}

export const NamespaceLegend = ({ namespaces, className }: NamespaceLegendProps) => {
  return (
    <Card className={cn('w-80 shadow-glass backdrop-blur-sm bg-card/90', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Palette className="h-5 w-5 text-primary" />
          Namespace Legend
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {namespaces.map((ns) => (
          <div key={ns.name} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
            <div 
              className="w-4 h-4 rounded-full border border-white/30"
              style={{ backgroundColor: ns.color }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-xs font-mono px-2 py-0">
                  {ns.name}
                </Badge>
                {ns.count !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    {ns.count} nodes
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {ns.description}
              </p>
            </div>
          </div>
        ))}
        
        {namespaces.length === 0 && (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-sm">No namespaces loaded</p>
            <p className="text-xs mt-1">Load an ontology to see namespaces</p>
          </div>
        )}
        
        <div className="border-t pt-3 mt-3">
          <p className="text-xs text-muted-foreground">
            Each namespace is assigned a unique pastel color for easy identification of node types and relationships.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};