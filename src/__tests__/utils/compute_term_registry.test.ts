import { computeTermDisplay } from "../../utils/termUtils";
import { describe, test, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";

describe("computeTermDisplay registry enforcement", () => {
  test("behaves sensibly when registry lacks matching prefix for an IRI (store-only behavior)", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
    ];

    // Seed the ontology store with the registry (computeTermDisplay is store-only)
    useOntologyStore.getState().setNamespaceRegistry(registry);

    // Known IRI that is NOT in the registry (core OWL IRI)
    const owlOntologyIri = "http://www.w3.org/2002/07/owl#Ontology";

    // Store lacks owl prefix — computeTermDisplay should return a computed label/prefixed form (no throw)
    const td = computeTermDisplay(owlOntologyIri);
    expect(td).toBeTruthy();
    // prefixed falls back to the local name when no registry entry is found
    expect(td.prefixed).toBe("Ontology");
    // namespace is empty when no prefix matched
    expect(td.namespace).toBe("");
  });

  test("succeeds when registry contains matching namespace", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
      { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "#E2CFEA" },
    ];

    // Seed the store's registry so computeTermDisplay will find the owl prefix
    useOntologyStore.getState().setNamespaceRegistry(registry);

    // Also seed the fat-map so computeTermDisplay (fat-map-first) can resolve labels/prefixes
    const iri = "http://www.w3.org/2002/07/owl#Ontology";
    useOntologyStore.setState({
      availableClasses: [
        { iri, label: "Ontology", namespace: "http://www.w3.org/2002/07/owl#", properties: [], restrictions: {} },
      ],
    });

    const td = computeTermDisplay(iri);
    expect(td.prefixed).toBe("owl:Ontology");
    expect(td.namespace).toBe("owl");
    expect(td.iri).toBe(iri);
  });
});
