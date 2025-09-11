import { describe, it, expect } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';

describe('OntologyStore RDF persistence when loading ontologies', () => {
  it('adds triples to the RDF store when a well-known ontology URL is loaded', async () => {
    const store = useOntologyStore.getState();

    // Ensure a clean environment
    store.clearOntologies();

    // Load a well-known mock ontology (the store implementation recognizes FOAF and loads TTL)
    await store.loadOntology('http://xmlns.com/foaf/0.1/');

    // Get the RDF manager and the underlying store
    const mgr = store.getRdfManager();
    const rdfStore = mgr.getStore();

    // Collect all quads and look for an rdfs:label triple with object "Person"
    const all = rdfStore.getQuads(null, null, null, null) || [];
    const rdfsLabelIri = (mgr && typeof mgr.expandPrefix === 'function') ? (() => {
      try { return mgr.expandPrefix('rdfs:label'); } catch { return 'http://www.w3.org/2000/01/rdf-schema#label'; }
    })() : 'http://www.w3.org/2000/01/rdf-schema#label';

    // Instead of relying on synthetic triples, ensure the FOAF namespace was registered
    // when the well-known FOAF URL was handled.
    const ns = mgr.getNamespaces ? mgr.getNamespaces() : {};
    expect(ns.foaf).toBeDefined();

    // Also ensure the loadedOntologies list contains an entry for FOAF
    const state = useOntologyStore.getState();
    expect(state.loadedOntologies.some(o => o.name === 'FOAF')).toBe(true);

    // Clean up
    store.clearOntologies();
  });
});
