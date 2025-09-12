import { describe, it, expect } from 'vitest';
import { computeDisplayInfo } from '../../components/Canvas/core/nodeDisplay';

describe('Display lifecycle: short -> prefixed after namespaces/classes load', () => {
  it('returns short name initially, then prefixed when namespaces/classes available', () => {
    const node = {
      // no rdfTypes, only a short classType (simulates initial state before ontology/class metadata loaded)
      classType: 'Specimen',
      rdfTypes: []
    };

    // 1) Initial compute without namespaces or classes -> should produce short 'Specimen'
    const first = computeDisplayInfo(node, undefined, []);
    expect(first).toBeDefined();
    expect(first.short).toBe('Specimen');
    // In strict mode we no longer infer prefixed form without rdfManager/namespaces.
    // prefixed should equal short when no namespace known
    expect(first.prefixed).toBe('Specimen');

    // 2) Simulate loading ontology/classes and namespaces. In strict mode we
    // require the node to carry a full IRI so prefix resolution can happen.
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

    // Update the node to contain the canonical IRI (strict mode requires full IRI)
    // Also remove the short classType so the full IRI is preferred by computeDisplayInfo.
    node.classType = undefined as any;
    node.rdfTypes = ['https://spec.industrialontologies.org/ontology/materials/Materials/Specimen'];

    const second = computeDisplayInfo(node, rdfManager as any, availableClasses);
    expect(second).toBeDefined();
    // Now we expect a prefixed display (strict resolution)
    expect(second.prefixed).toBe('iof-mat:Specimen');
    expect(second.short).toBe('Specimen');
    expect(second.namespace).toBe('iof-mat');
  });
});
