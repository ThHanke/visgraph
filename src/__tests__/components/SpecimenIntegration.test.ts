import { describe, it, expect } from 'vitest';
import { TemplateManager } from '../../components/Canvas/core/TemplateManager';
import { useOntologyStore } from '../../stores/ontologyStore';
import { clearDisplayInfoCache } from '../../components/Canvas/core/nodeDisplay';

describe('TemplateManager runtime integration (namespaces + cache)', () => {
  it('recomputes prefixed label after namespaces change and cache clear', () => {
    const mockRdfManagerA = {
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

    const mockRdfManagerB = {
      getNamespaces: () => ({
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        owl: 'http://www.w3.org/2002/07/owl#',
        'iof': 'https://spec.industrialontologies.org/ontology/materials/'
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

    // Ensure store contains the initial manager and classes
    if (typeof useOntologyStore.setState === 'function') {
      useOntologyStore.setState({
        rdfManager: mockRdfManagerA as any,
        availableClasses: availableClasses as any
      });
    } else {
      const s = (useOntologyStore as any).getState();
      s.rdfManager = mockRdfManagerA;
      s.availableClasses = availableClasses;
    }

    const tm = new TemplateManager();

    const nodeData = {
      uri: 'https://example.org/instances/specimen1',
      rdfTypes: [
        'http://www.w3.org/2002/07/owl#NamedIndividual',
        'https://spec.industrialontologies.org/ontology/materials/Specimen'
      ],
      classType: 'NamedIndividual'
    };

    const computedA = (tm as any).computeDisplayType(nodeData);
    expect(computedA).toBe('iof-mat:Specimen');

    // Now simulate namespaces changing in the store -> same URI but different prefix token
    // Update availableClasses to reflect new namespace token as well (matching real runtime behavior)
    const availableClassesB = [
      {
        uri: 'https://spec.industrialontologies.org/ontology/materials/Specimen',
        label: 'Specimen',
        namespace: 'iof',
        properties: []
      }
    ];

    // Update store and clear memo cache so computeDisplayInfoMemo recomputes
    if (typeof useOntologyStore.setState === 'function') {
      useOntologyStore.setState({
        rdfManager: mockRdfManagerB as any,
        availableClasses: availableClassesB as any
      });
    } else {
      const s = (useOntologyStore as any).getState();
      s.rdfManager = mockRdfManagerB;
      s.availableClasses = availableClassesB;
    }

    // Clear the display info cache to force recomputation using new namespaces
    clearDisplayInfoCache();

    const computedB = (tm as any).computeDisplayType(nodeData);
    expect(computedB).toBe('iof:Specimen');
  });
});
