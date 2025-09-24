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
 * Uses subject, predicate and object IRIs (all exact strings, no encoding or fallbacks).
 * The id format is: `${subjectIri}-${predicateIriFull}-${objectIri}` to match the
 * canonical triple ordering (source-predicate-target). Callers must pass full IRIs.
 */
export function generateEdgeId(subjectIri: string, objectIri: string, predicateIriFull: string): string {
  const subj = String(subjectIri || "");
  const pred = String(predicateIriFull || "");
  const obj = String(objectIri || "");
  return `${subj}-${pred}-${obj}`;
}
