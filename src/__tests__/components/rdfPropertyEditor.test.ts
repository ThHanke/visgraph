// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { elementModelToNodeData, relationLinkToAdapterData } from '../../components/Canvas/rdfPropertyEditor';

// Minimal Rdf.Literal-like shape matching @reactodia/workspace's Rdf.Literal
function makeLiteral(value: string, datatypeIri: string, language = '') {
  return { termType: 'Literal' as const, value, datatype: { value: datatypeIri }, language };
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

describe('elementModelToNodeData', () => {
  it('maps id and types', () => {
    const model = {
      id: 'http://example.com/Foo',
      types: ['http://example.com/MyClass'],
      properties: {},
    };
    const result = elementModelToNodeData(model as any);
    expect(result.iri).toBe('http://example.com/Foo');
    expect(result.rdfTypes).toEqual(['http://example.com/MyClass']);
  });

  it('maps literal properties to annotationProperties', () => {
    const label = makeLiteral('My Label', XSD_STRING);
    const model = {
      id: 'http://example.com/Foo',
      types: [],
      properties: {
        [RDFS_LABEL]: [label],
      },
    };
    const result = elementModelToNodeData(model as any);
    expect(result.annotationProperties).toHaveLength(1);
    expect(result.annotationProperties[0].key).toBe(RDFS_LABEL);
    expect(result.annotationProperties[0].value).toBe('My Label');
    expect(result.annotationProperties[0].type).toBe(XSD_STRING);
    expect(result.annotationProperties[0].objectTerm).toBe(label);
  });

  it('maps language-tagged literals', () => {
    const label = makeLiteral('Hello', XSD_STRING, 'en');
    const model = {
      id: 'http://example.com/Foo',
      types: [],
      properties: { [RDFS_LABEL]: [label] },
    };
    const result = elementModelToNodeData(model as any);
    expect(result.annotationProperties[0].lang).toBe('en');
  });

  it('skips non-literal terms', () => {
    const namedNode = { termType: 'NamedNode', value: 'http://example.com/Bar' };
    const model = {
      id: 'http://example.com/Foo',
      types: [],
      properties: { [RDF_COMMENT]: [namedNode as any] },
    };
    const result = elementModelToNodeData(model as any);
    expect(result.annotationProperties).toHaveLength(0);
  });

  it('handles multiple values for the same property', () => {
    const model = {
      id: 'http://example.com/Foo',
      types: [],
      properties: {
        [RDFS_LABEL]: [
          makeLiteral('English', XSD_STRING, 'en'),
          makeLiteral('German', XSD_STRING, 'de'),
        ],
      },
    };
    const result = elementModelToNodeData(model as any);
    expect(result.annotationProperties).toHaveLength(2);
  });
});

describe('relationLinkToAdapterData', () => {
  it('maps link type and source/target IRIs', () => {
    const link = {
      data: { linkTypeId: 'http://example.com/relatesTo', sourceId: '', targetId: '', properties: {} },
      sourceId: 'elem-1',
      targetId: 'elem-2',
    };
    const sourceEl = {
      data: { id: 'http://example.com/A', types: ['http://example.com/ClassA'], properties: {} },
    };
    const targetEl = {
      data: { id: 'http://example.com/B', types: ['http://example.com/ClassB'], properties: {} },
    };

    const result = relationLinkToAdapterData(link as any, sourceEl as any, targetEl as any);
    expect(result.linkData.propertyUri).toBe('http://example.com/relatesTo');
    expect(result.sourceNode.iri).toBe('http://example.com/A');
    expect(result.sourceNode.rdfTypes).toEqual(['http://example.com/ClassA']);
    expect(result.targetNode.iri).toBe('http://example.com/B');
    expect(result.targetNode.rdfTypes).toEqual(['http://example.com/ClassB']);
  });
});
