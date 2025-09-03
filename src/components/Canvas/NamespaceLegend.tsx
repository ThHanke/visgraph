import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";

// Color palette for namespace prefixes
const NAMESPACE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--secondary))',
  'hsl(200, 100%, 50%)',
  'hsl(120, 100%, 40%)',
  'hsl(45, 100%, 50%)',
  'hsl(300, 100%, 50%)',
  'hsl(15, 100%, 50%)',
  'hsl(270, 100%, 50%)',
  'hsl(180, 100%, 40%)',
  'hsl(330, 100%, 50%)'
];

function getNamespaceColor(prefix: string, index: number): string {
  return NAMESPACE_COLORS[index % NAMESPACE_COLORS.length];
}

interface NamespaceLegendProps {
  namespaces?: Record<string, string>;
}

export const NamespaceLegend = ({ namespaces }: NamespaceLegendProps) => {
  const { rdfManager } = useOntologyStore();
  
  // Use namespaces from RDF manager if not provided
  const displayNamespaces = namespaces || rdfManager.getNamespaces();
  
  // Filter out empty or undefined prefixes and ensure we have meaningful namespaces
  const filteredNamespaces = Object.entries(displayNamespaces)
    .filter(([prefix, uri]) => prefix && uri && prefix !== '' && uri !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  if (filteredNamespaces.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-4 right-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg max-w-sm min-w-64 resize overflow-hidden">
      <div className="p-3 border-b">
        <h3 className="text-sm font-semibold">Namespace Legend</h3>
      </div>
      <div className="p-3 max-h-64 overflow-y-scroll scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        <div className="space-y-1">
          {filteredNamespaces.map(([prefix, uri], index) => (
            <div key={prefix} className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1">
                <div 
                  className="w-3 h-3 rounded-full border"
                  style={{ backgroundColor: getNamespaceColor(prefix, index) }}
                />
                <Badge variant="outline" className="font-mono shrink-0 text-xs px-1 py-0">
                  {prefix}:
                </Badge>
              </div>
              <span className="text-muted-foreground truncate flex-1" title={uri}>
                {uri}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};