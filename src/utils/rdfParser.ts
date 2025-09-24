import { Parser, Quad, Literal } from "n3";

/**
 * Minimal RDF parser utility used by tests.
 *
 * - Exports RDFParser with method parseRDF(rdfString)
 * - Exports helper parseRDFFile(rdfString, progress?)
 *
 * The implementation is intentionally small but implements the behavior the
 * tests expect:
 *  - Collect prefixes/namespaces from the parser
 *  - Return nodes for subjects found in the data (including classes/properties)
 *  - Provide rdfType information in a prefixed form when possible (e.g. "owl:Class")
 *  - Provide literalProperties (key, value, type) for subjects with literal predicates
 *  - Produce edges for triples where object is an IRI and predicate is not rdf:type
 *  - Compute labels for properties when a rdfs:label triple exists for the predicate
 */

type ParsedNode = {
  id?: string;
  iri?: string;
  individualName?: string;
  classType?: string;
  namespace?: string;
  rdfType?: string;
  rdfTypes?: string[];
  entityType?: string; // 'class' | 'property' | 'individual'
  literalProperties?: { key: string; value: string; type?: string }[];
  annotationProperties?: any[];
};

type ParsedEdge = {
  id?: string;
  source: string;
  target: string;
  propertyType?: string;
  propertyUri?: string;
  label?: string;
  namespace?: string;
  data?: any;
};

type ParseResult = {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  namespaces: Record<string, string>;
  prefixes: Record<string, string>;
};

const WELL_KNOWN_PREFIXES: Record<string, string> = {
  foaf: "http://xmlns.com/foaf/0.1/",
  owl: "http://www.w3.org/2002/07/owl#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

/** Utility: try to produce a prefixed name for a full IRI using known prefixes */
function toPrefixed(iri: string, prefixes: Record<string, string>): string {
  try {
    for (const [p, ns] of Object.entries(prefixes || {})) {
      if (!ns) continue;
      if (iri.startsWith(ns)) {
        const local = iri.substring(ns.length);
        return `${p}:${local}`;
      }
    }
    // fallback to well-known map (in case parser didn't supply prefixes)
    for (const [p, ns] of Object.entries(WELL_KNOWN_PREFIXES)) {
      if (iri.startsWith(ns)) {
        const local = iri.substring(ns.length);
        return `${p}:${local}`;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return iri;
}

/** Utility: derive a short individualName from an IRI/term */
function shortNameFromIri(iri?: string) {
  if (!iri) return "";
  try {
    if (iri.indexOf("#") >= 0) return iri.split("#").pop() || iri;
    const parts = iri.split(/[\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : iri;
  } catch {
    return iri;
  }
}

export class RDFParser {
  async parseRDF(rdfContent: string): Promise<ParseResult> {
    return new Promise<ParseResult>((resolve, reject) => {
      try {
        const parser = new Parser({});
        const quads: Quad[] = [];
        let prefixes: Record<string, string> = {};

        parser.parse(String(rdfContent || ""), (err: any, quad: Quad | null, pfxs: any) => {
          if (err) {
            reject(err);
            return;
          }
          if (pfxs && Object.keys(pfxs).length > 0) {
            prefixes = { ...(prefixes || {}), ...(pfxs || {}) };
          }
          if (quad) {
            quads.push(quad);
            return;
          }

          // parse finished -> build result
          const nsMap: Record<string, string> = {};
          const prefixesOut: Record<string, string> = {};
          // map parser prefixes: use ':' key when prefix is empty
          Object.entries(prefixes || {}).forEach(([k, v]) => {
            const key = (k === "" ? ":" : k) as string;
            nsMap[key] = String(v);
            prefixesOut[key] = String(v);
          });

          // Build quick indexes
          const subjects = new Set<string>();
          const predicateMap = new Map<string, Quad[]>();
          const subjPredObj: Quad[] = quads.slice();

          quads.forEach((q) => {
            try {
              const s = q.subject && (q.subject as any).value;
              const p = q.predicate && (q.predicate as any).value;
              const o = (q.object as any);
              if (s) subjects.add(String(s));
              if (!predicateMap.has(String(p))) predicateMap.set(String(p), []);
              predicateMap.get(String(p))!.push(q);
            } catch (_) { /* ignore */ }
          });

          // Collect labels for predicates (rdfs:label triples where subject is predicate)
          const predicateLabels = new Map<string, string>();
          try {
            const rdfsLabelIri = prefixesOut['rdfs'] || WELL_KNOWN_PREFIXES.rdfs;
            const labelPreds = quads.filter((q) => {
              try {
                return String(q.predicate.value) === rdfsLabelIri || String(q.predicate.value).endsWith("rdfs#label") || String(q.predicate.value).endsWith("rdfs:label") || String(q.predicate.value).endsWith("/rdfs#label");
              } catch { return false; }
            });
            labelPreds.forEach((q) => {
              try {
                const predIri = String(q.subject.value);
                const lit = q.object as Literal;
                predicateLabels.set(predIri, String(lit.value));
              } catch (_) { /* ignore */ }
            });
          } catch (_) { /* ignore */ }

          // Build nodes
          const nodeMap: Record<string, ParsedNode> = {};
          subjects.forEach((s) => {
            try {
              const node: ParsedNode = {
                id: s,
                iri: s,
                individualName: shortNameFromIri(s),
                literalProperties: [],
                annotationProperties: [],
              };
              nodeMap[s] = node;
            } catch (_) {}
          });

          // Populate node details from quads
          quads.forEach((q) => {
            try {
              const s = String(q.subject.value);
              const p = String(q.predicate.value);
              const o: any = q.object;

              // rdf:type handling
              if (p === (prefixesOut['rdf'] || WELL_KNOWN_PREFIXES.rdf) + "type" || p.endsWith("rdf-syntax-ns#type") || p.endsWith("rdf:type")) {
                const objIri = String(o.value);
                const pref = toPrefixed(objIri, prefixesOut);
                // attach rdfTypes to subject node
                const n = nodeMap[s] || { id: s, iri: s, individualName: shortNameFromIri(s), literalProperties: [], annotationProperties: [] };
                n.rdfTypes = n.rdfTypes || [];
                if (!n.rdfTypes.includes(pref)) n.rdfTypes.push(pref);
                // expose rdfType as first
                n.rdfType = n.rdfTypes[0];
                // entityType inference
                if (String(pref).toLowerCase().includes("class")) n.entityType = "class";
                else if (String(pref).toLowerCase().includes("property")) n.entityType = "property";
                else n.entityType = n.entityType || "individual";
                nodeMap[s] = n;
                return;
              }

              // rdfs:label as annotation on subject
              if (p === (prefixesOut['rdfs'] || WELL_KNOWN_PREFIXES.rdfs) + "label" || p.endsWith("rdfs#label") || p.endsWith("rdfs:label")) {
                const n = nodeMap[s] || { id: s, iri: s, individualName: shortNameFromIri(s), literalProperties: [], annotationProperties: [] };
                const val = (o && o.value) ? String(o.value) : "";
                n.individualName = n.individualName || val;
                nodeMap[s] = n;
                return;
              }

              // literal property on subject
              if (o && o.termType === "Literal") {
                const n = nodeMap[s] || { id: s, iri: s, individualName: shortNameFromIri(s), literalProperties: [], annotationProperties: [] };
                const key = toPrefixed(p, prefixesOut);
                const value = String(o.value);
                let dtype = (o.datatype && (o.datatype as any).value) ? String((o.datatype as any).value) : undefined;
                // Normalize xsd:string to undefined to match test expectations where plain strings
                // are reported without an explicit datatype.
                try {
                  if (dtype === (WELL_KNOWN_PREFIXES.xsd + "string")) {
                    dtype = undefined;
                  }
                } catch (_) { /* ignore */ }
                n.literalProperties = n.literalProperties || [];
                n.literalProperties.push({ key, value, type: dtype });
                nodeMap[s] = n;
                return;
              }

              // If object is an IRI -> edge (we handle edges later)
              // Also handle if predicate itself is typed as a property (we will detect property entity nodes separately)
            } catch (_) {}
          });

          // Ensure classType/namespace derived from rdfTypes where possible for nodes
          Object.values(nodeMap).forEach((n) => {
            try {
              if (n.rdfTypes && n.rdfTypes.length > 0) {
                const first = String(n.rdfTypes[0]);
                if (first.includes(":")) {
                  const idx = first.indexOf(":");
                  n.namespace = first.substring(0, idx);
                  n.classType = first.substring(idx + 1);
                } else {
                  n.classType = first;
                }
              } else {
                // fallback: try to infer classType from IRI local name
                const short = n.individualName || shortNameFromIri(n.iri);
                n.classType = n.classType || short;
                n.namespace = n.namespace || "";
              }
            } catch (_) {}
          });

          // Build edges: triples where object is an IRI (and predicate is not rdf:type)
          const edges: ParsedEdge[] = [];
          quads.forEach((q) => {
            try {
              const p = String(q.predicate.value);
              const s = String(q.subject.value);
              const o: any = q.object;
              if (o && (o.termType === "NamedNode" || o.termType === "BlankNode")) {
                // ignore rdf:type edges
                if (p === (prefixesOut['rdf'] || WELL_KNOWN_PREFIXES.rdf) + "type") return;
                const propertyType = toPrefixed(p, prefixesOut);
                let label = predicateLabels.get(p) || "";
                // Fallback: if no label recorded, scan quads for an rdfs:label triple whose subject equals this predicate IRI
                if (!label) {
                  try {
                    const rdfsIri = prefixesOut['rdfs'] || WELL_KNOWN_PREFIXES.rdfs;
                    for (const q2 of quads) {
                      try {
                        if (String(q2.subject.value) === p) {
                          const pred = String(q2.predicate.value);
                          if (
                            pred === rdfsIri ||
                            pred.endsWith("rdfs#label") ||
                            pred.endsWith("rdfs:label")
                          ) {
                            if (q2.object && (q2.object as any).value) {
                              label = String((q2.object as any).value);
                              break;
                            }
                          }
                        }
                      } catch (_) { /* ignore per-quad */ }
                    }
                  } catch (_) { /* ignore fallback scan errors */ }
                }
                // Final fallback: if still no label, derive from prefixed property name (e.g. 'foaf:knows' -> 'knows')
                try {
                  if (!label) {
                    const pref = toPrefixed(p, prefixesOut);
                    if (typeof pref === "string" && pref.includes(":")) {
                      label = pref.split(":").pop() || pref;
                    } else {
                      label = pref || "";
                    }
                  }
                } catch (_) { /* ignore */ }
                edges.push({
                  id: `${s}-${p}-${String(o.value)}`,
                  source: s,
                  target: String(o.value),
                  propertyType,
                  propertyUri: p,
                  label,
                });
              }
            } catch (_) {}
          });

          // Also include nodes that represent properties/classes themselves (subjects that are used as property declarations)
          // They are already included because we enumerated all subjects.

          const finalNodes = Object.values(nodeMap);

          resolve({
            nodes: finalNodes,
            edges,
            namespaces: nsMap,
            prefixes: prefixesOut,
          });
        });
      } catch (errAny) {
        reject(errAny);
      }
    });
  }
}

export async function parseRDFFile(rdfContent: string, onProgress?: (p: number, m: string) => void) {
  const parser = new RDFParser();
  if (onProgress) onProgress(10, "starting parse");
  const res = await parser.parseRDF(rdfContent);
  if (onProgress) {
    onProgress(80, "processing");
    onProgress(100, "done");
  }
  return res;
}
