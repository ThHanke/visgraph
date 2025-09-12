import { describe, it, expect } from 'vitest';
import { computeDisplayInfo, shortLocalName } from '../../components/Canvas/core/nodeDisplay';

describe('Specimen badge display', () => {
  it('computes a prefixed badge with iof-mat for Specimen node', () => {
    // Mock RDF manager with the iof-mat namespace registered
    const mockRdfManager = {
      getNamespaces: () => ({
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        owl: 'http://www.w3.org/2002/07/owl#',
        'iof-mat': 'https://spec.industrialontologies.org/ontology/materials/'
      })
    };

    // Canonical node resembles parsed graph: has NamedIndividual plus meaningful class URI
    const canonicalNode = {
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      // include iri/uri to mirror canvas nodes
      iri: 'https://example.org/instances/specimen1'
    };

    const info = computeDisplayInfo(canonicalNode, mockRdfManager, []);

    // The helper should produce a prefixed form using the iof-mat prefix
    expect(info).toBeDefined();
    expect(info.prefixed).toBeDefined();
    expect(info.prefixed).toBe('iof-mat:Specimen');

    // Simulate the canvas mapping logic that picks the badge text
    const badgeText = (info.prefixed || info.short || shortLocalName(info.canonicalTypeUri || '')).toString();
    expect(badgeText).toContain('iof-mat');
    expect(badgeText).toBe('iof-mat:Specimen');
  });
});
