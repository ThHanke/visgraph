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
  const namespaceColorMap: Record<string, string> = {
    'namespace-lavender': 'bg-namespace-lavender',
    'namespace-mint': 'bg-namespace-mint',
    'namespace-peach': 'bg-namespace-peach',
    'namespace-sky': 'bg-namespace-sky',
    'namespace-rose': 'bg-namespace-rose',
    'namespace-sage': 'bg-namespace-sage',
    'namespace-cream': 'bg-namespace-cream',
    'namespace-lilac': 'bg-namespace-lilac',
    'namespace-seafoam': 'bg-namespace-seafoam',
    'namespace-blush': 'bg-namespace-blush',
    'namespace-periwinkle': 'bg-namespace-periwinkle',
    'namespace-coral': 'bg-namespace-coral',
    'namespace-eucalyptus': 'bg-namespace-eucalyptus',
    'namespace-champagne': 'bg-namespace-champagne',
    'namespace-orchid': 'bg-namespace-orchid',
    'namespace-aqua': 'bg-namespace-aqua',
    'namespace-apricot': 'bg-namespace-apricot',
    'namespace-mauve': 'bg-namespace-mauve',
    'namespace-mint-cream': 'bg-namespace-mint-cream',
    'namespace-powder': 'bg-namespace-powder',
    'namespace-honey': 'bg-namespace-honey',
    'namespace-thistle': 'bg-namespace-thistle',
  };

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
              className={cn(
                'w-4 h-4 rounded-full border border-white/30',
                namespaceColorMap[ns.color] || 'bg-muted'
              )}
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