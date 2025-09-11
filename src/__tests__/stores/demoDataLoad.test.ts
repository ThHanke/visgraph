import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("Demo data load - ensures triples for Specimen are present", () => {
  it("loads RDF content and ensures iof:Specimen triple is present", async () => {
    // Minimal TTL that represents the demo snippet the user referenced
    const ttl =
      FIXTURES[
        "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl"
      ];

    const store = useOntologyStore.getState();
    // Load RDF directly into the rdfManager to ensure prefixes are registered and triples are present
    const mgr = store.rdfManager;
    await mgr.loadRDF(ttl);

    // Export current store to Turtle and assert the export contains the Specimen triple (robust check)
    const exportTtl = await mgr.exportToTurtle();
    expect(typeof exportTtl).toBe("string");
    // The export should contain 'Specimen' as a type or subject reference
    expect(/Specimen\b/.test(exportTtl)).toBe(true);
  });
});
