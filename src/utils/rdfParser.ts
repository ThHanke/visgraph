import { Parser, Store, Quad, NamedNode, Literal, BlankNode } from 'n3';

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  namespaces: Record<string, string>;
  prefixes: Record<string, string>;
}

export interface GraphNode {
  id: string;
  classType: string;
  individualName: string;
  namespace: string;
  literalProperties: { key: string; value: string; type?: string }[];
  position?: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  propertyType: string;
  label: string;
  namespace: string;
}

export class RDFParser {
  private store: Store;
  private parser: Parser;
  private namespaces: Record<string, string> = {};
  private prefixes: Record<string, string> = {};

  constructor() {
    this.store = new Store();
    this.parser = new Parser();
  }

  async parseRDF(rdfContent: string, onProgress?: (progress: number, message: string) => void): Promise<ParsedGraph> {
    onProgress?.(20, 'Parsing RDF syntax...');
    
    return new Promise((resolve, reject) => {
      const quads: Quad[] = [];
      
      this.parser.parse(rdfContent, (error, quad, prefixes) => {
        if (error) {
          reject(error);
          return;
        }
        
        if (quad) {
          quads.push(quad);
          this.store.addQuad(quad);
        } else {
          // Parsing complete
          if (prefixes) {
            this.prefixes = prefixes as Record<string, string>;
            // Convert prefixes to namespaces
            Object.entries(this.prefixes).forEach(([prefix, uri]) => {
              this.namespaces[prefix] = uri;
            });
          }
          
          onProgress?.(50, 'Extracting entities...');
          
          try {
            const result = this.extractGraph(onProgress);
            resolve(result);
          } catch (extractError) {
            reject(extractError);
          }
        }
      });
    });
  }

  private extractGraph(onProgress?: (progress: number, message: string) => void): ParsedGraph {
    onProgress?.(60, 'Identifying individuals and classes...');
    
    const individuals = new Map<string, GraphNode>();
    const objectProperties = new Map<string, GraphEdge>();
    
    // Find all individuals and their types
    const typeQuads = this.store.getQuads(null, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', null, null);
    
    onProgress?.(70, 'Processing class instances...');
    
    typeQuads.forEach((quad, index) => {
      if (quad.subject.termType === 'NamedNode' || quad.subject.termType === 'BlankNode') {
        const subjectUri = quad.subject.value;
        const classUri = (quad.object as NamedNode).value;
        
        const { namespace, localName } = this.splitUri(classUri);
        const individualName = this.splitUri(subjectUri).localName;
        
        if (!individuals.has(subjectUri)) {
          individuals.set(subjectUri, {
            id: this.createSafeId(subjectUri),
            classType: localName,
            individualName: individualName,
            namespace: namespace,
            literalProperties: [],
            position: { x: Math.random() * 800 + 100, y: Math.random() * 600 + 100 }
          });
        }
      }
    });

    onProgress?.(80, 'Processing literal properties...');
    
    // Find literal properties
    individuals.forEach((node, subjectUri) => {
      const literalQuads = this.store.getQuads(subjectUri, null, null, null)
        .filter(quad => quad.object.termType === 'Literal');
      
      literalQuads.forEach(quad => {
        const propertyUri = (quad.predicate as NamedNode).value;
        const literal = quad.object as Literal;
        const { namespace: propNamespace, localName: propName } = this.splitUri(propertyUri);
        
        // Skip rdf:type as it's handled separately
        if (propertyUri !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
          node.literalProperties.push({
            key: `${propNamespace}:${propName}`,
            value: literal.value,
            type: literal.datatype?.value
          });
        }
      });
    });

    onProgress?.(90, 'Processing object properties...');
    
    // Find object properties (relationships between individuals)
    const objectQuads = this.store.getQuads(null, null, null, null)
      .filter(quad => 
        quad.object.termType === 'NamedNode' && 
        individuals.has(quad.subject.value) && 
        individuals.has(quad.object.value) &&
        quad.predicate.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      );

    objectQuads.forEach(quad => {
      const sourceId = this.createSafeId(quad.subject.value);
      const targetId = this.createSafeId(quad.object.value);
      const propertyUri = (quad.predicate as NamedNode).value;
      const { namespace, localName } = this.splitUri(propertyUri);
      
      const edgeId = `${sourceId}-${targetId}-${localName}`;
      
      objectProperties.set(edgeId, {
        id: edgeId,
        source: sourceId,
        target: targetId,
        propertyType: `${namespace}:${localName}`,
        label: localName,
        namespace: namespace
      });
    });

    onProgress?.(100, 'Graph extraction complete');

    return {
      nodes: Array.from(individuals.values()),
      edges: Array.from(objectProperties.values()),
      namespaces: this.namespaces,
      prefixes: this.prefixes
    };
  }

  private splitUri(uri: string): { namespace: string; localName: string } {
    // Try to match with existing prefixes first
    for (const [prefix, namespaceUri] of Object.entries(this.prefixes)) {
      if (uri.startsWith(namespaceUri)) {
        return {
          namespace: prefix,
          localName: uri.substring(namespaceUri.length)
        };
      }
    }
    
    // Fallback to simple URI splitting
    const lastSlash = uri.lastIndexOf('/');
    const lastHash = uri.lastIndexOf('#');
    const splitIndex = Math.max(lastSlash, lastHash);
    
    if (splitIndex > 0) {
      const namespace = uri.substring(0, splitIndex + 1);
      const localName = uri.substring(splitIndex + 1);
      
      // Create a short prefix if not found
      const prefix = this.createShortPrefix(namespace);
      if (!this.prefixes[prefix]) {
        this.prefixes[prefix] = namespace;
        this.namespaces[prefix] = namespace;
      }
      
      return { namespace: prefix, localName };
    }
    
    return { namespace: 'default', localName: uri };
  }

  private createShortPrefix(namespace: string): string {
    // Extract meaningful part from namespace URI
    const url = new URL(namespace);
    const path = url.pathname;
    const segments = path.split('/').filter(s => s.length > 0);
    
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      return lastSegment.substring(0, 3).toLowerCase();
    }
    
    return url.hostname.split('.')[0] || 'ns';
  }

  private createSafeId(uri: string): string {
    // Create a safe DOM ID from URI
    return uri.replace(/[^a-zA-Z0-9-_]/g, '_');
  }
}

export const parseRDFFile = async (
  content: string, 
  onProgress?: (progress: number, message: string) => void
): Promise<ParsedGraph> => {
  const parser = new RDFParser();
  return parser.parseRDF(content, onProgress);
};