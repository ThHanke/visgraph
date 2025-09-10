import { describe, it, expect } from 'vitest';
import { exportGraph } from '../../utils/graphExporter';

describe('Graph Exporter', () => {
  const mockNodes = [
    {
      key: 'node1',
      classType: 'Person',
      individualName: 'john',
      namespace: 'foaf',
      literalProperties: [
        { key: 'foaf:name', value: 'John Doe', type: 'string' }
      ]
    },
    {
      key: 'node2', 
      classType: 'Organization',
      individualName: 'acme',
      namespace: 'org',
      literalProperties: []
    }
  ];

  const mockLinks = [
    {
      from: 'node1',
      to: 'node2',
      label: 'works for',
      propertyType: 'foaf:memberOf',
      namespace: 'foaf'
    }
  ];

  describe('Turtle export', () => {
    it('should export valid Turtle format', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'turtle');
      
      expect(result).toContain('@prefix foaf:');
      expect(result).toContain('@prefix org:');
      // exporter currently emits prefixed IRIs for subjects (e.g. foaf:john) and explicit org: prefix
      expect(result).toContain('foaf:john a foaf:Person');
      expect(result).toContain('foaf:name "John Doe"');
      expect(result).toContain('foaf:john foaf:memberOf org:acme');
    });

    it('should handle empty graphs', async () => {
      const result = await exportGraph([], [], 'turtle');
      // Ensure prefixes are present and output is not empty
      expect(result).toContain('@prefix');
      expect(result.trim().length).toBeGreaterThan(0);
    });
  });

  describe('OWL-XML export', () => {
    it('should export valid OWL-XML format', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'owl-xml');
      // Accept XML declaration with or without encoding attribute
      expect(result).toMatch(/<\?xml\s+version=.*\?>/);
      // The exporter emits owl:Ontology inside an rdf:RDF wrapper
      expect(result).toContain('<owl:Ontology');
      // Ensure exported individuals and properties are present in some form
      expect(result).toContain('foaf:Person');
      expect(result).toContain('foaf:name');
      expect(result).toContain('ObjectPropertyAssertion');
    });
  });

  describe('JSON-LD export', () => {
    it('should export valid JSON-LD format', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'json-ld');
      
      const parsed = JSON.parse(result);
      expect(parsed['@context']).toBeDefined();
      expect(parsed['@graph']).toBeInstanceOf(Array);
      expect(parsed['@graph'].length).toBeGreaterThanOrEqual(1);
    });

    it('should include proper context', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'json-ld');
      
      const parsed = JSON.parse(result);
      expect(parsed['@context']['foaf']).toBe('http://xmlns.com/foaf/0.1/');
      expect(parsed['@context']['org']).toBe('https://www.w3.org/TR/vocab-org/');
    });
  });

  describe('Error handling', () => {
    it('should handle invalid format', async () => {
      await expect(exportGraph(mockNodes, mockLinks, 'invalid' as any))
        .rejects.toThrow(/Unsupported/);
    });

    it('should handle malformed node data', async () => {
      const badNodes = [{ key: 'test' }] as any;
      
      const result = await exportGraph(badNodes, [], 'turtle');
      // Exporter should not throw and should include prefix declarations
      expect(result).toContain('@prefix');
    });
  });
});
