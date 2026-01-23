import { describe, it, expect } from 'vitest';
import mapQuadsToDiagram from '../../components/Canvas/core/mappingHelpers';

describe('mapQuadsToDiagram - prefix-only IRI handling', () => {
  it('should handle properties with prefix-only IRIs (no local part)', () => {
    // Simulating a case where toPrefixed returns "pmdco:" for an IRI that exactly matches the namespace
    const quads = [
      {
        subject: { value: 'https://example.org/entity1' },
        predicate: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
        object: { value: 'http://www.w3.org/2002/07/owl#NamedIndividual' },
      },
      {
        subject: { value: 'https://example.org/entity1' },
        predicate: { value: 'https://w3id.org/pmd/co/' }, // Prefix-only IRI (namespace with no local part)
        object: { 
          value: '99.2',
          termType: 'Literal',
          datatype: { value: 'http://www.w3.org/2001/XMLSchema#float' }
        },
      },
    ];

    const registry = [
      { prefix: 'pmdco', namespace: 'https://w3id.org/pmd/co/', color: '#ff0000' },
      { prefix: 'ex', namespace: 'https://example.org/', color: '#00ff00' },
    ];

    const { nodes } = mapQuadsToDiagram(quads, { registry });

    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    
    console.log('Node data:', JSON.stringify(node.data, null, 2));
    console.log('Annotation properties:', node.data.annotationProperties);
    console.log('Properties field:', node.data.properties);
    
    // Check that annotationProperties includes the prefix-only IRI
    expect(node.data.annotationProperties).toBeDefined();
    expect(Array.isArray(node.data.annotationProperties)).toBe(true);
    
    const prefixOnlyProp = node.data.annotationProperties.find(
      (p: any) => p.property === 'https://w3id.org/pmd/co/'
    );
    expect(prefixOnlyProp).toBeDefined();
    expect(prefixOnlyProp.value).toBe('99.2');
    
    // Check that properties field also includes it
    expect(node.data.properties).toBeDefined();
    const prefixOnlyInProps = node.data.properties.find(
      (p: any) => p.property === 'https://w3id.org/pmd/co/'
    );
    expect(prefixOnlyInProps).toBeDefined();
    expect(prefixOnlyInProps.value).toBe('99.2');
  });

  it('should not create duplicate entries in annotationProperties', () => {
    const quads = [
      {
        subject: { value: 'https://example.org/entity1' },
        predicate: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
        object: { value: 'http://www.w3.org/2002/07/owl#NamedIndividual' },
      },
      {
        subject: { value: 'https://example.org/entity1' },
        predicate: { value: 'https://w3id.org/pmd/co/PMD_0000006' },
        object: { 
          value: '3.3',
          termType: 'Literal',
          datatype: { value: 'http://www.w3.org/2001/XMLSchema#float' }
        },
      },
    ];

    const { nodes } = mapQuadsToDiagram(quads);

    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    
    // Count occurrences of the property
    const propCount = node.data.annotationProperties.filter(
      (p: any) => p.property === 'https://w3id.org/pmd/co/PMD_0000006'
    ).length;
    
    expect(propCount).toBe(1); // Should appear only once
    
    // Also check in properties field
    const propsCount = node.data.properties.filter(
      (p: any) => p.property === 'https://w3id.org/pmd/co/PMD_0000006'
    ).length;
    
    expect(propsCount).toBe(1); // Should appear only once
  });
});
