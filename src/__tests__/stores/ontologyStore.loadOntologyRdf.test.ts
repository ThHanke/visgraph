import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";

describe("OntologyStore RDF persistence when loading ontologies", () => {
  it("adds triples to the RDF store when a well-known OWL ontology URL is loaded (triples increase by hundreds)", async () => {
    const store = useOntologyStore.getState();

    // Ensure a clean environment
    store.clearOntologies();

    // Get RDF manager and underlying store (before loading)
    const mgr = store.getRdfManager();
    const rdfStore = mgr.getStore();

    // Count triples before load
    const before = (rdfStore.getQuads && Array.isArray(rdfStore.getQuads(null, null, null, null))
      ? rdfStore.getQuads(null, null, null, null).length
      : (rdfStore.getQuads ? rdfStore.getQuads(null, null, null, null).length : 0)) || 0;

    // Load a public OWL ontology from the web (canonical W3C OWL URL)
    // This test intentionally fetches a remote OWL ontology to verify substantial triples are added.
    await store.loadOntology("http://www.w3.org/2002/07/owl");

    // Count triples after load
    const after = (rdfStore.getQuads && Array.isArray(rdfStore.getQuads(null, null, null, null))
      ? rdfStore.getQuads(null, null, null, null).length
      : (rdfStore.getQuads ? rdfStore.getQuads(null, null, null, null).length : 0)) || 0;

    // Expect a significant increase (at least ~100 triples)
    const delta = after - before;
    expect(delta).toBeGreaterThanOrEqual(100);

    // Ensure the OWL namespace/prefix was registered
    const ns = mgr.getNamespaces ? mgr.getNamespaces() : {};
    expect(ns.owl).toBeDefined();

    // Clean up
    store.clearOntologies();
  });
});
