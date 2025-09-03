/**
 * @fileoverview Ontology Store
 * Manages loaded ontologies, knowledge graphs, and validation for the application.
 * Provides centralized state management for RDF/OWL data and graph operations.
 */

import { create } from 'zustand';

/**
 * Represents an ontology class definition
 */
interface OntologyClass {
  uri: string;
  label: string;
  namespace: string;
  properties: string[];
  restrictions: Record<string, any>;
}

interface ObjectProperty {
  uri: string;
  label: string;
  domain: string[];
  range: string[];
  namespace: string;
}

interface LoadedOntology {
  url: string;
  name?: string;
  classes: OntologyClass[];
  properties: ObjectProperty[];
  namespaces: Record<string, string>;
}

interface ValidationError {
  nodeId: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Main ontology store interface with all state and actions
 */
interface OntologyStore {
  /** Currently loaded ontologies */
  loadedOntologies: LoadedOntology[];
  /** Available classes from all loaded ontologies */
  availableClasses: OntologyClass[];
  /** Available properties from all loaded ontologies */
  availableProperties: ObjectProperty[];
  /** Current validation errors */
  validationErrors: ValidationError[];
  /** Current knowledge graph data */
  currentGraph: { nodes: any[]; edges: any[] };
  
  /** Load an ontology from URL */
  loadOntology: (url: string) => Promise<void>;
  /** Load ontology from RDF content */
  loadOntologyFromRDF: (rdfContent: string, onProgress?: (progress: number, message: string) => void) => Promise<void>;
  /** Load knowledge graph from source */
  loadKnowledgeGraph: (source: string, options?: { onProgress?: (progress: number, message: string) => void }) => Promise<void>;
  /** Validate current graph */
  validateGraph: (nodes: any[], edges: any[]) => ValidationError[];
  /** Get compatible properties between classes */
  getCompatibleProperties: (sourceClass: string, targetClass: string) => ObjectProperty[];
  /** Clear all ontologies */
  clearOntologies: () => void;
  /** Set current graph data */
  setCurrentGraph: (nodes: any[], edges: any[]) => void;
}

export const useOntologyStore = create<OntologyStore>((set, get) => ({
  loadedOntologies: [],
  availableClasses: [],
  availableProperties: [],
  validationErrors: [],
  currentGraph: { nodes: [], edges: [] },

  loadOntology: async (url: string) => {
    try {
      // In a real implementation, this would parse RDF/OWL files
      // For now, we'll simulate loading with some common ontology data
      
      const mockOntology: LoadedOntology = {
        url,
        name: getOntologyName(url),
        classes: getMockClasses(url),
        properties: getMockProperties(url),
        namespaces: getMockNamespaces(url)
      };

      set((state) => ({
        loadedOntologies: [...state.loadedOntologies, mockOntology],
        availableClasses: [...state.availableClasses, ...mockOntology.classes],
        availableProperties: [...state.availableProperties, ...mockOntology.properties]
      }));
    } catch (error) {
      console.error('Failed to load ontology:', error);
      throw error;
    }
  },

  validateGraph: (nodes: any[], edges: any[]) => {
    const errors: ValidationError[] = [];
    const { availableClasses, availableProperties } = get();

    // Validate nodes
    nodes.forEach(node => {
      const nodeClass = availableClasses.find(cls => 
        cls.label === node.data.classType && cls.namespace === node.data.namespace
      );
      
      if (!nodeClass) {
        errors.push({
          nodeId: node.id,
          message: `Class ${node.data.namespace}:${node.data.classType} not found in loaded ontologies`,
          severity: 'error'
        });
      }
    });

    // Validate edges
    edges.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);
      
      if (sourceNode && targetNode && edge.data) {
        const property = availableProperties.find(prop => 
          prop.uri === edge.data.propertyType
        );
        
        if (property) {
          const sourceClassUri = `${sourceNode.data.namespace}:${sourceNode.data.classType}`;
          const targetClassUri = `${targetNode.data.namespace}:${targetNode.data.classType}`;
          
          if (property.domain.length > 0 && !property.domain.includes(sourceClassUri)) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} domain restriction violated`,
              severity: 'error'
            });
          }
          
          if (property.range.length > 0 && !property.range.includes(targetClassUri)) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} range restriction violated`,
              severity: 'error'
            });
          }
        }
      }
    });

    set({ validationErrors: errors });
    return errors;
  },

  getCompatibleProperties: (sourceClass: string, targetClass: string) => {
    const { availableProperties } = get();
    
    return availableProperties.filter(prop => {
      const domainMatch = prop.domain.length === 0 || prop.domain.includes(sourceClass);
      const rangeMatch = prop.range.length === 0 || prop.range.includes(targetClass);
      return domainMatch && rangeMatch;
    });
  },

  loadOntologyFromRDF: async (rdfContent: string, onProgress?: (progress: number, message: string) => void) => {
    try {
      const { parseRDFFile } = await import('../utils/rdfParser');
      onProgress?.(10, 'Starting RDF parsing...');
      
      const parsedGraph = await parseRDFFile(rdfContent, onProgress);
      
      // Extract ontology information from parsed graph
      const ontologyClasses: OntologyClass[] = [];
      const ontologyProperties: ObjectProperty[] = [];
      
      // Group nodes by class type to create class definitions
      const classGroups = new Map<string, any[]>();
      parsedGraph.nodes.forEach(node => {
        const classKey = `${node.namespace}:${node.classType}`;
        if (!classGroups.has(classKey)) {
          classGroups.set(classKey, []);
        }
        classGroups.get(classKey)!.push(node);
      });
      
      // Create class definitions
      classGroups.forEach((nodes, classKey) => {
        const firstNode = nodes[0];
        const properties = Array.from(new Set(
          nodes.flatMap(node => node.literalProperties.map(prop => prop.key))
        ));
        
        ontologyClasses.push({
          uri: classKey,
          label: firstNode.classType,
          namespace: firstNode.namespace,
          properties,
          restrictions: {}
        });
      });
      
      // Extract properties from edges
      const propertyGroups = new Map<string, any[]>();
      parsedGraph.edges.forEach(edge => {
        if (!propertyGroups.has(edge.propertyType)) {
          propertyGroups.set(edge.propertyType, []);
        }
        propertyGroups.get(edge.propertyType)!.push(edge);
      });
      
      propertyGroups.forEach((edges, propertyType) => {
        const domains = Array.from(new Set(edges.map(edge => {
          const sourceNode = parsedGraph.nodes.find(n => n.id === edge.source);
          return sourceNode ? `${sourceNode.namespace}:${sourceNode.classType}` : '';
        }).filter(Boolean)));
        
        const ranges = Array.from(new Set(edges.map(edge => {
          const targetNode = parsedGraph.nodes.find(n => n.id === edge.target);
          return targetNode ? `${targetNode.namespace}:${targetNode.classType}` : '';
        }).filter(Boolean)));
        
        const firstEdge = edges[0];
        ontologyProperties.push({
          uri: propertyType,
          label: firstEdge.label,
          domain: domains,
          range: ranges,
          namespace: firstEdge.namespace
        });
      });
      
      const loadedOntology: LoadedOntology = {
        url: 'parsed-rdf',
        name: 'Parsed RDF Graph',
        classes: ontologyClasses,
        properties: ontologyProperties,
        namespaces: parsedGraph.namespaces
      };
      
      set((state) => ({
        loadedOntologies: [...state.loadedOntologies, loadedOntology],
        availableClasses: [...state.availableClasses, ...ontologyClasses],
        availableProperties: [...state.availableProperties, ...ontologyProperties],
        currentGraph: { nodes: parsedGraph.nodes, edges: parsedGraph.edges }
      }));
      
    } catch (error) {
      console.error('Failed to load ontology from RDF:', error);
      throw error;
    }
  },

  loadKnowledgeGraph: async (source: string, options?: { onProgress?: (progress: number, message: string) => void }) => {
    try {
      let rdfContent: string;
      
      if (source.startsWith('http://') || source.startsWith('https://')) {
        options?.onProgress?.(10, 'Fetching RDF from URL...');
        const response = await fetch(source);
        if (!response.ok) {
          throw new Error(`Failed to fetch RDF: ${response.statusText}`);
        }
        rdfContent = await response.text();
        options?.onProgress?.(20, 'RDF content downloaded');
      } else {
        rdfContent = source;
      }
      
      await get().loadOntologyFromRDF(rdfContent, options?.onProgress);
      
    } catch (error) {
      console.error('Failed to load knowledge graph:', error);
      throw error;
    }
  },

  setCurrentGraph: (nodes: any[], edges: any[]) => {
    set({ currentGraph: { nodes, edges } });
  },

  clearOntologies: () => {
    set({
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
      validationErrors: [],
      currentGraph: { nodes: [], edges: [] }
    });
  }
}));

// Helper functions for mock data
function getOntologyName(url: string): string {
  const names: Record<string, string> = {
    'http://xmlns.com/foaf/0.1/': 'FOAF',
    'https://www.w3.org/TR/vocab-org/': 'Organization',
    'http://purl.org/dc/elements/1.1/': 'Dublin Core',
    'http://www.w3.org/2004/02/skos/core#': 'SKOS'
  };
  return names[url] || 'Custom Ontology';
}

function getMockClasses(url: string): OntologyClass[] {
  const classesByOntology: Record<string, OntologyClass[]> = {
    'http://xmlns.com/foaf/0.1/': [
      {
        uri: 'foaf:Person',
        label: 'Person',
        namespace: 'foaf',
        properties: ['foaf:name', 'foaf:age', 'foaf:email'],
        restrictions: {}
      },
      {
        uri: 'foaf:Organization',
        label: 'Organization',
        namespace: 'foaf',
        properties: ['foaf:name'],
        restrictions: {}
      }
    ],
    'https://www.w3.org/TR/vocab-org/': [
      {
        uri: 'org:Organization',
        label: 'Organization',
        namespace: 'org',
        properties: ['org:name', 'org:sector'],
        restrictions: {}
      }
    ]
  };
  
  return classesByOntology[url] || [];
}

function getMockProperties(url: string): ObjectProperty[] {
  const propertiesByOntology: Record<string, ObjectProperty[]> = {
    'http://xmlns.com/foaf/0.1/': [
      {
        uri: 'foaf:memberOf',
        label: 'member of',
        domain: ['foaf:Person'],
        range: ['foaf:Organization', 'org:Organization'],
        namespace: 'foaf'
      },
      {
        uri: 'foaf:knows',
        label: 'knows',
        domain: ['foaf:Person'],
        range: ['foaf:Person'],
        namespace: 'foaf'
      }
    ]
  };
  
  return propertiesByOntology[url] || [];
}

function getMockNamespaces(url: string): Record<string, string> {
  const namespacesByOntology: Record<string, Record<string, string>> = {
    'http://xmlns.com/foaf/0.1/': {
      foaf: 'http://xmlns.com/foaf/0.1/'
    },
    'https://www.w3.org/TR/vocab-org/': {
      org: 'https://www.w3.org/TR/vocab-org/'
    }
  };
  
  return namespacesByOntology[url] || {};
}