// src/workers/entailmentProbe.ts
//
// TODO(rdf-reasoner-konclude): this module will be ported to the reasoner
// package as an internal module of explainEntailment() (plan-050, Unit 2).
//
// Entailment-as-unsatisfiability reduction (Path B) for the entailment
// explanation channel ("why is A subClassOf B?" / "why is x of type C?").
//
// The live Konclude wrapper (rdfManager.runtime.ts) talks to the raw konclude
// worker.js over hand-rolled RPC and only exposes a consistency oracle
// (loadTripleBuffer → classification → consistency). It has no direct
// `isEntailed`/`explain` RPC. Rather than spawn the package's RdfReasoner (which
// would re-introduce the new URL("./worker.js", …) resolution bug the wrapper
// exists to work around), we reduce entailment to (in)consistency:
//
//   An axiom α is entailed by ontology O  ⇔  O ∪ ¬α is inconsistent.
//
// We materialise ¬α as a small set of PROBE triples added to the candidate set,
// run the SAME BlackBox justification search already used for
// explainInconsistency, then strip the probe triples out of every justification.
// What remains is a minimal subset of the ONTOLOGY's own axioms that entails α —
// i.e. a Horridge-style justification for the entailment.
//
// Supported axiom shapes (object must be an IRI / class, not a literal):
//   • subClassOf:  A rdfs:subClassOf B
//        ¬α  =  { _x a A ; _x a [ a owl:Class ; owl:complementOf B ] }
//        (A non-empty whose every member is outside B → A ⊑ B fails;
//         forcing a member of A into ¬B and asking for unsatisfiability gives ⊑.)
//   • rdf:type:    s rdf:type C
//        ¬α  =  { s a [ a owl:Class ; owl:complementOf C ] }
//
// This module is pure (no reasoner, no Worker) so the probe construction is
// unit-testable in isolation. The caller supplies an N3 DataFactory.

export const RDF_TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
export const RDFS_SUBCLASSOF_URI = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
export const OWL_CLASS_URI = "http://www.w3.org/2002/07/owl#Class";
export const OWL_COMPLEMENT_OF_URI = "http://www.w3.org/2002/07/owl#complementOf";

/** Minimal subset of the N3 DataFactory surface this module needs. */
export interface ProbeDataFactory {
  namedNode(value: string): unknown;
  blankNode(value?: string): unknown;
  quad(s: unknown, p: unknown, o: unknown, g?: unknown): unknown;
  defaultGraph(): unknown;
}

export type ProbeKind = "subClassOf" | "type" | "unsupported";

export interface ProbePlan<Q = unknown> {
  /** Which reduction shape was selected for the requested axiom. */
  kind: ProbeKind;
  /**
   * The probe quads encoding ¬axiom. Added to the ontology's candidate set;
   * if the union is inconsistent the axiom is entailed. Empty for "unsupported".
   */
  probeQuads: Q[];
  /**
   * Stable keys ("s\0p\0o") of the probe quads so the caller can strip them out
   * of any returned justification. Built from the SAME term values used in
   * probeQuads, so matching is exact.
   */
  probeKeys: Set<string>;
  /** Reason a shape is unsupported (for diagnostics); undefined when supported. */
  reason?: string;
}

/** Stable string key for a triple by its term .value fields. */
export function tripleKey(s: string, p: string, o: string): string {
  return `${s}\0${p}\0${o}`;
}

/**
 * Classify the requested axiom into a probe shape. Pure — no reasoner.
 * `objectIsClassLike` is true when the object IRI denotes a class/IRI (not a
 * literal); the reduction only applies to IRI objects.
 */
export function classifyAxiom(
  predicateIri: string,
  objectIsClassLike: boolean,
): ProbeKind {
  if (!objectIsClassLike) return "unsupported";
  if (predicateIri === RDFS_SUBCLASSOF_URI) return "subClassOf";
  if (predicateIri === RDF_TYPE_URI) return "type";
  return "unsupported";
}

/**
 * Build the probe (¬axiom) triples for the requested axiom using a unique
 * blank-node prefix so the injected terms can never collide with ontology terms.
 *
 * @param df            N3 DataFactory (or compatible).
 * @param subjectIri    axiom subject IRI.
 * @param predicateIri  axiom predicate IRI.
 * @param objectIri     axiom object IRI.
 * @param objectIsClassLike  true when the object is an IRI (not a literal).
 * @param probeId       unique suffix for the injected blank nodes (default "p0").
 */
export function buildEntailmentProbe<Q>(
  df: ProbeDataFactory,
  subjectIri: string,
  predicateIri: string,
  objectIri: string,
  objectIsClassLike: boolean,
  probeId = "p0",
): ProbePlan<Q> {
  const kind = classifyAxiom(predicateIri, objectIsClassLike);
  if (kind === "unsupported") {
    return {
      kind,
      probeQuads: [],
      probeKeys: new Set(),
      reason: objectIsClassLike
        ? `predicate ${predicateIri} is not a supported entailment shape (only rdfs:subClassOf and rdf:type)`
        : "object is a literal; the entailment reduction requires an IRI object",
    };
  }

  const g = df.defaultGraph();
  const owlClass = df.namedNode(OWL_CLASS_URI);

  // Fresh, collision-proof terms for ¬axiom.
  const negClass = df.blankNode(`vg_neg_${probeId}`); // [ a owl:Class ; owl:complementOf <obj> ]
  const objNode = df.namedNode(objectIri);

  const quads: Q[] = [];
  const keys = new Set<string>();
  const push = (s: unknown, sKey: string, p: string, o: unknown, oKey: string): void => {
    quads.push(df.quad(s, df.namedNode(p), o, g) as Q);
    keys.add(tripleKey(sKey, p, oKey));
  };

  // Common: the complement class  [ a owl:Class ; owl:complementOf <obj/B/C> ]
  // Blank-node .value is the bare label (no "_:" prefix), so keys use the bare
  // label to match `${quad.subject.value}\0…` exactly when stripping probes.
  const negClassKey = `vg_neg_${probeId}`;
  push(negClass, negClassKey, RDF_TYPE_URI, owlClass, OWL_CLASS_URI);
  push(negClass, negClassKey, OWL_COMPLEMENT_OF_URI, objNode, objectIri);

  if (kind === "subClassOf") {
    // A ⊑ B  ⇔  { A ⊑ ¬B , _w a A } inconsistent.
    //
    // The negation must be at the TBox level (A rdfs:subClassOf ¬B) plus a
    // witness instance forcing A to be non-empty. Konclude does NOT enforce a
    // purely ABox complement assertion (_x a ¬B), so the individual-level form
    // is unsound here — verified empirically against the real reasoner.
    const subjNode = df.namedNode(subjectIri); // A
    const witness = df.blankNode(`vg_wit_${probeId}`);
    const witnessKey = `vg_wit_${probeId}`;
    push(subjNode, subjectIri, RDFS_SUBCLASSOF_URI, negClass, negClassKey);
    push(witness, witnessKey, RDF_TYPE_URI, subjNode, subjectIri);
  } else {
    // s rdf:type C  ⇔  { s a ¬C } inconsistent. The ABox complement assertion
    // IS enforced for a concrete individual that is independently derivable
    // into C (verified empirically against the real reasoner).
    const subjNode = df.namedNode(subjectIri); // s
    push(subjNode, subjectIri, RDF_TYPE_URI, negClass, negClassKey);
  }

  return { kind, probeQuads: quads, probeKeys: keys };
}
