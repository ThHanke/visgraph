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
      expect(result).toContain(':john a foaf:Person');
      expect(result).toContain('foaf:name "John Doe"');
      expect(result).toContain(':john foaf:memberOf :acme');
    });

    it('should handle empty graphs', async () => {
      const result = await exportGraph([], [], 'turtle');
      
      expect(result).toContain('@prefix :');
      expect(result.trim().split('\n')).toHaveLength(2); // Only prefix declarations
    });
  });

  describe('OWL-XML export', () => {
    it('should export valid OWL-XML format', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'owl-xml');
      
      expect(result).toContain('<?xml version="1.0"?>');
      expect(result).toContain('<Ontology');
      expect(result).toContain('<NamedIndividual IRI="#john">');
      expect(result).toContain('<ClassAssertion>');
      expect(result).toContain('<ObjectPropertyAssertion>');
    });
  });

  describe('JSON-LD export', () => {
    it('should export valid JSON-LD format', async () => {
      const result = await exportGraph(mockNodes, mockLinks, 'json-ld');
      
      const parsed = JSON.parse(result);
      expect(parsed['@context']).toBeDefined();
      expect(parsed['@graph']).toBeInstanceOf(Array);
      expect(parsed['@graph'].length).toBe(3); // 2 nodes + 1 relationship
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
        .rejects.toThrow('Unsupported export format');
    });

    it('should handle malformed node data', async () => {
      const badNodes = [{ key: 'test' }] as any;
      
      const result = await exportGraph(badNodes, [], 'turtle');
      expect(result).toContain('@prefix :');
    });
  });
});