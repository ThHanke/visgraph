import { describe, it, expect } from 'vitest';
import { TemplateManager } from '../../components/Canvas/core/TemplateManager';
import { useOntologyStore } from '../../stores/ontologyStore';

describe('TemplateManager badge binding', () => {
  it('computeDisplayType returns iof-mat:Specimen for specimen-like node', () => {
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

    const availableClasses = [
      {
        uri: 'https://spec.industrialontologies.org/ontology/materials/Specimen',
        label: 'Specimen',
        namespace: 'iof-mat',
        properties: []
      }
    ];

    // Set store state so TemplateManager.computeDisplayType can read rdfManager & availableClasses
    // Zustand store exposes setState on the hook function
    if (typeof useOntologyStore.setState === 'function') {
      useOntologyStore.setState({
        rdfManager: mockRdfManager as any,
        availableClasses: availableClasses as any
      });
    } else if (typeof (useOntologyStore as any).getState === 'function') {
      // Fallback: mutate getState() return for this test env if possible
      const s = (useOntologyStore as any).getState();
      s.rdfManager = mockRdfManager;
      s.availableClasses = availableClasses;
    }

    const tm = new TemplateManager();
    // Private method; call via any to emulate template binding behavior
    const nodeData = {
      uri: 'https://example.org/instances/specimen1',
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      classType: 'NamedIndividual'
    };

    const computed = (tm as any).computeDisplayType(nodeData);
    expect(computed).toBeDefined();
    expect(computed).toBe('iof-mat:Specimen');
  });
});
