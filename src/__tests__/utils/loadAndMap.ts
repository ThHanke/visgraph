import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import { namedNode } from "n3";
import { useOntologyStore } from "../../stores/ontologyStore";

/**
 * Helper: map quads in a named graph to a diagram using the project's pure mapper.
 *
 * Usage:
 *   const diagram = await mapGraphQuads("urn:vg:data");
 *
 * This helper reads quads from the rdfManager instance stored in useOntologyStore,
 * snapshots availableProperties so the mapper makes the same fat-map decisions as
 * the running app, and returns the diagram { nodes, edges } produced by mapQuadsToDiagram.
 *
 * It deliberately does NOT mutate the store; it only reads and maps.
 */
export async function mapGraphQuads(graphName = "urn:vg:data") {
  try {
    const os = useOntologyStore.getState();
    const mgr = os && os.rdfManager ? os.rdfManager : null;
    if (!mgr || typeof mgr.getStore !== "function") return { nodes: [], edges: [] };
    const g = graphName ? namedNode(String(graphName)) : null;
    const quads = (g ? mgr.getStore().getQuads(null, null, null, g) : mgr.getStore().getQuads(null, null, null, null)) || [];
    const propsSnapshot = Array.isArray(os.availableProperties) ? os.availableProperties.slice() : [];
    const diagram = mapQuadsToDiagram(quads, { availableProperties: propsSnapshot });
    return diagram;
  } catch (_) {
    return { nodes: [], edges: [] };
  }
}

export default mapGraphQuads;
