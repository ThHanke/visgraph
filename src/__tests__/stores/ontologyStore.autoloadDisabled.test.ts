import { describe, it, expect, beforeEach } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { useAppConfigStore } from "../../stores/appConfigStore";
import { FIXTURES } from "../fixtures/rdfFixtures";

describe("ontology auto-load respect disabled list", () => {
  beforeEach(() => {
    // Reset stores to a clean state
    useAppConfigStore.getState().resetToDefaults();
    useOntologyStore.getState().clearOntologies();
  });

  it("does not auto-load a referenced ontology when it is disabled", async () => {
    const foaf = "http://xmlns.com/foaf/0.1/";

    // Mark FOAF as disabled (simulate user removal)
    useAppConfigStore.getState().addDisabledOntology(foaf);

    // Simple TTL that references foaf prefix (should trigger additional ontology detection)
    const ttl =
      FIXTURES["foaf_test_data"] +
      `
@prefix ex: <http://example.org/> .

ex:alice a foaf:Person ;
  foaf:name "Alice" .
`;

    // Load as a knowledge graph (pass the TTL as the source string; loadKnowledgeGraph uses raw content)
    await useOntologyStore
      .getState()
      .loadKnowledgeGraph(ttl, { onProgress: () => {} });

    const loaded = useOntologyStore.getState().loadedOntologies || [];

    const foafLoaded = loaded.some((o) => o.url === foaf);

    expect(foafLoaded).toBe(false);
  }, 10000);
});
