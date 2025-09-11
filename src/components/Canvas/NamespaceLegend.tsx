import { useEffect, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";

/**
 * Namespace legend shows prefix -> namespace mappings.
 * Behavior change: only display prefixes that are registered in the RDF manager
 * AND whose namespace URI is actually used in the RDF store quads (single source of truth).
 */

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
  // optional override; rarely used. When omitted we read from rdfManager.
  namespaces?: Record<string, string>;
}

/**
 * Helper: returns set of used namespace URIs by scanning store quads.
 * Stops early if all candidate URIs are discovered.
 */
function computeUsedNamespaceUris(store: any, candidateUris: string[]): Set<string> {
  const used = new Set<string>();
  if (!store || !candidateUris || candidateUris.length === 0) return used;

  try {
    const quads = store.getQuads(null, null, null, null) || [];
    // Optimize: convert candidateUris to array for iteration
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i];
      const terms = [q.subject, q.predicate, q.object];
      for (const t of terms) {
        if (!t || typeof t.value !== 'string') continue;
        const val = t.value;
        for (const ns of candidateUris) {
          if (!used.has(ns) && val.startsWith(ns)) {
            used.add(ns);
            if (used.size === candidateUris.length) return used;
          }
        }
      }
    }
  } catch (_) {
    // best-effort only; ignore errors and return what we found
  }
  return used;
}

export const NamespaceLegend = ({ namespaces }: NamespaceLegendProps) => {
  // Subscribe to rdfManager and currentGraph so we re-render when store changes.
  const rdfManager = useOntologyStore(state => state.rdfManager);
  // currentGraph changes indicate new nodes/edges may have been merged into the store
  const currentGraph = useOntologyStore(state => state.currentGraph);

  // Obtain the registered namespaces; prefer explicit prop if provided.
  const registeredNamespaces = useMemo(() => {
    try {
      return namespaces && Object.keys(namespaces).length > 0 ? namespaces : (rdfManager && typeof rdfManager.getNamespaces === 'function' ? rdfManager.getNamespaces() : {});
    } catch (_) {
      return namespaces || {};
    }
  }, [namespaces, rdfManager]);

  const registeredEntries = useMemo(() => Object.entries(registeredNamespaces).filter(([p, u]) => p && u), [registeredNamespaces]);

  // Compute used namespace URIs by scanning the RDF store (single source of truth)
  const [usedSet, setUsedSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const store = rdfManager && typeof rdfManager.getStore === 'function' ? rdfManager.getStore() : null;
      const candidateUris = registeredEntries.map(([p, uri]) => String(uri));
      const used = computeUsedNamespaceUris(store, candidateUris);
      setUsedSet(used);
    } catch (_) {
      setUsedSet(new Set());
    }
    // We depend on rdfManager and currentGraph to recompute when graph/store changes.
  }, [rdfManager, currentGraph, registeredEntries]);

  // Filter registered entries to only those whose namespace URI is used
  const filteredNamespaces = registeredEntries
    .filter(([prefix, uri]) => usedSet.has(String(uri)))
    .sort(([a], [b]) => a.localeCompare(b));

  if (filteredNamespaces.length === 0) return null;

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
