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

    const found = all.filter((q: any) =>
      q.predicate && q.predicate.value === rdfsLabelIri &&
      q.object && q.object.value === 'Person'
    );

    // Expect at least one triple containing the label "Person" from the loaded FOAF mock ontology
    expect(found.length).toBeGreaterThan(0);

    // Clean up
    store.clearOntologies();
  });
});
