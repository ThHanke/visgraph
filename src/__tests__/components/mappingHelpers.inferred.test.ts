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

describe("mapQuadsToDiagram (inferred-graph folding)", () => {
  it("does NOT create nodes for inferred-only subjects (no node/edge creation)", () => {
    const subj = "http://example.com/inferredOnly";
    const pred = "http://example.com/inferredProp";
    const obj = "http://example.com/inferredObj";

    // Triple lives only in the inferred graph
    const quads = [q(subj, pred, { value: obj, termType: "NamedNode" }, "urn:vg:inferred")];

    const diagram = mapQuadsToDiagram(quads, { availableProperties: [] });

    // No edges should be created
    expect(Array.isArray(diagram.edges)).toBeTruthy();
    expect(diagram.edges.length).toBe(0);

    // No node should be created for inferred-only subject
    expect(Array.isArray(diagram.nodes)).toBeTruthy();
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeUndefined();
  });

  it("folds inferred triples into existing data subject as annotationProperties", () => {
    const subj = "http://example.com/dataAndInferred";
    const dataPred = "http://example.com/dataPred";
    const inferredPred = "http://example.com/inferredProp";
    const inferredObj = "http://example.com/inferredObj";

    // Data triple ensures subject exists in data graph
    const tData = q(subj, dataPred, { value: "someValue", termType: "Literal" }, "urn:vg:data");
    // Inferred triple about the same subject (should be folded into subject's annotations)
    const tInferred = q(subj, inferredPred, { value: inferredObj, termType: "NamedNode" }, "urn:vg:inferred");

    const diagram = mapQuadsToDiagram([tData, tInferred], { availableProperties: [] });

    // Ensure subject node exists
    const node = diagram.nodes.find((n: any) => n.id === subj);
    expect(node).toBeDefined();

    // The inferred triple should be folded as an annotation property on the subject node
    expect(node.data.annotationProperties.some((ap: any) => ap.property === inferredPred && ap.value === inferredObj)).toBeTruthy();

    // No separate node should be created for the inferred-only object just because of inferred triple
    const objNode = diagram.nodes.find((n: any) => n.id === inferredObj);
    expect(objNode).toBeUndefined();
  });
});
