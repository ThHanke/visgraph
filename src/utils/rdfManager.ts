/**
 * @fileoverview RDF Manager
 * Manages RDF store operations, including updates, exports, and proper namespace handling.
 * Uses N3.js store for proper RDF data management.
 */

import { Store, Parser, Writer, Quad, NamedNode, Literal, BlankNode, DataFactory } from 'n3';
const { namedNode, literal, quad } = DataFactory;

/**
 * Manages RDF data with proper store operations
 */
export class RDFManager {
  private store: Store;
  private namespaces: Record<string, string> = {};
  private parser: Parser;
  private writer: Writer;

  constructor() {
    this.store = new Store();
    this.parser = new Parser();
    this.writer = new Writer();
  }

  /**
   * Load RDF content into the store
   */
  async loadRDF(rdfContent: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.parser.parse(rdfContent, (error, quad, prefixes) => {
        if (error) {
          reject(error);
          return;
        }
        
        if (quad) {
          this.store.addQuad(quad);
        } else {
          // Parsing complete
          if (prefixes) {
            this.namespaces = { ...this.namespaces, ...prefixes };
          }
          resolve();
        }
      });
    });
  }

  /**
   * Update an entity's properties in the RDF store
   */
  updateEntity(entityUri: string, updates: { 
    type?: string; 
    annotationProperties?: { propertyUri: string; value: string; type?: string }[] 
  }): void {
    // Remove existing type triples for this entity
    if (updates.type) {
      const existingTypeQuads = this.store.getQuads(entityUri, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', null, null);
      existingTypeQuads.forEach(quad => this.store.removeQuad(quad));
      
      // Add new type
      this.store.addQuad(quad(
        namedNode(entityUri),
        namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        namedNode(this.expandPrefix(updates.type))
      ));
    }

    // Update annotation properties
    if (updates.annotationProperties) {
      updates.annotationProperties.forEach(prop => {
        // Remove existing property values
        const propertyUri = this.expandPrefix(prop.propertyUri);
        const existingQuads = this.store.getQuads(entityUri, propertyUri, null, null);
        existingQuads.forEach(quad => this.store.removeQuad(quad));
        
        // Add new property value
        const literalValue = prop.type ? 
          literal(prop.value, namedNode(prop.type)) : 
          literal(prop.value);
          
        this.store.addQuad(quad(
          namedNode(entityUri),
          namedNode(propertyUri),
          literalValue
        ));
      });
    }
  }

  /**
   * Export the current store to Turtle format
   */
  exportToTurtle(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({ 
        prefixes: this.namespaces,
        format: 'text/turtle'
      });
      
      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);
      
      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Export the current store to JSON-LD format
   */
  exportToJsonLD(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({ 
        prefixes: this.namespaces,
        format: 'application/ld+json'
      });
      
      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);
      
      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Export the current store to RDF/XML format
   */
  exportToRdfXml(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({ 
        prefixes: this.namespaces,
        format: 'application/rdf+xml'
      });
      
      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);
      
      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Get all namespaces/prefixes
   */
  getNamespaces(): Record<string, string> {
    return this.namespaces;
  }

  /**
   * Add a new namespace
   */
  addNamespace(prefix: string, uri: string): void {
    this.namespaces[prefix] = uri;
  }

  /**
   * Expand a prefixed URI to full URI
   */
  expandPrefix(prefixedUri: string): string {
    const colonIndex = prefixedUri.indexOf(':');
    if (colonIndex === -1) return prefixedUri;
    
    const prefix = prefixedUri.substring(0, colonIndex);
    const localName = prefixedUri.substring(colonIndex + 1);
    const namespaceUri = this.namespaces[prefix];
    
    return namespaceUri ? `${namespaceUri}${localName}` : prefixedUri;
  }

  /**
   * Get the store instance for direct access
   */
  getStore(): Store {
    return this.store;
  }

  /**
   * Clear the store
   */
  clear(): void {
    this.store = new Store();
    this.namespaces = {};
  }
}