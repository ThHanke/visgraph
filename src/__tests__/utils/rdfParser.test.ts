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
      
      // Parser may produce a small set of nodes; ensure john is present and has expected properties
      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      const john = result.nodes.find((n: any) => String(n.individualName).toLowerCase() === 'john');
      expect(john).toBeDefined();
      // Class type should mention Person (either prefixed or full IRI)
      expect(String(john?.classType || john?.rdfTypes || '')).toMatch(/Person/);
      // literalProperties should include the foaf:name value (be permissive about key form)
      expect((john?.literalProperties || []).some((lp: any) => String(lp.value) === 'John Doe')).toBeTruthy();
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
      
      const personClass = result.nodes.find((n: any) => String(n.individualName) === 'Person');
      const knowsProperty = result.nodes.find((n: any) => String(n.individualName) === 'knows');
      
      expect(personClass).toBeDefined();
      expect(knowsProperty).toBeDefined();
      // Accept either explicit rdfType containing owl:Class or an entityType marker
      const personIsClass = (Array.isArray(personClass?.rdfTypes) && personClass.rdfTypes.join(" ").includes("owl:Class")) || personClass?.entityType === 'class';
      const knowsIsProperty = (Array.isArray(knowsProperty?.rdfTypes) && knowsProperty.rdfTypes.join(" ").includes("ObjectProperty")) || knowsProperty?.entityType === 'property';
      expect(personIsClass).toBeTruthy();
      expect(knowsIsProperty).toBeTruthy();
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
      
      // Accept one or more edges but ensure a foaf:knows edge exists with label 'knows'
      expect(Array.isArray(result.edges)).toBeTruthy();
      const knowsEdge = (result.edges || []).find((e: any) =>
        String(e.propertyType || e.propertyUri || '').includes('knows') ||
        String(e.label || '').toLowerCase() === 'knows'
      );
      expect(knowsEdge).toBeDefined();
      expect(String(knowsEdge.label || knowsEdge.propertyType || knowsEdge.propertyUri)).toMatch(/knows/i);
    });

    it('should include base namespace', async () => {
      const turtle = `
        @prefix : <http://example.org/> .
        
        :entity a :Class .
      `;

      const result = await parser.parseRDF(turtle);
      
      // Parser exposes base namespace for ':' prefix — be permissive and check it references example.org
      expect(result.namespaces[':'] || result.prefixes[':']).toBeDefined();
      expect(String(result.namespaces[':'] || result.prefixes[':'] || '')).toMatch(/example\.org/);
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
      
      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      const john = result.nodes.find((n: any) => String(n.individualName).toLowerCase() === 'john');
      expect(john).toBeDefined();
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
