import { describe, it, expect } from 'vitest';
import { computeDisplayInfoMemo, clearDisplayInfoCache } from '../../components/Canvas/core/nodeDisplay';

describe('Display lifecycle: short -> prefixed after namespaces/classes load', () => {
  it('returns short name initially, then prefixed when namespaces/classes available', () => {
    const node = {
      // no rdfTypes, only a short classType (simulates initial state before ontology/class metadata loaded)
      classType: 'Specimen',
      rdfTypes: []
    };

    // 1) Initial compute without namespaces or classes -> should produce short 'Specimen'
    const first = computeDisplayInfoMemo(node, undefined, []);
    expect(first).toBeDefined();
    expect(first.short).toBe('Specimen');
    // prefixed should equal short when no namespace known
    expect(first.prefixed).toBe('Specimen');

    // 2) Simulate loading ontology/classes and namespaces
    clearDisplayInfoCache();

    const rdfManager = {
      getNamespaces: () => ({
        'iof-mat': 'https://spec.industrialontologies.org/ontology/materials/Materials/'
      })
    };

    const availableClasses = [
      {
       iri: 'https://spec.industrialontologies.org/ontology/materials/Materials/Specimen',
        label: 'Specimen',
        namespace: 'iof-mat'
      }
    ];

    const second = computeDisplayInfoMemo(node, rdfManager as any, availableClasses);
    expect(second).toBeDefined();
    // Now we expect a prefixed display
    expect(second.prefixed).toBe('iof-mat:Specimen');
    expect(second.short).toBe('Specimen');
    expect(second.namespace).toBe('iof-mat');
  });
});
