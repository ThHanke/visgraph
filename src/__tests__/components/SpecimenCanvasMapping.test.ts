import { describe, it, expect } from 'vitest';
import { computeDisplayInfoMemo, shortLocalName } from '../../components/Canvas/core/nodeDisplay';

describe('Specimen canvas mapping', () => {
  it('maps a canonical parsed node -> displayLabel with iof-mat prefix', () => {
    const mockRdfManager = {
      getNamespaces: () => ({
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        owl: 'http://www.w3.org/2002/07/owl#',
        'iof-mat': 'https://spec.industrialontologies.org/ontology/materials/'
      }),
      expandPrefix: (pref: string) => {
        if (pref === 'rdf:type') return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
        return undefined;
      }
    };

    // Simulate a parsed node (src) coming from the parser/currentGraph
    const src = {
      uri: 'https://example.org/instances/specimen1',
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      classType: 'NamedIndividual'
    };

    // availableClasses as would be present in the store (label + uri)
    const availableClasses = [
      {
        uri: 'https://spec.industrialontologies.org/ontology/materials/Specimen',
        label: 'Specimen',
        namespace: 'iof-mat',
        properties: []
      }
    ];

    // This mirrors the mapping logic used in Canvas
    const _dispInfo = computeDisplayInfoMemo(src, mockRdfManager, availableClasses);
    const displayInfo = _dispInfo || null;

    const computedTypeFull = (
      (displayInfo && displayInfo.canonicalTypeUri) ||
      (Array.isArray(src.rdfTypes) ? src.rdfTypes.find((t:any) => t && !String(t).includes('NamedIndividual')) : undefined) ||
      (src.classType && !String(src.classType).includes('NamedIndividual') ? src.classType : undefined)
    );

    const displayLabel = (displayInfo && (displayInfo.prefixed || displayInfo.short))
      || (computedTypeFull ? shortLocalName(String(computedTypeFull)) : (src.classType || shortLocalName(src.uri || src.iri || '')));

    expect(displayInfo).toBeDefined();
    expect(displayInfo?.prefixed).toBe('iof-mat:Specimen');
    expect(displayLabel).toBe('iof-mat:Specimen');
  });
});
