import { useOntologyStore } from "@/stores/ontologyStore";
import { DataFactory } from "n3";
const { namedNode, quad } = DataFactory;

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
  // Migration: instead of writing into ontologyStore.currentGraph, persist the
  // canonical triple into the RDF manager store (urn:vg:data). This makes the
  // RDF store the single source of truth and lets downstream mapping pick up
  // the new edge via mapGraphToDiagram/mapRDFtoNodes.
  try {
    const os = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : null;
    const mgr =
      os && typeof (os as any).getRdfManager === "function"
        ? (os as any).getRdfManager()
        : os && (os as any).rdfManager
        ? (os as any).rdfManager
        : undefined;
    if (!mgr) return false;

    // Resolve store and helpers
    const store = mgr && typeof (mgr as any).getStore === "function" ? (mgr as any).getStore() : null;
    if (!store || typeof store.addQuad !== "function") {
      return false;
    }

    try {
      const subj = namedNode(String(edge.source));
      const pred = namedNode(String((edge.data && (edge.data.propertyUri || edge.data.propertyType)) || ""));
      const obj = namedNode(String(edge.target));
      // Graph used by the app for data triples
      const graphNode = namedNode("urn:vg:data");

      // Avoid adding duplicate quads by checking existing quads strictly
      try {
        const existing = store.getQuads(subj, pred, obj, graphNode) || [];
        if (existing && existing.length > 0) return false;
      } catch (_) {
        // if the check fails, proceed to add (best-effort)
      }

      try {
        store.addQuad(quad(subj, pred, obj, graphNode));
      } catch (e) {
        try {
          // Some store implementations expose addQuad differently; try alternative forms.
          if (typeof (store as any).add === "function") {
            (store as any).add(quad(subj, pred, obj, graphNode));
          } else {
            throw e;
          }
        } catch (_) {
          // If adding fails, give up.
          return false;
        }
      }

      // Legacy: previously signalled global one-shot layout/fit flags here.
      // Suppressed to avoid legacy mapping subscribers triggering repeated remaps.
      try {
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          try { console.debug("[VG] addEdgeToCurrentGraph: suppressed legacy __VG_REQUEST_* writes"); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }

      return true;
    } catch (_) {
      return false;
    }
  } catch (_) {
    return false;
  }
}
