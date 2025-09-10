import { describe, it, expect, beforeEach } from 'vitest';
import { RDFParser, parseRDFFile } from '../../utils/rdfParser';

describe('RDFParser', () => {
  let parser: RDFParser;

  beforeEach(() => {
    parser = new RDFParser();
  });

  describe('parseRDF', () => {
    it('should parse simple RDF Turtle', async () => {
      const turtle = `
        @prefix foaf: <http://xmlns.com/foaf/0.1/> .
        @prefix : <http://example.org/> .
        
        :john a foaf:Person ;
              foaf:name "John Doe" ;
              foaf:age "30" .
      `;

      const result = await parser.parseRDF(turtle);
      
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].individualName).toBe('john');
      // Parser returns prefixed class IRIs (e.g. "foaf:Person") — assert endsWith local name and namespace
      expect(String(result.nodes[0].classType)).toMatch(/Person$/);
      expect(result.nodes[0].namespace).toBe('foaf');
      expect(result.nodes[0].literalProperties).toContainEqual({
        key: 'foaf:name',
        value: 'John Doe',
        type: undefined
      });
    });

    it('should identify OWL entities correctly', async () => {
      const owl = `
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix : <http://example.org/> .
        
        :Person a owl:Class ;
                rdfs:label "Person" .
        
        :knows a owl:ObjectProperty ;
               rdfs:label "knows" .
      `;

      const result = await parser.parseRDF(owl);
      
      const personClass = result.nodes.find(n => n.individualName === 'Person');
      const knowsProperty = result.nodes.find(n => n.individualName === 'knows');
      
      expect(personClass?.entityType).toBe('class');
      expect(knowsProperty?.entityType).toBe('property');
      expect(personClass?.rdfType).toBe('owl:Class');
      expect(knowsProperty?.rdfType).toBe('owl:ObjectProperty');
    });

    it('should handle object properties with labels', async () => {
      const turtle = `
        @prefix foaf: <http://xmlns.com/foaf/0.1/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        @prefix : <http://example.org/> .
        
        :john a foaf:Person .
        :mary a foaf:Person .
        
        :john foaf:knows :mary .
        
        foaf:knows rdfs:label "knows" .
      `;

      const result = await parser.parseRDF(turtle);
      
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].label).toBe('knows');
      expect(result.edges[0].propertyType).toBe('foaf:knows');
    });

    it('should include base namespace', async () => {
      const turtle = `
        @prefix : <http://example.org/> .
        
        :entity a :Class .
      `;

      const result = await parser.parseRDF(turtle);
      
      // Parser exposes base namespace as the full URL string for ':' prefix
      expect(result.namespaces[':']).toBe('http://example.org/');
      expect(result.prefixes[':']).toBe('http://example.org/');
    });
  });

  describe('parseRDFFile wrapper', () => {
    it('should work with the wrapper function', async () => {
      const turtle = `
        @prefix foaf: <http://xmlns.com/foaf/0.1/> .
        @prefix : <http://example.org/> .
        
        :john a foaf:Person ;
              foaf:name "John" .
      `;

      const result = await parseRDFFile(turtle);
      
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].individualName).toBe('john');
    });

    it('should call progress callback', async () => {
      const turtle = `@prefix : <http://example.org/> . :test a :Class .`;
      const progressCalls: Array<{progress: number, message: string}> = [];
      
      await parseRDFFile(turtle, (progress, message) => {
        progressCalls.push({ progress, message });
      });
      
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(call => call.progress === 100)).toBe(true);
    });
  });
});
