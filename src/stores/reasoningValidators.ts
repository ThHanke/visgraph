import { DataFactory } from "n3";
const { namedNode, quad } = DataFactory;

/**
 * runDomainRangeChecks
 *
 * Scans the provided rdfStore for used predicates that declare rdfs:domain or
 * rdfs:range and emits SHACL ValidationResult triples into the provided
 * inferredGraph (namedNode('urn:vg:inferred')) for any usage that appears to
 * violate the declared domain/range.
 *
 * This is intentionally conservative:
 * - If a subject has no rdf:type or none of its rdf:types match the declared domain,
 *   we emit a sh:ValidationResult with sh:Warning.
 * - If an object is a NamedNode and has no rdf:type matching the declared range, we emit a Warning.
 *
 * The function attempts to be robust across different rdfStore shapes (N3.Store or
 * RDF manager wrappers) by using rdfStore.getQuads/addQuad if available.
 */
export async function runDomainRangeChecks(rdfStore: any) {
  if (!rdfStore || typeof rdfStore.getQuads !== "function") return;

  const inferredGraph = namedNode("urn:vg:inferred");
  const rdfsDomain = namedNode("http://www.w3.org/2000/01/rdf-schema#domain");
  const rdfsRange = namedNode("http://www.w3.org/2000/01/rdf-schema#range");
  const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
  const shValidation = namedNode("http://www.w3.org/ns/shacl#ValidationResult");
  const shFocus = namedNode("http://www.w3.org/ns/shacl#focusNode");
  const shMessage = namedNode("http://www.w3.org/ns/shacl#resultMessage");
  const shSeverity = namedNode("http://www.w3.org/ns/shacl#resultSeverity");
  const shWarning = namedNode("http://www.w3.org/ns/shacl#Warning");
  const shViolation = namedNode("http://www.w3.org/ns/shacl#Violation");

  try {
    // Collect predicates actually used in the graph
    const usedPreds = new Set<string>();
    const allTriples = rdfStore.getQuads(null, null, null, null) || [];
    for (const t of allTriples) {
      if (t && t.predicate && t.predicate.value) usedPreds.add(String(t.predicate.value));
    }

    for (const predUri of Array.from(usedPreds)) {
      try {
        const predNode = namedNode(predUri);

        // Find declared domains/ranges (may appear in any graph)
        const domainQuads = rdfStore.getQuads(predNode, rdfsDomain, null, null) || [];
        const rangeQuads = rdfStore.getQuads(predNode, rdfsRange, null, null) || [];

        if (domainQuads.length === 0 && rangeQuads.length === 0) continue;

        // Find all usage triples for this predicate
        const usage = rdfStore.getQuads(null, predNode, null, null) || [];

        // Precompute declared domain and range IRIs
        const domains = domainQuads.map((q: any) => q.object && q.object.value ? String(q.object.value) : null).filter(Boolean);
        const ranges = rangeQuads.map((q: any) => q.object && q.object.value ? String(q.object.value) : null).filter(Boolean);

        for (const u of usage) {
          try {
            const subj = u.subject;
            const obj = u.object;

            // Check subject types against declared domains
            if (domains.length > 0) {
              const subjTypes = (rdfStore.getQuads(subj, rdfType, null, null) || []).map((q: any) => (q.object && q.object.value ? String(q.object.value) : ""));
              // If no subj type or none matches declared domains, emit a warning
              const matchesDomain = subjTypes.some((t: string) => domains.includes(t));
              if (!matchesDomain) {
                // emit sh:ValidationResult into inferredGraph
                const resBNode = DataFactory.blankNode();
                const msg = `Predicate ${predUri} used with subject ${subj.value || String(subj)} does not match declared domain ${domains.join(", ")}`;
                try {
                  rdfStore.addQuad(quad(resBNode, namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), shValidation, inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shFocus, subj, inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shMessage, DataFactory.literal(msg), inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shSeverity, shWarning, inferredGraph));
                } catch (_) {
                  // best-effort writing
                }
              }
            }

            // Check object types against declared ranges (only for NamedNode objects)
            if (ranges.length > 0 && obj && obj.termType === "NamedNode") {
              const objTypes = (rdfStore.getQuads(obj, rdfType, null, null) || []).map((q: any) => (q.object && q.object.value ? String(q.object.value) : ""));
              const matchesRange = objTypes.some((t: string) => ranges.includes(t));
              if (!matchesRange) {
                const resBNode = DataFactory.blankNode();
                const msg = `Predicate ${predUri} used with object ${obj.value || String(obj)} does not match declared range ${ranges.join(", ")}`;
                try {
                  rdfStore.addQuad(quad(resBNode, namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), shValidation, inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shFocus, obj, inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shMessage, DataFactory.literal(msg), inferredGraph));
                  rdfStore.addQuad(quad(resBNode, shSeverity, shWarning, inferredGraph));
                } catch (_) {
                  // best-effort
                }
              }
            }
          } catch (_) { /* per-usage */ }
        }
      } catch (_) { /* per-predicate */ }
    }
  } catch (e) {
    console.debug("[VG_DEBUG] domain/range validator failed:", e && (e.message || e));
  }
}
