import { describe, it, expect } from 'vitest';
import { computeDisplayInfo, shortLocalName } from '../../components/Canvas/core/nodeDisplay';

describe('Specimen  node mapping', () => {
  it('produces a goNode.type with iof-mat:Specimen for specimen-like input', () => {
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

    const src = {
      iri: 'https://example.org/instances/specimen1',
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      classType: 'NamedIndividual',
      namespace: 'iof-mat'
    };

    const availableClasses = [
      {
       iri: 'https://spec.industrialontologies.org/ontology/materials/Specimen',
        label: 'Specimen',
        namespace: 'iof-mat',
        properties: []
      }
    ];

    // emulate Canvas mapping logic to produce a goNode
    const _dispInfo = computeDisplayInfo(src, mockRdfManager, availableClasses);
    const disp = _dispInfo || null;
    const displayLabel = (disp && (disp.prefixed || disp.short))
      || ( (Array.isArray(src.rdfTypes) ? src.rdfTypes.find((t:any) => t && !String(t).includes('NamedIndividual')) : undefined) ? shortLocalName(String((Array.isArray(src.rdfTypes) ? src.rdfTypes.find((t:any) => t && !String(t).includes('NamedIndividual')) : undefined))) : (src.classType || shortLocalName(src.iri || src.iri || '')) );

    const goNode = {
      key: src.iri,
      iri: src.iri,
      rdfTypes: src.rdfTypes,
      type: displayLabel,
      type_namespace: (disp && typeof disp.namespace === 'string' && disp.namespace) ? disp.namespace : src.namespace || ''
    };

    expect(goNode.type).toBeDefined();
    expect(goNode.type).toBe('iof-mat:Specimen');
    expect(goNode.type_namespace).toBe('iof-mat');
  });
});
