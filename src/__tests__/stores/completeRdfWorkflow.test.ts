/**
 * @fileoverview Complete RDF Workflow Unit Tests
 * Tests the complete data flow from file loading -> RDF store -> canvas -> updates -> export
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';
import { RDFManager } from '../../utils/rdfManager';
import { FIXTURES } from '../fixtures/rdfFixtures';

describe('Complete RDF Workflow', () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  describe('Step 1: File Loading to RDF Store', () => {
    it('should load demo file entities into RDF store', async () => {
      const store = useOntologyStore.getState();

      const demoRdf = FIXTURES['https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl'];

      await store.loadOntologyFromRDF(demoRdf, undefined, false);

      // Verify entities are in RDF store (read fresh state)
      const rdfStore = useOntologyStore.getState().rdfManager.getStore();
      
      const specimenLengthQuads = rdfStore.getQuads(
        'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        null,
        null
      );
      expect(specimenLengthQuads).toHaveLength(1);

      const caliperQuads = rdfStore.getQuads(
        'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/Caliper',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        null,
        null
      );
      expect(caliperQuads).toHaveLength(1);

      // Verify canvas entities are created (read fresh state)
      const currentGraph = useOntologyStore.getState().currentGraph;
      expect(currentGraph.nodes).toHaveLength(2);
      
      const specimenNode = currentGraph.nodes.find(n => n.data.individualName === 'SpecimenLength');
      expect(specimenNode).toBeDefined();
      expect(specimenNode?.data.classType).toBe('Length');
      expect(specimenNode?.data.namespace).toBe('iof-qual');
    });
  });

  describe('Step 2: Canvas Changes Reflected in RDF Store', () => {
    it('should update RDF store when canvas entity properties are modified', async () => {
      const store = useOntologyStore.getState();

      // Load initial data
      const initialRdf = FIXTURES['https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl'];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      const entityUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';

      // Simulate canvas entity update
      store.updateNode(entityUri, {
        annotationProperties: [
          { propertyUri: 'rdfs:label', value: 'My Specimen Length', type: 'xsd:string' },
          { propertyUri: 'rdfs:comment', value: 'Length measurement', type: 'xsd:string' }
        ]
      });

      // Also update the canvas state
      const currentGraph = store.currentGraph;
      const updatedNodes = currentGraph.nodes.map(node => {
        if (node.data.uri === entityUri) {
          return {
            ...node,
            data: {
              ...node.data,
              literalProperties: [
                { key: 'rdfs:label', value: 'My Specimen Length', type: 'xsd:string' },
                { key: 'rdfs:comment', value: 'Length measurement', type: 'xsd:string' }
              ]
            }
          };
        }
        return node;
      });
      store.setCurrentGraph(updatedNodes, currentGraph.edges);

      // Verify RDF store contains the updates
      const rdfStore = store.rdfManager.getStore();
      
      const labelQuads = rdfStore.getQuads(
        entityUri,
        'http://www.w3.org/2000/01/rdf-schema#label',
        null,
        null
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe('My Specimen Length');

      const commentQuads = rdfStore.getQuads(
        entityUri,
        'http://www.w3.org/2000/01/rdf-schema#comment',
        null,
        null
      );
      expect(commentQuads).toHaveLength(1);
      expect(commentQuads[0].object.value).toBe('Length measurement');
    });
  });

  describe('Step 3: Ontology Loading Preserves RDF Store', () => {
    it('should preserve entity updates when loading additional ontology', async () => {
      const store = useOntologyStore.getState();

      // Step 1: Load initial dataset
      const initialRdf = FIXTURES['https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl'];

      await store.loadOntologyFromRDF(initialRdf, undefined, false);

      const entityUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';

      // Step 2: User modifies entity (simulating NodePropertyEditor)
      store.updateNode(entityUri, {
        annotationProperties: [
          { propertyUri: 'rdfs:label', value: 'User Added Label', type: 'xsd:string' }
        ]
      });

      // Also update canvas state
      const currentGraph = store.currentGraph;
      const updatedNodes = currentGraph.nodes.map(node => {
        if (node.data.uri === entityUri) {
          return {
            ...node,
            data: {
              ...node.data,
              literalProperties: [
                { key: 'rdfs:label', value: 'User Added Label', type: 'xsd:string' }
              ]
            }
          };
        }
        return node;
      });
      store.setCurrentGraph(updatedNodes, currentGraph.edges);

      // Step 3: Load additional ontology (simulating "Load Ontology" button)
      const additionalOntologyRdf = FIXTURES['foaf_test_data'];

      await store.loadOntologyFromRDF(additionalOntologyRdf, undefined, true);

      // Step 4: Verify user's label is still preserved in RDF store (read fresh state)
      const rdfStore = useOntologyStore.getState().rdfManager.getStore();
      const labelQuads = rdfStore.getQuads(
        entityUri,
        'http://www.w3.org/2000/01/rdf-schema#label',
        null,
        null
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe('User Added Label');

      // Step 5: Verify new ontology is also loaded
      const personClassQuads = rdfStore.getQuads(
        'http://xmlns.com/foaf/0.1/Person',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'http://www.w3.org/2002/07/owl#Class',
        null
      );
      expect(personClassQuads).toHaveLength(1);

      // Step 6: Verify namespaces from both ontologies are present
      const namespaces = store.rdfManager.getNamespaces();
      expect(namespaces).toHaveProperty('foaf');
      expect(namespaces).toHaveProperty('iof-qual');
    });
  });

  describe('Step 4: Export Contains All Changes', () => {
    it('should export complete RDF including user modifications and loaded ontologies', async () => {
      const store = useOntologyStore.getState();

      // Load demo data
      const demoRdf = FIXTURES['https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl'];

      await store.loadOntologyFromRDF(demoRdf, undefined, false);

      // User adds properties
      const specimenUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';
      store.updateNode(specimenUri, {
        annotationProperties: [
          { propertyUri: 'rdfs:label', value: 'Specimen Length Property', type: 'xsd:string' },
          { propertyUri: 'rdfs:comment', value: 'Measures specimen length', type: 'xsd:string' }
        ]
      });

      // Load additional ontology
      const foafOntology = FIXTURES['foaf_test_data'];

      await store.loadOntologyFromRDF(foafOntology, undefined, true);

      // Export and verify all data is present
      const turtleExport = await store.exportGraph('turtle');

      // Should contain original entities
      expect(turtleExport).toContain('SpecimenLength');
      expect(turtleExport).toContain('Caliper');

      // Should contain user modifications
      expect(turtleExport).toContain('Specimen Length Property');
      expect(turtleExport).toContain('Measures specimen length');

      // Should contain loaded ontology
      expect(turtleExport).toContain('foaf:Person');
      expect(turtleExport).toContain('@prefix foaf:');

      console.log('Complete export test result:', turtleExport);
    });
  });

  describe('Step 5: Reasoner Integration', () => {
    it('should use complete RDF store for reasoning (no phantom inferences)', async () => {
      const store = useOntologyStore.getState();

      // Load only basic data without foaf
      const basicRdf = `
        @prefix ex: <http://example.com/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        ex:john_doe a ex:Person ;
            rdfs:label "John Doe" .
      `;

      await store.loadOntologyFromRDF(basicRdf, undefined, false);

      // Verify RDF store does NOT contain foaf:Agent type for john_doe (read fresh state)
      const rdfStore = useOntologyStore.getState().rdfManager.getStore();
      
      const foafAgentQuads = rdfStore.getQuads(
        'http://example.com/john_doe',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'http://xmlns.com/foaf/0.1/Agent',
        null
      );
      expect(foafAgentQuads).toHaveLength(0);

      // Verify only the correct type is present
      const personQuads = rdfStore.getQuads(
        'http://example.com/john_doe',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'http://example.com/Person',
        null
      );
      expect(personQuads).toHaveLength(1);

      // Verify foaf namespace is not loaded
      const namespaces = store.rdfManager.getNamespaces();
      expect(namespaces).not.toHaveProperty('foaf');
    });
  });

  describe('RDF Manager Consistency', () => {
    it('should maintain consistency between store operations', async () => {
      const rdfManager = new RDFManager();

      // Add namespaces
      rdfManager.addNamespace('ex', 'http://example.com/');
      rdfManager.addNamespace('rdfs', 'http://www.w3.org/2000/01/rdf-schema#');

      // Load initial data
      const initialRdf = `
        @prefix ex: <http://example.com/> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        ex:entity1 a ex:TestClass .
      `;

      await rdfManager.loadRDF(initialRdf);

      // Update entity
      rdfManager.updateNode('http://example.com/entity1', {
        annotationProperties: [
          { propertyUri: 'rdfs:label', value: 'Test Entity', type: 'xsd:string' }
        ]
      });

      // Load additional RDF (simulating ontology load)
      const additionalRdf = `
        @prefix owl: <http://www.w3.org/2002/07/owl#> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

        owl:Thing a owl:Class ;
            rdfs:label "Thing" .
      `;

      await rdfManager.loadRDF(additionalRdf);

      // Verify original entity and its modifications are preserved
      const store = rdfManager.getStore();
      
      const labelQuads = store.getQuads(
        'http://example.com/entity1',
        'http://www.w3.org/2000/01/rdf-schema#label',
        null,
        null
      );
      expect(labelQuads).toHaveLength(1);
      expect(labelQuads[0].object.value).toBe('Test Entity');

      // Verify new ontology data is also present
      const thingQuads = store.getQuads(
        'http://www.w3.org/2002/07/owl#Thing',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'http://www.w3.org/2002/07/owl#Class',
        null
      );
      expect(thingQuads).toHaveLength(1);

      // Export and verify all data is present
      const exported = await rdfManager.exportToTurtle();
      expect(exported).toContain('entity1');
      expect(exported).toContain('Test Entity');
      expect(exported).toContain('owl:Thing');
    });
  });
});
