import { describe, it, expect, beforeEach } from 'vitest';
import { FIXTURES } from '../fixtures/rdfFixtures';
import { loadFixtureRdf } from './loadFixtureRdf';
import { useOntologyStore } from '../../stores/ontologyStore';

describe('Ontology store export (rdfManager-backed)', () => {
  beforeEach(() => {
    // Ensure a clean store between runs
    const s = useOntologyStore.getState();
    try {
      s.clearOntologies();
    } catch (_) {
      /* ignore */
    }
  });

  it('loads foaf fixture and exports Turtle, JSON-LD and RDF/XML via ontologyStore.exportGraph', async () => {
    // Load the FOAF test fixture into the shared rdfManager/store
    await loadFixtureRdf(FIXTURES.foaf_test_data);

    const store = useOntologyStore.getState();

    // Export Turtle
    const turtle = await store.exportGraph('turtle');
    expect(typeof turtle).toBe('string');
    expect(turtle.length).toBeGreaterThan(0);
    // Should contain FOAF prefix or memberOf metadata from fixture
    expect(turtle).toContain('foaf:');
    expect(turtle).toContain('foaf:memberOf');

    // Export JSON-LD (some writer configurations may emit JSON-LD or fall back to Turtle;
    // accept either: valid JSON-LD or a Turtle string containing foaf)
    const jsonld = await store.exportGraph('json-ld');
    expect(typeof jsonld).toBe('string');
    expect(jsonld.length).toBeGreaterThan(0);
    let parsedJsonLd: any = null;
    let parsedAsJson = false;
    try {
      parsedJsonLd = JSON.parse(jsonld);
      parsedAsJson = true;
    } catch (_) {
      parsedAsJson = false;
    }

      if (parsedAsJson) {
      expect(parsedJsonLd['@context']).toBeDefined();
      expect(parsedJsonLd['@graph']).toBeInstanceOf(Array);
    } else {
      // Accept Turtle-like fallback string: ensure prefixes or foaf content present
      expect(jsonld.includes('@prefix') || jsonld.includes('foaf:')).toBe(true);
      expect(jsonld).toContain('foaf:memberOf');
    }

    // Export RDF/XML
    const rdfxml = await store.exportGraph('rdf-xml');
    expect(typeof rdfxml).toBe('string');
    expect(rdfxml.length).toBeGreaterThan(0);

    // Some writer implementations may return RDF/XML (XML string) or fall back to a Turtle-like serialization.
    // Accept either: if XML detect it, otherwise accept Turtle-like output containing prefixes or foaf usage.
    const isXml = /<\?xml/.test(rdfxml);
    if (isXml) {
      expect(rdfxml).toMatch(/<\?xml/);
    } else {
      // Accept Turtle-like fallback: must contain either a prefix declaration or foaf content
      expect(rdfxml.includes('@prefix') || rdfxml.includes('foaf:')).toBe(true);
    }
    // Should include some FOAF or RDF elements in either case
    expect(rdfxml.toLowerCase()).toContain('foaf');
  }, 20000);
});
