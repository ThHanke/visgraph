import { useOntologyStore } from "@/stores/ontologyStore";

/**
 * Shared helpers for building / identifying edges in the canvas currentGraph.
 *
 * Purpose:
 * - Ensure all code paths construct edge ids and payloads identically.
 * - Keep the UI permitted to accept prefixed predicates, but require callers to
 *   expand prefixed values to full IRIs before calling generateEdgeId/buildEdgePayload
 *
 * Note: These helpers are tiny and pure (except addEdgeToCurrentGraph which
 * uses the ontology store setter). They should be the single source of truth
 * for edge id and payload shape.
 */

export type EdgePayload = {
  id: string;
  source: string;
  target: string;
  data: {
    propertyUri: string;
    propertyType: string;
    label?: string;
    [k: string]: any;
  };
};

/**
 * Deterministic edge id generator.
 * Uses subject, target and an encoded predicate (assumed full IRI).
 */
export function generateEdgeId(subjectIri: string, objectIri: string, predicateIriFull: string): string {
  const safePred = typeof predicateIriFull === "string" ? encodeURIComponent(String(predicateIriFull)) : "";
  return `${String(subjectIri)}-${String(objectIri)}-${safePred}`;
}

/**
 * Build canonical edge payload used by currentGraph state.
 * predicateIriFull must be a full IRI (expand prefixes at UI boundary).
 */
export function buildEdgePayload(subjectIri: string, objectIri: string, predicateIriFull: string, label?: string): EdgePayload {
  const id = generateEdgeId(subjectIri, objectIri, predicateIriFull);
  return {
    id,
    source: String(subjectIri),
    target: String(objectIri),
    data: {
      propertyUri: String(predicateIriFull),
      propertyType: String(predicateIriFull),
      label: label || "",
    },
  };
}

/**
 * Add an edge payload into ontologyStore.currentGraph with deduplication.
 * This uses the store's setCurrentGraph (keeps other consumers unchanged).
 */
export function addEdgeToCurrentGraph(edge: EdgePayload) {
  try {
    const os = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : null;
    if (!os) return false;
    if (typeof os.setCurrentGraph === "function") {
      const cg = os.currentGraph || { nodes: [], edges: [] };
      const exists = (cg.edges || []).some((e: any) => {
        try {
          return String(e.id) === String(edge.id);
        } catch {
          return false;
        }
      });
      if (exists) return false;
      try {
        os.setCurrentGraph(cg.nodes || [], [...(cg.edges || []), edge]);
        return true;
      } catch {
        // fallback: direct setState if available
        try {
          (useOntologyStore as any).setState({ currentGraph: { nodes: cg.nodes || [], edges: [...(cg.edges || []), edge] } });
          return true;
        } catch {
          return false;
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}
