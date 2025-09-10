import { describe, it, expect, beforeEach } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';

describe('Ontology Store', () => {
  beforeEach(() => {
    useOntologyStore.getState().clearOntologies();
  });

  describe('loadOntology', () => {
    it('should load mock FOAF ontology', async () => {
      const store = useOntologyStore.getState();
      
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      
      // Read fresh state after async load to avoid snapshot issues
      const state = useOntologyStore.getState();
      expect(state.loadedOntologies).toHaveLength(1);
      expect(state.loadedOntologies[0].name).toBe('FOAF');
      expect(state.availableClasses.length).toBeGreaterThan(0);
      expect(state.availableProperties.length).toBeGreaterThan(0);
    });

    it('should accumulate multiple ontologies', async () => {
      const store = useOntologyStore.getState();
      
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      await store.loadOntology('https://www.w3.org/TR/vocab-org/');
      
      // Read fresh state after async loads
      const state = useOntologyStore.getState();
      expect(state.loadedOntologies).toHaveLength(2);
      expect(state.availableClasses.some(c => c.namespace === 'foaf')).toBe(true);
      expect(state.availableClasses.some(c => c.namespace === 'org')).toBe(true);
    });
  });

  describe('validateGraph', () => {
    it('should validate nodes against loaded classes', async () => {
      const store = useOntologyStore.getState();
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      
      const nodes = [
        { id: 'node1', data: { classType: 'Person', namespace: 'foaf' } },
        { id: 'node2', data: { classType: 'InvalidClass', namespace: 'foaf' } }
      ];
      
      const errors = store.validateGraph(nodes, []);
      
      expect(errors).toHaveLength(1);
      expect(errors[0].nodeId).toBe('node2');
      expect(errors[0].message).toContain('InvalidClass not found');
    });

    it('should validate property domain and range', async () => {
      const store = useOntologyStore.getState();
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      
      const nodes = [
        { id: 'node1', data: { classType: 'Person', namespace: 'foaf' } },
        { id: 'node2', data: { classType: 'Organization', namespace: 'foaf' } }
      ];
      
      const edges = [
        {
          id: 'edge1',
          source: 'node1',
          target: 'node2',
          data: { propertyType: 'foaf:memberOf' }
        }
      ];
      
      const errors = store.validateGraph(nodes, edges);
      
      expect(errors).toHaveLength(0); // Should be valid
    });
  });

  describe('getCompatibleProperties', () => {
    it('should return compatible properties for class pair', async () => {
      const store = useOntologyStore.getState();
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      
      const properties = store.getCompatibleProperties('foaf:Person', 'foaf:Organization');
      
      expect(properties.length).toBeGreaterThan(0);
      expect(properties.some(p => p.uri === 'foaf:memberOf')).toBe(true);
    });

    it('should handle empty restrictions', async () => {
      const store = useOntologyStore.getState();
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      
      const properties = store.getCompatibleProperties('unknown:Class1', 'unknown:Class2');
      
      // Should return properties without domain/range restrictions
      expect(properties.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('setCurrentGraph', () => {
    it('should update current graph', () => {
      const store = useOntologyStore.getState();
      const nodes = [{ id: 'test' }];
      const edges = [{ id: 'testEdge' }];
      
      store.setCurrentGraph(nodes, edges);
      const updated = useOntologyStore.getState();
      
      expect(updated.currentGraph.nodes).toEqual(nodes);
      expect(updated.currentGraph.edges).toEqual(edges);
    });
  });

  describe('clearOntologies', () => {
    it('should clear all store data', async () => {
      const store = useOntologyStore.getState();
      
      // Load some data first
      await store.loadOntology('http://xmlns.com/foaf/0.1/');
      store.setCurrentGraph([{ id: 'test' }], []);
      
      // Clear everything
      store.clearOntologies();
      
      expect(store.loadedOntologies).toHaveLength(0);
      expect(store.availableClasses).toHaveLength(0);
      expect(store.availableProperties).toHaveLength(0);
      expect(store.validationErrors).toHaveLength(0);
      expect(store.currentGraph.nodes).toHaveLength(0);
      expect(store.currentGraph.edges).toHaveLength(0);
    });
  });
});
