import { NamedNode, Literal, Quad, DataFactory } from "n3";
const { namedNode } = DataFactory;

/**
 * Compute a parsed-graph-like shape from an existing rdfManager store.
 *
 * This is a small, deterministic adapter that mirrors the minimal shape
 * previously produced by src/utils/rdfParser.ts but computes everything
 * from the RDFManager's authoritative store instead of re-parsing raw content.
 *
 * Returned shape:
 * {
 *   nodes: Array<{ id, iri, classType, namespace, rdfTypes, literalProperties, annotationProperties }>,
 *   edges: Array<{ id, source, target, propertyType, propertyUri, label, namespace }>,
 *   namespaces: Record<string,string>,
 *   prefixes: Record<string,string>
 * }
 *
 * Note: This function intentionally produces stable, deterministic results
 * and does not add positions. It is designed to be used by ontologyStore
 * after rdfManager.loadRDFIntoGraph(...) has populated the store.
 */
export async function computeParsedFromStore(rdfManager: any, graphName?: string | null) {
  if (!rdfManager || typeof rdfManager.getStore !== "function") {
    return { nodes: [], edges: [], namespaces: {}, prefixes: {} };
  }

  const prefixes = (typeof rdfManager.getNamespaces === "function")
    ? rdfManager.getNamespaces()
    : (rdfManager.namespaces || {});

  const namespaces = { ...(prefixes || {}) };

  const store = rdfManager.getStore();
  const g: any = graphName ? namedNode(String(graphName)) : null;

  const allQuads: Quad[] = (g ? store.getQuads(null, null, null, g) : store.getQuads(null, null, null, null)) || [];

  // collect unique subjects (only NamedNode and BlankNode)
  const subjectsSet = new Set<string>();
  for (const q of allQuads) {
    try {
      if (q.subject && q.subject.value) subjectsSet.add(String(q.subject.value));
      if (q.object && (q.object as any).termType === "BlankNode" && (q.object as any).value) {
        // blank node subjects may appear as objects referenced elsewhere; include them as potential subjects
        subjectsSet.add(String((q.object as any).value));
      }
    } catch (_) { /* ignore */ }
  }
  const subjects = Array.from(subjectsSet);

  // helper: find prefix for a full IRI using manager prefixes (prefer longest match)
  function findPrefixForUri(uri: string): { prefix: string; local: string } {
    try {
      if (!uri) return { prefix: "", local: uri };
      for (const [p, ns] of Object.entries(prefixes || {})) {
        try {
          if (!ns) continue;
          if (uri.startsWith(ns)) {
            const local = uri.substring(String(ns).length);
            const prefix = p === ":" ? "" : String(p);
            return { prefix, local };
          }
        } catch (_) { /* ignore per-entry */ }
      }
    } catch (_) { /* ignore */ }
    // fallback: split on last / or #
    try {
      const idx = Math.max(uri.lastIndexOf("/"), uri.lastIndexOf("#"));
      if (idx > -1) {
        return { prefix: "", local: uri.substring(idx + 1) };
      }
    } catch (_) { void 0; }
    return { prefix: "", local: uri };
  }

  // Build nodes
  const nodes: any[] = [];
  const RDF_TYPE = typeof rdfManager.expandPrefix === "function" ? rdfManager.expandPrefix("rdf:type") : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const RDFS_LABEL = typeof rdfManager.expandPrefix === "function" ? rdfManager.expandPrefix("rdfs:label") : "http://www.w3.org/2000/01/rdf-schema#label";

  for (const subjIri of subjects) {
    try {
      const subjNode = namedNode(subjIri);
      // types
      const typeQuads = (g ? store.getQuads(subjNode, namedNode(RDF_TYPE), null, g) : store.getQuads(subjNode, namedNode(RDF_TYPE), null, null)) || [];
      const rdfTypes: string[] = [];
      for (const tq of typeQuads) {
        try {
          if ((tq.object as any).termType === "NamedNode") {
            const uri = (tq.object as any).value;
            const { prefix, local } = findPrefixForUri(uri);
            rdfTypes.push(prefix ? `${prefix}:${local}` : uri);
          }
        } catch (_) { /* ignore */ }
      }

      // literal properties
      const litQuads = (g ? store.getQuads(subjNode, null, null, g) : store.getQuads(subjNode, null, null, null)) || [];
      const literalProperties: Array<{ key: string; value: string; type?: string }> = [];
      const annotationProperties: Array<{ propertyUri: string; value: string }> = [];

      for (const lq of litQuads) {
        try {
          const obj = lq.object as any;
          if (!obj) continue;
          if (obj.termType === "Literal") {
            const predUri = (lq.predicate as NamedNode).value;
            const { prefix, local } = findPrefixForUri(predUri);
            const key = prefix ? `${prefix}:${local}` : predUri;
            const dtype = obj.datatype && (obj.datatype as NamedNode).value ? (obj.datatype as NamedNode).value : undefined;
            // Treat rdfs:label and common annotation predicates as annotationProperties
            if (predUri === RDFS_LABEL) {
              annotationProperties.push({ propertyUri: key, value: String(obj.value) });
            } else {
              literalProperties.push({ key, value: String(obj.value), type: dtype });
            }
          }
        } catch (_) { /* ignore per-quad */ }
      }

      // derive classType/namespace from rdfTypes (prefer first non-NamedIndividual)
      let classType = "";
      let namespace = "";
      try {
        if (rdfTypes && rdfTypes.length > 0) {
          const nonNamed = rdfTypes.find((t) => t && !/NamedIndividual/i.test(String(t)));
          const chosen = nonNamed || rdfTypes[0];
          if (chosen) {
            if (chosen.includes(":")) {
              const idx = chosen.indexOf(":");
              namespace = chosen.substring(0, idx);
              classType = chosen.substring(idx + 1);
            } else {
              classType = chosen;
            }
          }
        }
      } catch (_) { /* ignore */ }

      nodes.push({
        id: subjIri,
        iri: subjIri,
        classType,
        individualName: findPrefixForUri(subjIri).local,
        namespace,
        rdfType: rdfTypes.length > 0 ? rdfTypes[0] : "",
        rdfTypes,
        entityType: "individual",
        literalProperties,
        annotationProperties,
        data: {},
      });
    } catch (_) { /* ignore per-subject */ }
  }

  // Build edges: relationships where object is a NamedNode and both endpoints are present
  const subjectSet = new Set(subjects);
  const edgesMap = new Map<string, any>();
  for (const q of allQuads) {
    try {
      const obj = q.object as any;
      if (!obj) continue;
      if (obj.termType === "NamedNode") {
        const sub = q.subject && (q.subject as any).value;
        const objv = obj.value;
        const pred = (q.predicate as NamedNode).value;
        if (!sub || !objv) continue;
        // ignore rdf:type relationships
        if (pred === RDF_TYPE) continue;
        // only include edges where both ends are subjects we collected
        if (!subjectSet.has(sub) || !subjectSet.has(objv)) continue;

        const { prefix, local } = findPrefixForUri(pred);
        const propertyType = prefix ? `${prefix}:${local}` : pred;
        const edgeId = `${sub}-${objv}-${local}`;

        if (!edgesMap.has(edgeId)) {
          // try to find rdfs:label for the predicate in the store (any graph)
          let label = local;
          try {
            const labelQuads = store.getQuads(namedNode(pred), namedNode(RDFS_LABEL), null, null) || [];
            if (labelQuads.length > 0) {
              const lab = labelQuads[0].object as Literal;
              label = String(lab.value || local);
            }
          } catch (_) { /* ignore label lookup */ }

          edgesMap.set(edgeId, {
            id: edgeId,
            source: sub,
            target: objv,
            propertyType,
            propertyUri: pred,
            label,
            namespace: prefix || "",
            rdfType: `${prefix ? prefix : ""}:${local}`,
            data: {},
          });
        }
      }
    } catch (_) { /* ignore per-quad */ }
  }

  const edges = Array.from(edgesMap.values());

  return {
    nodes,
    edges,
    namespaces,
    prefixes,
  };
}

export default computeParsedFromStore;
