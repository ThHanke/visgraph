import { describe, it, expect, beforeEach } from "vitest";
import { rdfManager } from "@/utils/rdfManager";

describe("RDFManager.applyParsedNodes - absolute IRI behavior", () => {
  beforeEach(() => {
    // ensure a clean store / namespaces before each test
    try {
      rdfManager.clear();
    } catch (_) {
      /* ignore */
    }
  });

  it("does not synthesize prefix mappings when only absolute IRIs are provided", () => {
    // baseline namespaces (core RDF prefixes should be present)
    const before = rdfManager.getNamespaces();
    expect(before).toHaveProperty("rdf");
    expect(before).toHaveProperty("rdfs");
    expect(before).toHaveProperty("owl");
    expect(before).toHaveProperty("xsd");

    // Provide a parsed node that only contains absolute IRIs (no prefixed terms)
    const parsed = [
      {
        iri: "http://example.test/instance1",
        rdfTypes: ["http://example.test/Type1"],
        annotationProperties: [
          { propertyUri: "http://example.test/prop", value: "val" },
        ],
      },
    ];

    // Apply parsed nodes (should persist triples but not create new prefix mappings)
    rdfManager.applyParsedNodes(parsed);

    const after = rdfManager.getNamespaces();

    // Ensure core prefixes remain
    expect(after).toHaveProperty("rdf");
    expect(after).toHaveProperty("rdfs");
    expect(after).toHaveProperty("owl");
    expect(after).toHaveProperty("xsd");

    // Ensure no newly-created prefix maps include the test domain (i.e., we didn't invent an 'example' prefix)
    const anyExampleNamespace = Object.values(after || {}).some((v) =>
      String(v || "").includes("example.test"),
    );
    expect(anyExampleNamespace).toBe(false);
  });
});
