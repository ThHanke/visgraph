import { computeTermDisplay } from "../../utils/termUtils";
import { describe, test, expect } from "vitest";

describe("computeTermDisplay registry enforcement", () => {
  test("throws when registry lacks matching prefix for an IRI", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
    ];

    // Known IRI that is NOT in the registry (core OWL IRI)
    const owlOntologyIri = "http://www.w3.org/2002/07/owl#Ontology";

    expect(() => computeTermDisplay(owlOntologyIri, registry)).toThrowError(/No registry prefix found/);
  });

  test("succeeds when registry contains matching namespace", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
      { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "#E2CFEA" },
    ];

    const iri = "http://www.w3.org/2002/07/owl#Ontology";
    const td = computeTermDisplay(iri, registry);
    expect(td.prefixed).toBe("owl:Ontology");
    expect(td.namespace).toBe("owl");
    expect(td.iri).toBe(iri);
  });
});
