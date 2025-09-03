import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";

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
    <div className="absolute top-4 right-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg p-3 shadow-lg max-w-sm">
      <h3 className="text-sm font-semibold mb-2">Namespace Legend</h3>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {filteredNamespaces.map(([prefix, uri]) => (
          <div key={prefix} className="flex items-center gap-2 text-xs">
            <Badge variant="outline" className="font-mono shrink-0">
              {prefix}:
            </Badge>
            <span className="text-muted-foreground truncate flex-1" title={uri}>
              {uri}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};