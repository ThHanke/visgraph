import { describe, it, expect } from "vitest";
import mapQuadsToDiagram from "../../components/Canvas/core/mappingHelpers";

function q(subject: string, predicate: string, object: any, graph = "urn:vg:data") {
  return {
    subject: { value: subject },
    predicate: { value: predicate },
    object: object,
    graph: { value: graph },
  };
}

describe("mapQuadsToDiagram (mapper) - fat-map authoritative scenarios", () => {
  it("creates an edge when predicate is present in fat-map (object property) and does NOT create an object node", () => {
    const subj = "http://example.com/s1";
    const pred = "http://example.com/prop";
    const obj = "http://example.com/o1";

    const quads = [q(subj, pred, { value: obj, termType: "NamedNode" })];

    const diagram = mapQuadsToDiagram(quads, { availableProperties: [{ iri: pred }] });

    expect(Array.isArray(diagram.edges)).toBeTruthy();
    expect(diagram.edges.length).toBe(1);

    // Nodes: mapper should only create the subject node (object IRI not turned into node)
    expect(Array.isArray(diagram.nodes)).toBeTruthy();
    const nodeIds = diagram.nodes.map((n: any) => String(n.id));
    expect(nodeIds).toContain(subj);
    expect(nodeIds).not.toContain(obj);
  });

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
        datatype: { value: "http://www.w3.org/2001/XMLSchema#string" },
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
    const t2 = q(bn, "http://www.w3.org/2000/01/rdf-schema#label", { value: "blank label", termType: "Literal" });

    const diagram = mapQuadsToDiagram([t1, t2], { availableProperties: [{ iri: pred }] });

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
});
