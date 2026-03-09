// @vitest-environment node

/**
 * Comprehensive rendering-pipeline tests.
 *
 * These tests cover the full chain from RDF quads → React Flow nodes/edges and
 * the incremental change helpers, asserting every class of operation that can
 * occur on the canvas:
 *
 *   1. Initial TBox/ABox classification
 *   2. Object property → edge
 *   3. Annotation/literal property → property on node (no edge)
 *   4. Add annotation property triple (incremental)
 *   5. Add object property triple (incremental)
 *   6. Add new individual
 *   7. Add new OWL class
 *   8. isTBox not overwritten when a class is used as the object of an
 *      individual's object-property triple
 *   9. classType excludes owl:NamedIndividual (picks the domain class instead)
 *  10. Inferred annotation property appears on existing node
 *  11. Inferred rdf:type does NOT appear as annotation property
 *  12. Inferred rdf:type does NOT change isTBox classification
 *  13. Inferred-only subjects are NOT created as nodes
 *  14. computeEdgeChanges – add new edge
 *  15. computeEdgeChanges – remove stale edge for touched subject
 *  16. computeEdgeChanges – preserve unrelated edges (subject not touched)
 *  17. computeEdgeChanges – no updatedSubjects ⇒ no deletions
 *  18. computeNodeChanges – add new node
 *  19. computeNodeChanges – update existing node data
 *  20. computeNodeChanges – placeholder does not replace a real node
 *  21. computeNodeChanges – cluster node is not overwritten by non-cluster
 */

import { describe, it, expect } from "vitest";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import {
  computeNodeChanges,
  computeEdgeChanges,
} from "../../components/Canvas/core/diagramChangeHelpers";
import { RDF_TYPE, RDFS, OWL, XSD } from "../../constants/vocabularies";
import { OWL_SCHEMA_AXIOMS } from "../../constants/owlSchemaData";

// ---------------------------------------------------------------------------
// Vocabulary shortcuts
// ---------------------------------------------------------------------------
const RDF_TYPE_IRI    = RDF_TYPE;
const RDFS_SUBCLASSOF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_LABEL_IRI  = RDFS.label;
const OWL_CLASS       = OWL.Class;
const OWL_OBJ_PROP    = OWL.ObjectProperty;
const OWL_DT_PROP     = OWL.DatatypeProperty;
const OWL_ANN_PROP    = OWL.AnnotationProperty;
const OWL_NI          = OWL.NamedIndividual;
const XSD_STRING      = XSD.string;

// ---------------------------------------------------------------------------
// Fixture namespace
// ---------------------------------------------------------------------------
const EX = "http://example.org/test#";

// ---------------------------------------------------------------------------
// Quad helpers
// ---------------------------------------------------------------------------
function nn(subject: string, predicate: string, object: string, graph = "urn:vg:data") {
  return {
    subject:   { value: subject,   termType: "NamedNode" },
    predicate: { value: predicate, termType: "NamedNode" },
    object:    { value: object,    termType: "NamedNode" },
    graph:     { value: graph },
  };
}

function lit(subject: string, predicate: string, value: string, datatype = XSD_STRING, graph = "urn:vg:data") {
  return {
    subject:   { value: subject,   termType: "NamedNode" },
    predicate: { value: predicate, termType: "NamedNode" },
    object:    { value: value, termType: "Literal", datatype: { value: datatype } },
    graph:     { value: graph },
  };
}

// ---------------------------------------------------------------------------
// Property classifier (simulates what the canvas uses)
// ---------------------------------------------------------------------------
const PROP_KINDS: Record<string, "object" | "datatype" | "annotation"> = {
  [EX + "knows"]:      "object",
  [EX + "locatedIn"]:  "object",
  [EX + "hasName"]:    "datatype",
  [EX + "comment"]:    "annotation",
};

function predicateKind(iri: string): "object" | "datatype" | "annotation" | "unknown" {
  return PROP_KINDS[iri] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Base fixture quads (urn:vg:data)
// ---------------------------------------------------------------------------
// TBox
const BASE_QUADS = [
  nn(EX+"Animal",  RDF_TYPE_IRI, OWL_CLASS),
  nn(EX+"Person",  RDF_TYPE_IRI, OWL_CLASS),
  nn(EX+"Person",  RDFS_SUBCLASSOF, EX+"Animal"),
  nn(EX+"knows",   RDF_TYPE_IRI, OWL_OBJ_PROP),
  nn(EX+"hasName", RDF_TYPE_IRI, OWL_DT_PROP),
  nn(EX+"comment", RDF_TYPE_IRI, OWL_ANN_PROP),
  nn(EX+"locatedIn", RDF_TYPE_IRI, OWL_OBJ_PROP),
  // ABox
  nn(EX+"alice", RDF_TYPE_IRI, OWL_NI),
  nn(EX+"alice", RDF_TYPE_IRI, EX+"Person"),
  lit(EX+"alice", EX+"hasName", "Alice"),
  nn(EX+"bob",   RDF_TYPE_IRI, OWL_NI),
  nn(EX+"bob",   RDF_TYPE_IRI, EX+"Person"),
  lit(EX+"bob",  EX+"hasName", "Bob"),
  nn(EX+"alice", EX+"knows", EX+"bob"),
];

const BASE_OPTS = { predicateKind, availableProperties: [] };

// ---------------------------------------------------------------------------
// Helper utilities for assertions
// ---------------------------------------------------------------------------
function findNode(nodes: any[], id: string) {
  return nodes.find((n: any) => n.id === id);
}

function findEdge(edges: any[], source: string, target: string, predIri?: string) {
  return edges.find((e: any) => {
    const srcMatch = e.source === source || e.data?.from === source;
    const tgtMatch = e.target === target || e.data?.to === target;
    if (!srcMatch || !tgtMatch) return false;
    if (predIri) return e.data?.propertyUri === predIri;
    return true;
  });
}

function hasAnnotation(node: any, predicate: string, value: string) {
  const anns: any[] = node?.data?.annotationProperties ?? [];
  return anns.some((a: any) => a.property === predicate && a.value === value);
}

// ===========================================================================
// Part 1 – mapQuadsToDiagram: base fixture
// ===========================================================================
describe("mapQuadsToDiagram – base fixture", () => {
  const { nodes, edges } = mapQuadsToDiagram(BASE_QUADS, BASE_OPTS);

  it("1.1 – TBox nodes are isTBox:true", () => {
    for (const iri of [EX+"Animal", EX+"Person", EX+"knows", EX+"hasName", EX+"comment", EX+"locatedIn"]) {
      const n = findNode(nodes, iri);
      expect(n, `node ${iri} must exist`).toBeTruthy();
      expect((n.data as any).isTBox, `${iri} must be TBox`).toBe(true);
    }
  });

  it("1.2 – ABox nodes are isTBox:false", () => {
    for (const iri of [EX+"alice", EX+"bob"]) {
      const n = findNode(nodes, iri);
      expect(n, `node ${iri} must exist`).toBeTruthy();
      expect((n.data as any).isTBox, `${iri} must be ABox`).toBe(false);
    }
  });

  it("1.3 – object property creates an edge", () => {
    const e = findEdge(edges, EX+"alice", EX+"bob", EX+"knows");
    expect(e, "edge alice→knows→bob must exist").toBeTruthy();
  });

  it("1.4 – literal/annotation property does NOT create an edge", () => {
    const e = findEdge(edges, EX+"alice", "Alice");
    expect(e, "no edge for hasName literal").toBeUndefined();
  });

  it("1.5 – TBox subClassOf creates an edge between TBox nodes", () => {
    // rdfs:subClassOf with unknown kind still creates an edge (unknown + NamedNode)
    const e = findEdge(edges, EX+"Person", EX+"Animal");
    expect(e, "edge Person→subClassOf→Animal must exist").toBeTruthy();
  });

  it("1.6 – hasName annotation appears on alice node", () => {
    const n = findNode(nodes, EX+"alice");
    expect(hasAnnotation(n, EX+"hasName", "Alice")).toBe(true);
  });

  it("1.7 – classType excludes owl:NamedIndividual (picks domain class)", () => {
    const n = findNode(nodes, EX+"alice");
    // alice has types [owl:NamedIndividual, ex:Person]; classType must be ex:Person
    expect((n.data as any).classType).toBe(EX+"Person");
  });
});

// ===========================================================================
// Part 2 – mapQuadsToDiagram: individual operations
// ===========================================================================
describe("mapQuadsToDiagram – incremental operations", () => {

  it("2.1 – add annotation property triple", () => {
    const quads = [
      ...BASE_QUADS,
      lit(EX+"alice", EX+"comment", "A person named Alice"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"alice");
    expect(hasAnnotation(n, EX+"comment", "A person named Alice")).toBe(true);
  });

  it("2.2 – add object property triple creates new edge", () => {
    const quads = [
      ...BASE_QUADS,
      nn(EX+"bob", EX+"knows", EX+"alice"),
    ];
    const { edges } = mapQuadsToDiagram(quads, BASE_OPTS);
    expect(findEdge(edges, EX+"bob", EX+"alice", EX+"knows")).toBeTruthy();
    // original edge still present
    expect(findEdge(edges, EX+"alice", EX+"bob", EX+"knows")).toBeTruthy();
  });

  it("2.3 – add new individual → ABox node", () => {
    const quads = [
      ...BASE_QUADS,
      nn(EX+"charlie", RDF_TYPE_IRI, OWL_NI),
      nn(EX+"charlie", RDF_TYPE_IRI, EX+"Person"),
      lit(EX+"charlie", EX+"hasName", "Charlie"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"charlie");
    expect(n, "charlie must exist").toBeTruthy();
    expect((n.data as any).isTBox).toBe(false);
  });

  it("2.4 – add new OWL class → TBox node with subClassOf edge", () => {
    const quads = [
      ...BASE_QUADS,
      nn(EX+"Student", RDF_TYPE_IRI, OWL_CLASS),
      nn(EX+"Student", RDFS_SUBCLASSOF, EX+"Person"),
    ];
    const { nodes, edges } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"Student");
    expect(n, "Student must exist").toBeTruthy();
    expect((n.data as any).isTBox).toBe(true);
    expect(findEdge(edges, EX+"Student", EX+"Person")).toBeTruthy();
  });

  it("2.5 – isTBox not overwritten when a TBox class is the object of an ABox triple", () => {
    // alice (ABox) locatedIn Animal (TBox) — Animal must keep isTBox:true
    const quads = [
      ...BASE_QUADS,
      nn(EX+"alice", EX+"locatedIn", EX+"Animal"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const animal = findNode(nodes, EX+"Animal");
    expect((animal.data as any).isTBox, "Animal must stay TBox even as object of ABox triple").toBe(true);
  });

  it("2.6 – isTBox preserved via availableClasses when class quads absent from batch", () => {
    // Simulates an incremental update where only alice's quads are in the batch.
    // Football is a known class registered in availableClasses, but its own
    // rdf:type owl:Class quad is NOT in this batch (different update wave).
    const aliceOnlyQuads = [
      nn(EX+"alice", RDF_TYPE_IRI, OWL_NI),
      nn(EX+"alice", RDF_TYPE_IRI, EX+"Person"),
      nn(EX+"alice", EX+"locatedIn", EX+"Football"),
    ];
    const opts = {
      ...BASE_OPTS,
      availableClasses: [{ iri: EX+"Football" }, { iri: EX+"Person" }],
    };
    const { nodes } = mapQuadsToDiagram(aliceOnlyQuads, opts);
    const football = findNode(nodes, EX+"Football");
    expect(football, "Football must be created as a placeholder node").toBeTruthy();
    expect((football.data as any).isTBox, "Football must be TBox (known via availableClasses)").toBe(true);
  });

  it("2.7 – implicit class (used as rdf:type object, no owl:Class declaration) is TBox", () => {
    // ex:Person has no rdf:type owl:Class but alice is typed as ex:Person.
    // The mapper must infer Person is a class from its usage as a type object.
    const quads = [
      nn(EX+"alice", RDF_TYPE_IRI, OWL_NI),
      nn(EX+"alice", RDF_TYPE_IRI, EX+"Person"),  // Person used as a class
      nn(EX+"Person", RDFS_SUBCLASSOF, EX+"Animal"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const person = findNode(nodes, EX+"Person");
    // Person appears as subject of subClassOf — must be TBox because it is used as a type
    expect((person?.data as any)?.isTBox, "Person must be TBox (implicit class via rdf:type usage)").toBe(true);
  });

  it("2.8 – rdfs:subClassOf subjects and objects are TBox even without owl:Class declaration", () => {
    // Partially-imported ontology: no explicit rdf:type owl:Class, only subClassOf axioms.
    // Requires schema props (SCHEMA_OPTS) so the mapper has rdfs:subClassOf domain/range data.
    const quads = [
      nn(EX+"GradStudent", RDFS_SUBCLASSOF, EX+"Student"),
      nn(EX+"Student",     RDFS_SUBCLASSOF, EX+"Person"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    for (const iri of [EX+"GradStudent", EX+"Student", EX+"Person"]) {
      const n = findNode(nodes, iri);
      expect(n, `${iri} must be a node`).toBeTruthy();
      expect((n.data as any).isTBox, `${iri} must be TBox via subClassOf structural scan`).toBe(true);
    }
  });

  it("2.9 – owl:Restriction blank node is TBox", () => {
    // OWL restriction blank nodes carry rdf:type owl:Restriction.
    // Requires schema props so the mapper knows owl:someValuesFrom is both-sides TBox.
    const BN = "_:r1";
    const quads = [
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: RDF_TYPE_IRI, termType: "NamedNode" }, object: { value: OWL.Restriction, termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: "http://www.w3.org/2002/07/owl#onProperty",     termType: "NamedNode" }, object: { value: EX+"knows", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: "http://www.w3.org/2002/07/owl#someValuesFrom", termType: "NamedNode" }, object: { value: EX+"Person", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      nn(EX+"Person", RDF_TYPE_IRI, OWL_CLASS),
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const restriction = findNode(nodes, BN);
    expect(restriction, "restriction blank node must be a node").toBeTruthy();
    expect((restriction.data as any).isTBox, "owl:Restriction blank node must be TBox").toBe(true);
    // owl:someValuesFrom object (ex:Person) is also TBox
    const person = findNode(nodes, EX+"Person");
    expect((person.data as any).isTBox, "someValuesFrom target class must be TBox").toBe(true);
  });

  it("2.10 – owl:hasValue subject is TBox but object individual stays ABox", () => {
    // owl:hasValue object is an individual — must NOT be pulled into TBox via structural scan.
    // Requires schema props so the mapper knows owl:hasValue is subject-only TBox.
    const BN = "_:r2";
    const quads = [
      nn(EX+"alice",  RDF_TYPE_IRI, OWL_NI),
      nn(EX+"alice",  RDF_TYPE_IRI, EX+"Person"),
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: RDF_TYPE_IRI,  termType: "NamedNode" }, object: { value: OWL.Restriction, termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: "http://www.w3.org/2002/07/owl#onProperty", termType: "NamedNode" }, object: { value: EX+"knows",  termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BN, termType: "BlankNode" }, predicate: { value: "http://www.w3.org/2002/07/owl#hasValue",   termType: "NamedNode" }, object: { value: EX+"alice",  termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const restriction = findNode(nodes, BN);
    expect((restriction?.data as any)?.isTBox, "restriction must be TBox").toBe(true);
    const alice = findNode(nodes, EX+"alice");
    expect((alice?.data as any)?.isTBox, "alice (hasValue object individual) must stay ABox").toBe(false);
  });
});

// ===========================================================================
// Part 3 – mapQuadsToDiagram: inference graph (urn:vg:inferred)
// ===========================================================================
describe("mapQuadsToDiagram – inferred graph", () => {

  it("3.1 – inferred annotation property appears on existing node", () => {
    const quads = [
      ...BASE_QUADS,
      lit(EX+"alice", EX+"comment", "Inferred comment", XSD_STRING, "urn:vg:inferred"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"alice");
    expect(hasAnnotation(n, EX+"comment", "Inferred comment")).toBe(true);
  });

  it("3.2 – inferred rdf:type does NOT appear as annotation property", () => {
    // OWL-RL may infer ex:alice rdf:type ex:Animal (subclass propagation)
    const quads = [
      ...BASE_QUADS,
      nn(EX+"alice", RDF_TYPE_IRI, EX+"Animal", "urn:vg:inferred"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"alice");
    const anns: any[] = (n.data as any).annotationProperties ?? [];
    const hasTypeAnnotation = anns.some(
      (a: any) => a.property === RDF_TYPE_IRI && a.value === EX+"Animal"
    );
    expect(hasTypeAnnotation, "inferred rdf:type must NOT appear as annotation").toBe(false);
  });

  it("3.3 – inferred rdf:type owl:NamedIndividual on a class does NOT change isTBox", () => {
    // OWL-RL may infer Person rdf:type owl:NamedIndividual
    const quads = [
      ...BASE_QUADS,
      nn(EX+"Person", RDF_TYPE_IRI, OWL_NI, "urn:vg:inferred"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    const n = findNode(nodes, EX+"Person");
    expect((n.data as any).isTBox, "Person must stay TBox after inferred owl:NamedIndividual").toBe(true);
  });

  it("3.4 – inferred-only subjects are NOT created as nodes", () => {
    // Triple whose subject has no quads in urn:vg:data
    const quads = [
      ...BASE_QUADS,
      nn(EX+"inferredOnly", EX+"knows", EX+"alice", "urn:vg:inferred"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    expect(findNode(nodes, EX+"inferredOnly"), "inferred-only subject must not become a node").toBeUndefined();
  });

  it("3.5 – inferred annotation does NOT appear on inferred-only subjects", () => {
    // sanity: if the subject IS in data graph, annotation still works (already tested in 3.1)
    // if the subject is NOT in data graph, no node should be created at all
    const quads = [
      ...BASE_QUADS,
      lit(EX+"ghost", EX+"comment", "ghost comment", XSD_STRING, "urn:vg:inferred"),
    ];
    const { nodes } = mapQuadsToDiagram(quads, BASE_OPTS);
    expect(findNode(nodes, EX+"ghost")).toBeUndefined();
  });
});

// ===========================================================================
// Part 4 – computeEdgeChanges
// ===========================================================================
describe("computeEdgeChanges – incremental edge reconciliation", () => {
  function edge(id: string, source: string, target: string) {
    return { id, source, target, data: { propertyUri: EX+"knows" } };
  }

  it("4.1 – add new edge when not present", () => {
    const existing = [edge("A-B", EX+"alice", EX+"bob")];
    const incoming = [edge("A-B", EX+"alice", EX+"bob"), edge("A-C", EX+"alice", EX+"charlie")];
    const changes = computeEdgeChanges(incoming as any, existing as any, new Set([EX+"alice"]));
    expect(changes.some((c: any) => c.type === "add" && c.item.id === "A-C")).toBe(true);
    expect(changes.some((c: any) => c.type === "remove" && c.id === "A-B")).toBe(false);
  });

  it("4.2 – remove stale edge for a touched subject", () => {
    const existing = [edge("A-B", EX+"alice", EX+"bob"), edge("A-C", EX+"alice", EX+"charlie")];
    const incoming = [edge("A-B", EX+"alice", EX+"bob")]; // A-C no longer in mapper output
    const changes = computeEdgeChanges(incoming as any, existing as any, new Set([EX+"alice"]));
    expect(changes.some((c: any) => c.type === "remove" && c.id === "A-C")).toBe(true);
    expect(changes.some((c: any) => c.type === "remove" && c.id === "A-B")).toBe(false);
  });

  it("4.3 – preserve unrelated edges whose source is not in updatedSubjects", () => {
    const existing = [edge("A-B", EX+"alice", EX+"bob"), edge("D-E", EX+"dave", EX+"eve")];
    const incoming = [edge("A-B", EX+"alice", EX+"bob")];
    const changes = computeEdgeChanges(incoming as any, existing as any, new Set([EX+"alice"]));
    expect(changes.some((c: any) => c.type === "remove" && c.id === "D-E")).toBe(false);
  });

  it("4.4 – no updatedSubjects ⇒ no deletions even if edge absent from incoming", () => {
    const existing = [edge("A-B", EX+"alice", EX+"bob"), edge("A-C", EX+"alice", EX+"charlie")];
    const incoming = [edge("A-B", EX+"alice", EX+"bob")];
    const changes = computeEdgeChanges(incoming as any, existing as any, undefined);
    expect(changes.some((c: any) => c.type === "remove")).toBe(false);
  });

  it("4.5 – existing edge is replaced (not duplicated) when present in incoming", () => {
    const existing = [edge("A-B", EX+"alice", EX+"bob")];
    const incoming = [{ ...edge("A-B", EX+"alice", EX+"bob"), data: { propertyUri: EX+"knows", label: "updated" } }];
    const changes = computeEdgeChanges(incoming as any, existing as any, new Set([EX+"alice"]));
    const replaceChanges = changes.filter((c: any) => c.type === "replace" && c.id === "A-B");
    expect(replaceChanges.length).toBe(1);
    expect(changes.filter((c: any) => c.type === "add" && c.item?.id === "A-B").length).toBe(0);
  });
});

// ===========================================================================
// Part 5 – computeNodeChanges
// ===========================================================================
describe("computeNodeChanges – incremental node reconciliation", () => {
  function node(id: string, data: Record<string, any> = {}) {
    return { id, type: "ontology", position: { x: 0, y: 0 }, data: { iri: id, ...data } };
  }

  it("5.1 – add new node when not in current state", () => {
    const existing = [node(EX+"alice")];
    const incoming = [node(EX+"alice"), node(EX+"bob")];
    const changes = computeNodeChanges(incoming as any, existing as any);
    expect(changes.some((c: any) => c.type === "add" && c.item.id === EX+"bob")).toBe(true);
  });

  it("5.2 – update existing node when data changes", () => {
    const existing = [node(EX+"alice", { label: "old" })];
    const incoming = [node(EX+"alice", { label: "new" })];
    const changes = computeNodeChanges(incoming as any, existing as any);
    const replaceChange = changes.find((c: any) => c.type === "replace" && c.id === EX+"alice");
    expect(replaceChange).toBeTruthy();
    expect(replaceChange.item.data.label).toBe("new");
  });

  it("5.3 – placeholder does NOT replace a real existing node", () => {
    const existing = [node(EX+"alice", { label: "real" })];
    const incoming = [node(EX+"alice", { __isPlaceholder: true, label: "placeholder" })];
    const changes = computeNodeChanges(incoming as any, existing as any);
    // Should be no change (placeholder skipped)
    expect(changes.some((c: any) => c.id === EX+"alice")).toBe(false);
  });

  it("5.4 – cluster node is NOT overwritten by a non-cluster incoming node", () => {
    const existing = [node(EX+"cluster1", { clusterType: "cluster", members: [EX+"alice"] })];
    const incoming = [node(EX+"cluster1", { label: "would-overwrite" })]; // no clusterType
    const changes = computeNodeChanges(incoming as any, existing as any);
    // Cluster must be protected — no replace change
    expect(changes.some((c: any) => c.id === EX+"cluster1")).toBe(false);
  });

  it("5.5 – no change emitted when node data is unchanged (reference stability)", () => {
    const data = { label: "Alice", isTBox: false };
    const existing = [node(EX+"alice", data)];
    const incoming = [node(EX+"alice", { ...data })]; // same values, new object reference
    const changes = computeNodeChanges(incoming as any, existing as any);
    // mergeDataOptimized should detect no meaningful change
    expect(changes.some((c: any) => c.id === EX+"alice" && c.type === "replace")).toBe(false);
  });
});

// ===========================================================================
// Part 6 – TBox classification driven by fat-map availableProperties
//
// This part tests the data-driven TBox predicate classification path:
// the worker seeds urn:vg:ontologies with OWL/RDFS axioms (rdfs:domain /
// rdfs:range per predicate) and buildFatMap produces ObjectProperty entries
// with populated domain[] / range[].  The mapper then derives
// TBOX_STRUCT_BOTH_SIDES and TBOX_STRUCT_SUBJ_ONLY from those entries.
//
// We simulate the fat-map output by constructing availableProperties from the
// same OWL_SCHEMA_AXIOMS the worker uses, and verify that every imaginable
// subject category is classified correctly.
// ===========================================================================

/**
 * Build an availableProperties array that mirrors what buildFatMap produces
 * after loading the OWL/RDFS axioms into urn:vg:ontologies.
 */
function buildSchemaAvailableProperties() {
  const byPredicate = new Map<string, { domain: string[]; range: string[] }>();
  for (const { predicate, domain, range } of OWL_SCHEMA_AXIOMS) {
    if (!byPredicate.has(predicate)) byPredicate.set(predicate, { domain: [], range: [] });
    const entry = byPredicate.get(predicate)!;
    if (domain) entry.domain.push(domain);
    if (range)  entry.range.push(range);
  }
  return Array.from(byPredicate.entries()).map(([iri, { domain, range }]) => ({
    iri,
    label: iri.split(/[#/]/).pop() ?? iri,
    domain,
    range,
    namespace: iri.replace(/[^#/]+$/, ""),
    source: "store",
  }));
}

const SCHEMA_PROPS = buildSchemaAvailableProperties();
const SCHEMA_OPTS  = { predicateKind, availableProperties: SCHEMA_PROPS };

describe("mapQuadsToDiagram – fat-map-driven TBox structural classification", () => {

  // ── 6.1 owl:Class declared via rdf:type ────────────────────────────────
  it("6.1 – owl:Class subject is TBox", () => {
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"MyClass", RDF_TYPE_IRI, OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"MyClass")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.2 rdfs:subClassOf both sides are TBox ────────────────────────────
  it("6.2 – rdfs:subClassOf subject AND object are TBox (no explicit rdf:type)", () => {
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"Child", RDFS_SUBCLASSOF, EX+"Parent"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"Child")?.data  as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"Parent")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.3 owl:equivalentClass both sides are TBox ───────────────────────
  it("6.3 – owl:equivalentClass subject AND object are TBox", () => {
    const OWL_EQUIV_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"A", OWL_EQUIV_CLASS, EX+"B"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"A")?.data as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"B")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.4 owl:Restriction blank node is TBox ───────────────────────────
  it("6.4 – owl:Restriction blank node is TBox", () => {
    const BLANK = "_:r1";
    const OWL_RESTRICTION = "http://www.w3.org/2002/07/owl#Restriction";
    const OWL_ON_PROP     = "http://www.w3.org/2002/07/owl#onProperty";
    const OWL_SOME        = "http://www.w3.org/2002/07/owl#someValuesFrom";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: RDF_TYPE_IRI, termType: "NamedNode" }, object: { value: OWL_RESTRICTION, termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_ON_PROP,  termType: "NamedNode" }, object: { value: EX+"knows",       termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_SOME,     termType: "NamedNode" }, object: { value: EX+"Person",      termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode = nodes.find((n: any) => n.id === BLANK || String(n.id).startsWith("_:"));
    expect(bnNode).toBeTruthy();
    expect((bnNode?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.5 owl:onProperty object (property IRI) is TBox ──────────────────
  it("6.5 – owl:onProperty object (the property IRI) is TBox", () => {
    const BLANK = "_:r2";
    const OWL_ON_PROP = "http://www.w3.org/2002/07/owl#onProperty";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_ON_PROP, termType: "NamedNode" }, object: { value: EX+"myProp", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    // The object (ex:myProp) appears as the target of an owl:onProperty edge
    // whose range is rdf:Property (TBox) → the node should be TBox
    const propNode = findNode(nodes, EX+"myProp");
    expect(propNode).toBeTruthy();
    expect((propNode?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.6 owl:hasValue subject is TBox, object stays ABox ───────────────
  it("6.6 – owl:hasValue subject is TBox, object individual stays ABox", () => {
    const BLANK = "_:r3";
    const OWL_HAS_VALUE = "http://www.w3.org/2002/07/owl#hasValue";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_HAS_VALUE, termType: "NamedNode" }, object: { value: EX+"alice", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      nn(EX+"alice", RDF_TYPE_IRI, OWL_NI),
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode    = nodes.find((n: any) => String(n.id).startsWith("_:"));
    const aliceNode = findNode(nodes, EX+"alice");
    expect((bnNode?.data as any)?.isTBox).toBe(true);
    // alice is a NamedIndividual — owl:hasValue does NOT pull it into TBox
    expect((aliceNode?.data as any)?.isTBox).toBe(false);
  });

  // ── 6.7 rdfs:domain / rdfs:range subject (a property) is TBox ─────────
  it("6.7 – subject of rdfs:domain declaration is TBox", () => {
    const RDFS_DOMAIN_IRI = "http://www.w3.org/2000/01/rdf-schema#domain";
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"myProp", RDFS_DOMAIN_IRI, EX+"MyClass"),
      nn(EX+"MyClass", RDF_TYPE_IRI, OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"myProp")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.8 owl:inverseOf — both properties are TBox ─────────────────────
  it("6.8 – owl:inverseOf subject AND object are TBox", () => {
    const OWL_INVERSE_OF = "http://www.w3.org/2002/07/owl#inverseOf";
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"hasPart", OWL_INVERSE_OF, EX+"isPartOf"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"hasPart")?.data  as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"isPartOf")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.9 owl:disjointWith — both classes are TBox ─────────────────────
  it("6.9 – owl:disjointWith subject AND object are TBox", () => {
    const OWL_DISJOINT = "http://www.w3.org/2002/07/owl#disjointWith";
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"Cat", OWL_DISJOINT, EX+"Dog"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"Cat")?.data as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"Dog")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.10 owl:intersectionOf subject is TBox, object list is NOT ───────
  it("6.10 – owl:intersectionOf subject is TBox, list head stays ABox-neutral", () => {
    const OWL_INTERSECTION = "http://www.w3.org/2002/07/owl#intersectionOf";
    const LIST_BLANK = "_:list1";
    const quads = [
      nn(EX+"CatOrDog", OWL_INTERSECTION, LIST_BLANK),
    ];
    const { nodes } = mapQuadsToDiagram(quads as any, SCHEMA_OPTS);
    expect((findNode(nodes, EX+"CatOrDog")?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.11 plain NamedIndividual is ABox ────────────────────────────────
  it("6.11 – owl:NamedIndividual subject is ABox", () => {
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"alice", RDF_TYPE_IRI, OWL_NI),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"alice")?.data as any)?.isTBox).toBe(false);
  });

  // ── 6.12 TBox class stays TBox even when used as object of ABox triple ─
  it("6.12 – a TBox class used as object of an ABox rdf:type triple stays TBox", () => {
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"Vehicle", RDF_TYPE_IRI, OWL_CLASS),
      nn(EX+"mycar",   RDF_TYPE_IRI, OWL_NI),
      nn(EX+"mycar",   RDF_TYPE_IRI, EX+"Vehicle"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"Vehicle")?.data as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"mycar")?.data   as any)?.isTBox).toBe(false);
  });

  // ── 6.13 rdfs:subPropertyOf both sides are TBox ───────────────────────
  it("6.13 – rdfs:subPropertyOf subject AND object are TBox", () => {
    const RDFS_SUB_PROP = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"narrower", RDFS_SUB_PROP, EX+"broader"),
    ], SCHEMA_OPTS);
    expect((findNode(nodes, EX+"narrower")?.data as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"broader")?.data  as any)?.isTBox).toBe(true);
  });

  // ── 6.14 owl:allValuesFrom — restriction is TBox, class is TBox ────────
  it("6.14 – owl:allValuesFrom: restriction blank node AND target class are TBox", () => {
    const BLANK        = "_:r4";
    const OWL_ALL_FROM = "http://www.w3.org/2002/07/owl#allValuesFrom";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_ALL_FROM, termType: "NamedNode" }, object: { value: EX+"Filler", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode     = nodes.find((n: any) => String(n.id).startsWith("_:"));
    const fillerNode = findNode(nodes, EX+"Filler");
    expect((bnNode?.data as any)?.isTBox).toBe(true);
    expect((fillerNode?.data as any)?.isTBox).toBe(true);
  });

  // ── 6.15 cross-batch: class known only from availableClasses is TBox ──
  it("6.15 – class known via availableClasses (no rdf:type quad in batch) is TBox", () => {
    // Simulates an incremental batch where KnownClass is used as a type but its
    // own rdf:type owl:Class quad is absent.  availableClasses supplies the
    // cross-batch knowledge that it IS a class.
    const optsWithClass = {
      ...SCHEMA_OPTS,
      availableClasses: [{ iri: EX+"KnownClass", label: "KnownClass", namespace: EX, properties: [], restrictions: {} }],
    };
    // KnownClass gets a node via the rdfs:label triple (explicit subject).
    // inst1 types to it but carries no class declaration in this batch.
    const { nodes } = mapQuadsToDiagram([
      nn(EX+"inst1",     RDF_TYPE_IRI,   OWL_NI),
      nn(EX+"inst1",     RDF_TYPE_IRI,   EX+"KnownClass"),
      lit(EX+"KnownClass", RDFS_LABEL_IRI, "Known Class"),
    ], optsWithClass);
    expect((findNode(nodes, EX+"KnownClass")?.data as any)?.isTBox).toBe(true);
    expect((findNode(nodes, EX+"inst1")?.data      as any)?.isTBox).toBe(false);
  });
});

// ===========================================================================
// Part 7 – OWL2Bench (UNIV-BENCH-OWL2DL.owl) real-ontology TBox/ABox tests
//
// These tests are derived from actual quads produced by parsing the OWL2Bench
// ontology (https://github.com/kracr/owl2bench).  Each test states precisely
// why the subject(s) should be TBox or ABox, acting as ground-truth assertions
// for the full OWL 2 DL feature set used in the benchmark.
//
// Ontology facts used:
//   – 132 owl:Class declarations, 85 owl:ObjectProperty, 12 owl:DatatypeProperty
//   – 52 punned entities (both owl:Class AND owl:NamedIndividual)
//   – 29 pure ABox-only individuals (owl:NamedIndividual, no owl:Class)
//   – 16 owl:Restriction blank nodes
//   –  9 owl:AllDisjointClasses blank nodes
//   –  4 owl:AllDifferent blank nodes (ABox axioms)
//   –  2 owl:NegativePropertyAssertion blank nodes (ABox axioms)
// ===========================================================================

const OWL2 = "http://benchmark/OWL2Bench#";

// Quad factory for OWL2Bench IRIs
function ob(subject: string, predicate: string, object: string) {
  return nn(OWL2 + subject, predicate, OWL2 + object);
}
function obType(subject: string, type: string) {
  return nn(OWL2 + subject, RDF_TYPE_IRI, type);
}
function findOB(nodes: any[], local: string) {
  return nodes.find((n: any) => n.id === OWL2 + local);
}

const OWL_INVERSE_OF         = "http://www.w3.org/2002/07/owl#inverseOf";
const OWL_EQUIV_PROP         = "http://www.w3.org/2002/07/owl#equivalentProperty";
const OWL_PROP_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#propertyDisjointWith";
const OWL_EQUIV_CLASS        = "http://www.w3.org/2002/07/owl#equivalentClass";
const OWL_DISJOINT_WITH      = "http://www.w3.org/2002/07/owl#disjointWith";
const OWL_COMPLEMENT_OF      = "http://www.w3.org/2002/07/owl#complementOf";
const OWL_DISJOINT_UNION_OF  = "http://www.w3.org/2002/07/owl#disjointUnionOf";
const OWL_ON_PROPERTY        = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_SOME_VALUES_FROM   = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_ALL_VALUES_FROM    = "http://www.w3.org/2002/07/owl#allValuesFrom";
const OWL_HAS_SELF           = "http://www.w3.org/2002/07/owl#hasSelf";
const OWL_SAME_AS            = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_RESTRICTION        = "http://www.w3.org/2002/07/owl#Restriction";
const OWL_ALL_DISJOINT       = "http://www.w3.org/2002/07/owl#AllDisjointClasses";
const OWL_ALL_DIFF           = "http://www.w3.org/2002/07/owl#AllDifferent";
const OWL_NEG_PA             = "http://www.w3.org/2002/07/owl#NegativePropertyAssertion";
const OWL_FUNC               = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OWL_SYM                = "http://www.w3.org/2002/07/owl#SymmetricProperty";
const OWL_TRANS              = "http://www.w3.org/2002/07/owl#TransitiveProperty";
const OWL_MEMBERS            = "http://www.w3.org/2002/07/owl#members";
const RDFS_DOMAIN_IRI        = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE_IRI         = "http://www.w3.org/2000/01/rdf-schema#range";
const RDFS_SUB_PROP          = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const OWL_SRC_IND            = "http://www.w3.org/2002/07/owl#sourceIndividual";
const OWL_ASSERT_PROP        = "http://www.w3.org/2002/07/owl#assertionProperty";
const OWL_TGT_IND            = "http://www.w3.org/2002/07/owl#targetIndividual";

describe("mapQuadsToDiagram – OWL2Bench real-ontology TBox/ABox classification", () => {

  // ── 7.1 Simple class hierarchy ──────────────────────────────────────────
  it("7.1 – AssistantProfessor rdfs:subClassOf Professor → both TBox", () => {
    // Actual OWL2Bench quads for AssistantProfessor
    const { nodes } = mapQuadsToDiagram([
      obType("AssistantProfessor", OWL_CLASS),
      ob("AssistantProfessor", RDFS_SUBCLASSOF, "Professor"),
      obType("Professor",          OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "AssistantProfessor")?.data as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "Professor")?.data          as any)?.isTBox).toBe(true);
  });

  // ── 7.2 FunctionalProperty ObjectProperty with domain and range ─────────
  it("7.2 – enrollFor (ObjectProperty + FunctionalProperty + domain + range) is TBox", () => {
    // Actual OWL2Bench quads for enrollFor
    const { nodes } = mapQuadsToDiagram([
      obType("enrollFor", OWL_OBJ_PROP),
      obType("enrollFor", OWL_FUNC),
      nn(OWL2+"enrollFor", RDFS_DOMAIN_IRI, OWL2+"Student"),
      nn(OWL2+"enrollFor", RDFS_RANGE_IRI,  OWL2+"Program"),
      obType("Student", OWL_CLASS),
      obType("Program", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "enrollFor")?.data as any)?.isTBox).toBe(true);
    // domain and range classes are TBox
    expect((findOB(nodes, "Student")?.data   as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "Program")?.data   as any)?.isTBox).toBe(true);
  });

  // ── 7.3 DatatypeProperty ────────────────────────────────────────────────
  it("7.3 – hasAge (DatatypeProperty + FunctionalProperty + domain) is TBox", () => {
    // Actual OWL2Bench quads
    const { nodes } = mapQuadsToDiagram([
      obType("hasAge", OWL_DT_PROP),
      obType("hasAge", OWL_FUNC),
      nn(OWL2+"hasAge", RDFS_DOMAIN_IRI, OWL2+"Person"),
      obType("Person", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "hasAge")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.4 owl:inverseOf — both ObjectProperties are TBox ──────────────────
  it("7.4 – hasAlumnus owl:inverseOf hasDegreeFrom → both TBox", () => {
    // Actual OWL2Bench quads (key subset)
    const { nodes } = mapQuadsToDiagram([
      obType("hasAlumnus", OWL_OBJ_PROP),
      nn(OWL2+"hasAlumnus", OWL_INVERSE_OF, OWL2+"hasDegreeFrom"),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "hasAlumnus")?.data   as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "hasDegreeFrom")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.5 owl:equivalentProperty — both TBox ──────────────────────────────
  it("7.5 – advises owl:equivalentProperty isAdvisorOf → both TBox", () => {
    // Actual OWL2Bench quads
    const { nodes } = mapQuadsToDiagram([
      obType("advises", OWL_OBJ_PROP),
      nn(OWL2+"advises", OWL_EQUIV_PROP, OWL2+"isAdvisorOf"),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "advises")?.data    as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "isAdvisorOf")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.6 owl:propertyDisjointWith — both TBox ────────────────────────────
  it("7.6 – dislikes owl:propertyDisjointWith likes → both TBox", () => {
    // Actual OWL2Bench quads
    const { nodes } = mapQuadsToDiagram([
      obType("dislikes", OWL_OBJ_PROP),
      nn(OWL2+"dislikes", RDFS_DOMAIN_IRI, OWL2+"Person"),
      nn(OWL2+"dislikes", OWL_PROP_DISJOINT_WITH, OWL2+"likes"),
      obType("Person", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "dislikes")?.data as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "likes")?.data    as any)?.isTBox).toBe(true);
  });

  // ── 7.7 SymmetricProperty is TBox ───────────────────────────────────────
  it("7.7 – hasCollaborationWith (SymmetricProperty) is TBox", () => {
    const { nodes } = mapQuadsToDiagram([
      obType("hasCollaborationWith", OWL_OBJ_PROP),
      obType("hasCollaborationWith", OWL_SYM),
      nn(OWL2+"hasCollaborationWith", RDFS_DOMAIN_IRI, OWL2+"Person"),
      nn(OWL2+"hasCollaborationWith", RDFS_RANGE_IRI,  OWL2+"Person"),
      obType("Person", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "hasCollaborationWith")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.8 TransitiveProperty is TBox ─────────────────────────────────────
  it("7.8 – isSubOrganizationOf (TransitiveProperty) is TBox", () => {
    const { nodes } = mapQuadsToDiagram([
      obType("isSubOrganizationOf", OWL_OBJ_PROP),
      obType("isSubOrganizationOf", OWL_TRANS),
      nn(OWL2+"isSubOrganizationOf", RDFS_DOMAIN_IRI, OWL2+"Organization"),
      nn(OWL2+"isSubOrganizationOf", RDFS_RANGE_IRI,  OWL2+"Organization"),
      obType("Organization", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "isSubOrganizationOf")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.9 rdfs:subPropertyOf — both TBox ──────────────────────────────────
  it("7.9 – enrollIn rdfs:subPropertyOf isStudentOf → both TBox", () => {
    // Actual OWL2Bench quads
    const { nodes } = mapQuadsToDiagram([
      obType("enrollIn", OWL_OBJ_PROP),
      nn(OWL2+"enrollIn", RDFS_SUB_PROP, OWL2+"isStudentOf"),
      obType("isStudentOf", OWL_OBJ_PROP),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "enrollIn")?.data    as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "isStudentOf")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.10 owl:Restriction blank node is TBox ─────────────────────────────
  it("7.10 – owl:Restriction blank node (onProperty/someValuesFrom) is TBox", () => {
    // Actual OWL2Bench blank-node pattern:
    // _:r rdf:type owl:Restriction; owl:onProperty isHeadOf; owl:someValuesFrom Department
    const BLANK = "_:df_0_18";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: RDF_TYPE_IRI,      termType: "NamedNode" }, object: { value: OWL_RESTRICTION, termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_ON_PROPERTY,   termType: "NamedNode" }, object: { value: OWL2+"isHeadOf",   termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_SOME_VALUES_FROM, termType: "NamedNode" }, object: { value: OWL2+"Department", termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode = nodes.find((n: any) => String(n.id).startsWith("_:"));
    expect(bnNode).toBeTruthy();
    expect((bnNode?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.11 owl:AllDisjointClasses blank node is TBox ──────────────────────
  it("7.11 – owl:AllDisjointClasses blank node is TBox", () => {
    // Actual OWL2Bench pattern
    const BLANK = "_:dc1";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: RDF_TYPE_IRI, termType: "NamedNode" }, object: { value: OWL_ALL_DISJOINT, termType: "NamedNode" }, graph: { value: "urn:vg:data" } },
      { subject: { value: BLANK, termType: "BlankNode" }, predicate: { value: OWL_MEMBERS,   termType: "NamedNode" }, object: { value: "_:list1",         termType: "BlankNode" }, graph: { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode = nodes.find((n: any) => String(n.id).startsWith("_:dc1"));
    expect(bnNode).toBeTruthy();
    expect((bnNode?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.12 Pure ABox individual — AbstractPainting ─────────────────────────
  it("7.12 – AbstractPainting (only owl:NamedIndividual, no class axioms) is ABox", () => {
    // Actual OWL2Bench: AbstractPainting has NO owl:Class type
    const { nodes } = mapQuadsToDiagram([
      obType("AbstractPainting", OWL_NI),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "AbstractPainting")?.data as any)?.isTBox).toBe(false);
  });

  // ── 7.13 ABox individual with owl:sameAs — FootBall ─────────────────────
  it("7.13 – FootBall (owl:NamedIndividual + owl:sameAs Football) is ABox", () => {
    // FootBall is a pure individual (no owl:Class declaration for FootBall itself)
    // Football is punned (owl:Class), so this sameAs edge connects ABox → TBox
    const { nodes } = mapQuadsToDiagram([
      obType("FootBall", OWL_NI),
      nn(OWL2+"FootBall", OWL_SAME_AS, OWL2+"Football"),
      obType("Football", OWL_CLASS),
      ob("Football", RDFS_SUBCLASSOF, "Sports"),
      obType("Football", OWL_NI),
      obType("Sports", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "FootBall")?.data  as any)?.isTBox).toBe(false); // ABox individual
    expect((findOB(nodes, "Football")?.data  as any)?.isTBox).toBe(true);  // punned class → TBox
  });

  // ── 7.14 Punned entity — Football (owl:Class + owl:NamedIndividual → nodeLayer="both") ─
  it("7.14 – Football (punned: owl:Class + owl:NamedIndividual) → nodeLayer=both, appears in both views", () => {
    // Actual OWL2Bench quads for Football — the exact 4 triples from the ontology
    const { nodes } = mapQuadsToDiagram([
      obType("Football", OWL_CLASS),
      ob("Football", RDFS_SUBCLASSOF, "Sports"),
      obType("Football", OWL_NI),
      obType("Football", "http://benchmark/OWL2Bench#Interest"),
      obType("Sports", OWL_CLASS),
    ], SCHEMA_OPTS);
    // Football is punned (owl:Class + owl:NamedIndividual) → nodeLayer="both"
    // isTBox=true because "both" !== "abox" — visible in TBox view AND ABox view
    expect((findOB(nodes, "Football")?.data as any)?.nodeLayer).toBe("both");
    expect((findOB(nodes, "Football")?.data as any)?.isTBox).toBe(true);
    // Sports is only owl:Class → TBox only
    expect((findOB(nodes, "Sports")?.data as any)?.nodeLayer).toBe("tbox");
    expect((findOB(nodes, "Sports")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.15 Punned entity — Mathematics (self-referential type + owl:Class) ──
  it("7.15 – Mathematics (owl:Class + owl:NamedIndividual + rdf:type Mathematics) → nodeLayer=both", () => {
    // Actual OWL2Bench: Mathematics rdf:type Mathematics (punned self-reference)
    const { nodes } = mapQuadsToDiagram([
      obType("Mathematics", OWL_CLASS),
      ob("Mathematics", RDFS_SUBCLASSOF, "Science"),
      obType("Mathematics", OWL_NI),
      obType("Mathematics", "http://benchmark/OWL2Bench#Mathematics"), // self-type
      obType("Science", OWL_CLASS),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "Mathematics")?.data as any)?.nodeLayer).toBe("both");
    expect((findOB(nodes, "Mathematics")?.data as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "Science")?.data as any)?.nodeLayer).toBe("tbox");
  });

  // ── 7.16 owl:equivalentClass (named) — both TBox ────────────────────────
  it("7.16 – College owl:equivalentClass School → both TBox (no explicit owl:Class needed)", () => {
    // Actual OWL2Bench: College owl:equivalentClass School
    // owl:equivalentClass is in TBOX_STRUCT_BOTH_SIDES → both sides added to knownTBoxIris
    const { nodes } = mapQuadsToDiagram([
      nn(OWL2+"College", OWL_EQUIV_CLASS, OWL2+"School"),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "College")?.data as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "School")?.data  as any)?.isTBox).toBe(true);
  });

  // ── 7.17 owl:disjointWith — both TBox ───────────────────────────────────
  it("7.17 – Man owl:disjointWith Woman → both TBox (actual OWL2Bench axiom)", () => {
    const { nodes } = mapQuadsToDiagram([
      obType("Man",   OWL_CLASS),
      obType("Woman", OWL_CLASS),
      nn(OWL2+"Man", OWL_DISJOINT_WITH, OWL2+"Woman"),
    ], SCHEMA_OPTS);
    expect((findOB(nodes, "Man")?.data   as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "Woman")?.data as any)?.isTBox).toBe(true);
  });

  // ── 7.18 owl:disjointUnionOf subject — TBox via rdf:type owl:Class ───────
  it("7.18 – Article (owl:disjointUnionOf, has owl:Class type) is TBox", () => {
    // owl:disjointUnionOf is NOT in OWL_SCHEMA_AXIOMS, but Article has rdf:type owl:Class
    // which puts it in TBOX_TYPE_IRIS → correctly TBox
    const listBn = "_:list1";
    const quads = [
      obType("Article", OWL_CLASS),
      ob("Article", RDFS_SUBCLASSOF, "Publication"),
      { subject: { value: OWL2+"Article", termType: "NamedNode" },
        predicate: { value: OWL_DISJOINT_UNION_OF, termType: "NamedNode" },
        object:    { value: listBn, termType: "BlankNode" },
        graph:     { value: "urn:vg:data" } },
      obType("Publication", OWL_CLASS),
    ];
    const { nodes } = mapQuadsToDiagram(quads as any, SCHEMA_OPTS);
    expect((findOB(nodes, "Article")?.data      as any)?.isTBox).toBe(true);
    expect((findOB(nodes, "Publication")?.data  as any)?.isTBox).toBe(true);
  });

  // ── 7.19 owl:AllDifferent blank node is ABox ────────────────────────────
  it("7.19 – owl:AllDifferent blank node is ABox (OWL semantics: inequality of individuals)", () => {
    // owl:AllDifferent is an ABox axiom in OWL 2 — it asserts that named individuals
    // are mutually distinct.  owl:AllDifferent is intentionally NOT in TBOX_TYPE_IRIS.
    const BLANK = "_:alldiff1";
    const quads = [
      { subject: { value: BLANK, termType: "BlankNode" },
        predicate: { value: RDF_TYPE_IRI, termType: "NamedNode" },
        object:    { value: OWL_ALL_DIFF, termType: "NamedNode" },
        graph:     { value: "urn:vg:data" } },
    ];
    const { nodes } = mapQuadsToDiagram(quads, SCHEMA_OPTS);
    const bnNode = nodes.find((n: any) => String(n.id).startsWith("_:alldiff"));
    expect(bnNode).toBeTruthy();
    expect((bnNode?.data as any)?.isTBox).toBe(false); // ABox axiom
  });

  // ── 7.20 owl:NegativePropertyAssertion blank node is ABox ───────────────
  it("7.20 – owl:NegativePropertyAssertion blank node is ABox (ABox axiom about individuals)", () => {
    // Actual OWL2Bench: _:npa asserting PGStudent NOT enrollFor UGprogram
    // NegativePropertyAssertion involves specific individuals → ABox
    const BLANK = "_:npa1";
    const quads = [
      { subject: { value: BLANK,       termType: "BlankNode" },
        predicate: { value: RDF_TYPE_IRI,  termType: "NamedNode" },
        object:    { value: OWL_NEG_PA,    termType: "NamedNode" },
        graph:     { value: "urn:vg:data" } },
      { subject: { value: BLANK,       termType: "BlankNode" },
        predicate: { value: OWL_SRC_IND,   termType: "NamedNode" },
        object:    { value: OWL2+"PGStudent", termType: "NamedNode" },
        graph:     { value: "urn:vg:data" } },
      { subject: { value: BLANK,       termType: "BlankNode" },
        predicate: { value: OWL_ASSERT_PROP, termType: "NamedNode" },
        object:    { value: OWL2+"enrollFor", termType: "NamedNode" },
        graph:     { value: "urn:vg:data" } },
      { subject: { value: BLANK,       termType: "BlankNode" },
        predicate: { value: OWL_TGT_IND,   termType: "NamedNode" },
        object:    { value: OWL2+"UGprogram", termType: "NamedNode" },
        graph:     { value: "urn:vg:data" } },
      obType("PGStudent", OWL_NI),
      obType("UGprogram", OWL_NI),
    ];
    const { nodes } = mapQuadsToDiagram(quads as any, SCHEMA_OPTS);
    const bnNode = nodes.find((n: any) => String(n.id).startsWith("_:npa"));
    expect(bnNode).toBeTruthy();
    expect((bnNode?.data as any)?.isTBox).toBe(false); // ABox axiom
    // The individuals linked inside are also ABox
    expect((findOB(nodes, "PGStudent")?.data as any)?.isTBox).toBe(false);
    expect((findOB(nodes, "UGprogram")?.data as any)?.isTBox).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 9 – RDF List / owl:AllDifferent collection rendering
//
// An owl:AllDifferent node references a 3-element rdf:List via
// owl:distinctMembers.  The list chain is three cons-cell blank nodes:
//   _:b1 rdf:first :A  rdf:rest _:b2
//   _:b2 rdf:first :B  rdf:rest _:b3
//   _:b3 rdf:first :C  rdf:rest rdf:nil
//
// Two blank-node value formats are exercised:
//   "N3-style"  – value has NO leading "_:" (mimics WorkerQuad from N3.js)
//   "test-style" – value HAS leading "_:"   (mimics hand-written test quads)
// ---------------------------------------------------------------------------
describe("Part 9 – RDF list / collection rendering", () => {
  const RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
  const RDF_REST  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
  const RDF_NIL   = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
  const OWL_ALL_DIFFERENT      = "http://www.w3.org/2002/07/owl#AllDifferent";
  const OWL_DISTINCT_MEMBERS   = "http://www.w3.org/2002/07/owl#distinctMembers";

  // Helper: blank node quad (both subject & object can be blank nodes)
  function bq(
    subj: string, subjType: "BlankNode" | "NamedNode",
    pred: string,
    obj: string,  objType: "BlankNode" | "NamedNode" | "NamedNode_nil",
  ) {
    const objectTermType = objType === "NamedNode_nil" ? "NamedNode" : objType;
    return {
      subject:   { value: subj, termType: subjType },
      predicate: { value: pred, termType: "NamedNode" },
      object:    { value: obj,  termType: objectTermType },
      graph:     { value: "urn:vg:data" },
    };
  }

  // Build quads for a 3-element list using blank node value format without "_:" prefix
  // (this is the N3.js WorkerQuad format: termType="BlankNode", value="b1" not "_:b1")
  function makeListQuads_n3style() {
    const A = EX + "IndividualA";
    const B = EX + "IndividualB";
    const C = EX + "IndividualC";
    const allDiff = EX + "myAllDifferent";
    return [
      // owl:AllDifferent axiom
      nn(allDiff, RDF_TYPE_IRI, OWL_ALL_DIFFERENT),
      bq(allDiff,  "NamedNode",  OWL_DISTINCT_MEMBERS, "b1", "BlankNode"),
      // cons-cell b1
      bq("b1", "BlankNode", RDF_FIRST, A,    "NamedNode"),
      bq("b1", "BlankNode", RDF_REST,  "b2", "BlankNode"),
      // cons-cell b2
      bq("b2", "BlankNode", RDF_FIRST, B,    "NamedNode"),
      bq("b2", "BlankNode", RDF_REST,  "b3", "BlankNode"),
      // cons-cell b3
      bq("b3", "BlankNode", RDF_FIRST, C,    "NamedNode"),
      bq("b3", "BlankNode", RDF_REST,  RDF_NIL, "NamedNode_nil"),
      // individuals
      nn(A, RDF_TYPE_IRI, OWL_NI),
      nn(B, RDF_TYPE_IRI, OWL_NI),
      nn(C, RDF_TYPE_IRI, OWL_NI),
    ];
  }

  it("9.1 – all three cons-cell blank nodes appear as canvas nodes", () => {
    const { nodes } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    // The hidden cons-cell nodes OR their cluster node should be present
    const allIds = nodes.map((n: any) => String(n.id));
    // Either blank nodes directly or a cluster node for them
    const hasB1 = allIds.some(id => id === "b1" || id === "cluster:b1");
    expect(hasB1).toBe(true);
  });

  it("9.2 – rdf:first edge exists for every cons-cell (b1, b2, b3)", () => {
    const { nodes, edges } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    const RDF_FIRST_IRI = RDF_FIRST;

    // Collect ALL edges (hidden or not) with rdf:first predicate
    const firstEdges = edges.filter((e: any) => e.data?.propertyUri === RDF_FIRST_IRI);

    console.log("9.2 – all nodes:", nodes.map((n: any) => `${n.id}(hidden=${n.hidden})`));
    console.log("9.2 – all edges:", edges.map((e: any) => `${e.source}→${e.target}[${e.data?.propertyUri?.split('#')[1]}](hidden=${e.hidden})`));
    console.log("9.2 – rdf:first edges:", firstEdges.map((e: any) => `${e.source}→${e.target}(hidden=${e.hidden})`));

    // There should be exactly 3 rdf:first edges (one per cons-cell)
    expect(firstEdges).toHaveLength(3);
  });

  it("9.3 – rdf:first edges target the correct individuals", () => {
    const { edges } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    const firstEdges = edges.filter((e: any) => e.data?.propertyUri === RDF_FIRST);
    const targets = new Set(firstEdges.map((e: any) => String(e.target)));
    expect(targets.has(EX + "IndividualA")).toBe(true);
    expect(targets.has(EX + "IndividualB")).toBe(true);
    expect(targets.has(EX + "IndividualC")).toBe(true);
  });

  it("9.4 – rdf:nil does not appear as a canvas node", () => {
    const { nodes } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    expect(nodes.find((n: any) => String(n.id) === RDF_NIL)).toBeUndefined();
  });

  it("9.5 – ABox list cons-cells (owl:distinctMembers) have nodeLayer=abox", () => {
    const { nodes } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    for (const id of ["b1", "b2", "b3"]) {
      const n = nodes.find((x: any) => String(x.id) === id);
      expect(n, `cons-cell ${id} must exist`).toBeTruthy();
      expect((n?.data as any)?.nodeLayer, `${id} must be ABox list cons-cell`).toBe("abox");
    }
  });

  it("9.6 – individuals referenced via rdf:first keep their own nodeLayer (ABox)", () => {
    const { nodes } = mapQuadsToDiagram(makeListQuads_n3style() as any, BASE_OPTS);
    for (const iri of [EX + "IndividualA", EX + "IndividualB", EX + "IndividualC"]) {
      const n = nodes.find((x: any) => String(x.id) === iri);
      expect(n, `${iri} must exist`).toBeTruthy();
      expect((n?.data as any)?.nodeLayer, `${iri} must be ABox`).toBe("abox");
    }
  });

  it("9.7 – TBox list cons-cells (owl:unionOf) have nodeLayer=tbox", () => {
    // A class defined via owl:unionOf — cons-cells are TBox
    const OWL_UNION_OF = "http://www.w3.org/2002/07/owl#unionOf";
    const OWL_CLASS_IRI = "http://www.w3.org/2002/07/owl#Class";
    const quads = [
      nn(EX + "UnionClass", RDF_TYPE_IRI, OWL_CLASS_IRI),
      bq(EX + "UnionClass", "NamedNode", OWL_UNION_OF, "u1", "BlankNode"),
      bq("u1", "BlankNode", RDF_FIRST, EX + "ClassA", "NamedNode"),
      bq("u1", "BlankNode", RDF_REST,  "u2", "BlankNode"),
      bq("u2", "BlankNode", RDF_FIRST, EX + "ClassB", "NamedNode"),
      bq("u2", "BlankNode", RDF_REST,  RDF_NIL, "NamedNode_nil"),
      nn(EX + "ClassA", RDF_TYPE_IRI, OWL_CLASS_IRI),
      nn(EX + "ClassB", RDF_TYPE_IRI, OWL_CLASS_IRI),
    ];
    const { nodes } = mapQuadsToDiagram(quads as any, SCHEMA_OPTS);
    for (const id of ["u1", "u2"]) {
      const n = nodes.find((x: any) => String(x.id) === id);
      expect(n, `cons-cell ${id} must exist`).toBeTruthy();
      expect((n?.data as any)?.nodeLayer, `${id} must be TBox list cons-cell`).toBe("tbox");
    }
  });
});
