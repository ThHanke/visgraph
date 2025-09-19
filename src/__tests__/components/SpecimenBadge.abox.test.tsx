import { describe, it, expect } from 'vitest';
import { computeBadgeText } from '../../components/Canvas/core/nodeDisplay';

describe('Specimen badge display (ABox)', () => {
  it('prefers first non-NamedIndividual rdf:type when present (ABox)', () => {
    // Mock RDF manager with the iof-mat namespace registered
    const mockRdfManager = {
      getNamespaces: () => ({
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        owl: 'http://www.w3.org/2002/07/owl#',
        'iof-mat': 'https://spec.industrialontologies.org/ontology/materials/'
      }),
    } as any;

    // Canonical node resembles parsed graph: has NamedIndividual plus meaningful class URI
    const canonicalNode = {
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      iri: 'https://example.org/instances/specimen1'
    };

    // computeBadgeText should pick the non-NamedIndividual type and return a prefixed form
    const badge = computeBadgeText(canonicalNode as any, mockRdfManager as any, []);
    expect(badge).toBeDefined();
    expect(badge).toContain('iof-mat');
    expect(badge).toBe('iof-mat:Specimen');
  });
});
