import { describe, it, expect } from "vitest";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";
import { RDF_TYPE, RDFS, OWL, XSD } from "../../constants/vocabularies";

function q(subject: string, predicate: string, object: any, graph = "urn:vg:data") {
  return {
    subject: { value: subject },
    predicate: { value: predicate },
    object: object,
    graph: { value: graph },
  };
}

describe("mapQuadsToDiagram (mapper) - fat-map authoritative scenarios", () => {

  it("folds triples into subject when predicate not in fat-map (no edge)", () => {
    const subj = "http://example.com/s2";
    const pred = "http://example.com/propX";
    const obj = "http://example.com/oX";

    const quads = [q(subj, pred, { value: obj, termType: "NamedNode" })];

    const diagram = mapQuadsToDiagram(quads, { availableProperties: [] });

    expect(Array.isArray(diagram.edges)).toBeTruthy();
    expect(diagram.edges.length).toBe(0);

    expect(Array.isArray(diagram.nodes)).toBeTruthy();
    expect(diagram.nodes.length).toBeGreaterThanOrEqual(1);
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeDefined();
    // annotationProperties should contain the folded property -> object IRI
    expect(node.data.annotationProperties.some((ap: any) => ap.property === pred && ap.value === obj)).toBeTruthy();
  });

  it("folds literal objects into subject annotationProperties", () => {
    const subj = "http://example.com/s3";
    const pred = "http://example.com/labelProp";
    const lit = "Alice";

    const quads = [
      q(subj, pred, {
        value: lit,
        termType: "Literal",
        datatype: { value: XSD.string },
      }),
    ];

    const diagram = mapQuadsToDiagram(quads, { availableProperties: [] });
    expect(diagram.edges.length).toBe(0);
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeDefined();
    expect(node.data.annotationProperties.some((ap: any) => ap.property === pred && ap.value === lit)).toBeTruthy();
  });

  it("promotes a blank-node object to a node when the blank node also appears as a subject in the same batch and predicate is object", () => {
    const subj = "http://example.com/s4";
    const pred = "http://example.com/hasBlank";
    const bn = "_:b1";

    // Triple linking subject -> blank node
    const t1 = q(subj, pred, { value: bn, termType: "BlankNode" });
    // Another triple where the blank node appears as a subject (makes it referenced)
    const t2 = q(bn, RDFS.label, { value: "blank label", termType: "Literal" });

    const diagram = mapQuadsToDiagram([t1, t2], { availableProperties: [{ iri: pred, propertyKind: "object" }] });

    // Edge should be created
    expect(diagram.edges.length).toBe(1);
    // Both subject and blank node should be present as nodes (blank was referenced as subject)
    const ids = diagram.nodes.map((n: any) => String(n.id));
    expect(ids).toContain(subj);
    expect(ids).toContain(bn);
  });

  it("when predicate absent in fat-map and object is IRI, triple is folded (no edge)", () => {
    const subj = "http://example.com/s5";
    const pred = "http://example.com/nonFatProp";
    const obj = "http://example.com/o5";

    const diagram = mapQuadsToDiagram([q(subj, pred, { value: obj, termType: "NamedNode" })], { availableProperties: [] });
    expect(diagram.edges.length).toBe(0);
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeDefined();
    expect(node.data.annotationProperties.some((ap: any) => ap.property === pred && ap.value === obj)).toBeTruthy();
  });

  it("folds license IRI into ontology subject annotationProperties (no edge)", () => {
    const subj = "http://example.org/ont1";
    const pred = "http://purl.org/dc/terms/license";
    const lic = "https://creativecommons.org/licenses/by/4.0/";

    const quads = [
      q(subj, RDF_TYPE, { value: OWL.Ontology, termType: "NamedNode" }),
      q(subj, pred, { value: lic, termType: "NamedNode" }),
    ];

    const diagram = mapQuadsToDiagram(quads, { availableProperties: [] });
    expect(diagram.edges.length).toBe(0);
    // Ensure exactly one node (the ontology subject) was created and no standalone node for the license IRI
    expect(Array.isArray(diagram.nodes)).toBeTruthy();
    expect(diagram.nodes.length).toBe(1);
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeDefined();
    expect(node.data.annotationProperties.some((ap: any) => ap.property === pred && ap.value === lic)).toBeTruthy();
  });

  it("creates object node+edge for predicates present in fat-map but lacking kind (unknown) and propagates subject view", () => {
    const subj = "http://example.com/s-unknown";
    const pred = "http://example.com/propUnknown";
    const obj = "http://example.com/o-unknown";
    const classIri = OWL.Class; // explicit TBox marker (owl:Class)

    const tType = q(subj, RDF_TYPE, { value: classIri, termType: "NamedNode" });
    const tLink = q(subj, pred, { value: obj, termType: "NamedNode" });

    // availableProperties contains the predicate but without propertyKind -> treated as 'unknown'
    const diagram = mapQuadsToDiagram([tType, tLink], { availableProperties: [{ iri: pred }] });

    // Expect an edge and both subject and object nodes to exist
    expect(Array.isArray(diagram.edges)).toBeTruthy();
    expect(diagram.edges.length).toBe(1);
    const ids = (diagram.nodes || []).map((n: any) => String(n.id));
    expect(ids).toContain(subj);
    expect(ids).toContain(obj);

    const subjNode = (diagram.nodes || []).find((n: any) => String(n.id) === subj);
    const objNode = (diagram.nodes || []).find((n: any) => String(n.id) === obj);
    expect(subjNode).toBeDefined();
    expect(objNode).toBeDefined();
    // Subject declared as a class -> should be TBox; object should inherit same view
    expect(subjNode.data.isTBox).toBeTruthy();
    expect(objNode.data.isTBox).toBe(subjNode.data.isTBox);
  });

  it("creates blank-node object node+edge for unknown predicate even when blank node not referenced as subject", () => {
    const subj = "http://example.com/s-bn-unknown";
    const pred = "http://example.com/hasBlankUnknown";
    const bn = "_:bn_unknown";

    const tLink = q(subj, pred, { value: bn, termType: "BlankNode" });
    // availableProperties contains the predicate but without propertyKind -> treated as 'unknown'
    const diagram = mapQuadsToDiagram([tLink], { availableProperties: [{ iri: pred }] });

    expect(Array.isArray(diagram.edges)).toBeTruthy();
    expect(diagram.edges.length).toBe(1);

    const ids = (diagram.nodes || []).map((n: any) => String(n.id));
    expect(ids).toContain(subj);
    expect(ids).toContain(bn);
  });

});
