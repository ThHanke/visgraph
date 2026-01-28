import { describe, it, expect } from 'vitest';
import mapQuadsToDiagram from '../../components/Canvas/core/mappingHelpers';
import { RDF_TYPE, RDFS, OWL, XSD } from '../../constants/vocabularies';

describe('mapQuadsToDiagram - properties field population', () => {
  it('should populate properties field with annotation properties for display', () => {
    // Test data similar to MaterialDigital shape-data.ttl
    const quads = [
      {
        subject: { value: 'https://example.org/scalar_value_spec' },
        predicate: { value: RDF_TYPE },
        object: { value: OWL.NamedIndividual },
      },
      {
        subject: { value: 'https://example.org/scalar_value_spec' },
        predicate: { value: RDFS.label },
        object: { 
          value: 'Scalar Value Specification',
          termType: 'Literal',
          datatype: { value: XSD.string }
        },
      },
      {
        subject: { value: 'https://example.org/scalar_value_spec' },
        predicate: { value: 'https://w3id.org/pmd/co/PMD_0000006' }, // has_specified_numeric_value
        object: { 
          value: '3.3',
          termType: 'Literal',
          datatype: { value: XSD.decimal }
        },
      },
      {
        subject: { value: 'https://example.org/scalar_value_spec' },
        predicate: { value: 'http://purl.obolibrary.org/obo/IAO_0000039' }, // has measurement unit label
        object: { 
          value: '%',
          termType: 'Literal',
          datatype: { value: XSD.string }
        },
      },
    ];

    const { nodes } = mapQuadsToDiagram(quads);

    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    
    // Check that the node has data
    expect(node.data).toBeDefined();
    expect(node.data.iri).toBe('https://example.org/scalar_value_spec');
    
    // Check that annotationProperties is populated
    expect(node.data.annotationProperties).toBeDefined();
    expect(Array.isArray(node.data.annotationProperties)).toBe(true);
    expect(node.data.annotationProperties.length).toBeGreaterThan(0);
    
    // **CRITICAL**: Check that properties field is populated (this is what RDFNode.tsx reads)
    expect(node.data.properties).toBeDefined();
    expect(Array.isArray(node.data.properties)).toBe(true);
    expect(node.data.properties.length).toBeGreaterThan(0);
    
    // Verify properties contains the annotation properties we added
    const hasNumericValue = node.data.properties.find(
      (p: any) => p.property === 'https://w3id.org/pmd/co/PMD_0000006'
    );
    expect(hasNumericValue).toBeDefined();
    expect(hasNumericValue.value).toBe('3.3');
    
    const hasUnitLabel = node.data.properties.find(
      (p: any) => p.property === 'http://purl.obolibrary.org/obo/IAO_0000039'
    );
    expect(hasUnitLabel).toBeDefined();
    expect(hasUnitLabel.value).toBe('%');
    
    // Verify rdfs:label is also in properties
    const hasLabel = node.data.properties.find(
      (p: any) => p.property === RDFS.label
    );
    expect(hasLabel).toBeDefined();
    expect(hasLabel.value).toBe('Scalar Value Specification');
  });

  it('should handle empty properties gracefully', () => {
    const quads = [
      {
        subject: { value: 'https://example.org/minimal' },
        predicate: { value: RDF_TYPE },
        object: { value: OWL.NamedIndividual },
      },
    ];

    const { nodes } = mapQuadsToDiagram(quads);

    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    
    // Should have properties field even if empty
    expect(node.data.properties).toBeDefined();
    expect(Array.isArray(node.data.properties)).toBe(true);
  });
});
