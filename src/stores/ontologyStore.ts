import { create } from 'zustand';

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

interface OntologyStore {
  loadedOntologies: LoadedOntology[];
  availableClasses: OntologyClass[];
  availableProperties: ObjectProperty[];
  validationErrors: ValidationError[];
  loadOntology: (url: string) => Promise<void>;
  validateGraph: (nodes: any[], edges: any[]) => ValidationError[];
  getCompatibleProperties: (sourceClass: string, targetClass: string) => ObjectProperty[];
  clearOntologies: () => void;
}

export const useOntologyStore = create<OntologyStore>((set, get) => ({
  loadedOntologies: [],
  availableClasses: [],
  availableProperties: [],
  validationErrors: [],

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

  clearOntologies: () => {
    set({
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
      validationErrors: []
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