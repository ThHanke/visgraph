import { Parser, Store, Quad, NamedNode, Literal, BlankNode, DataFactory } from 'n3';
import { fallback } from './startupDebug';

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  namespaces: Record<string, string>;
  prefixes: Record<string, string>;
}

export interface GraphNode {
  id: string;
  iri: string;
  classType: string;
  individualName: string;
  namespace: string;
  rdfType: string;
  rdfTypes: string[];
  entityType: 'individual' | 'class' | 'property';
  literalProperties: { key: string; value: string; type?: string }[];
  annotationProperties: { propertyUri: string; value: string }[];
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  propertyType: string;
  propertyUri: string;
  label: string;
  namespace: string;
  rdfType: string;
  data?: Record<string, unknown>;
}

const { namedNode, literal, quad } = DataFactory;

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

    // Detect obvious RDF/XML (XML prolog or root RDF element)
    const looksLikeXml = /^\s*<\?xml/i.test(rdfContent) || /<rdf:RDF\b/i.test(rdfContent);

    if (looksLikeXml) {
      // Use an XML-based lightweight parser to extract triples into the store,
      // then reuse extractGraph() to build the ParsedGraph structure.
      try {
        onProgress?.(30, 'Detected RDF/XML, using XML parser...');
        return this.parseRdfXml(rdfContent, onProgress);
      } catch (xmlErr) {
        // Fall back to trying the N3 parser so errors surface similarly to before.
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('RDF/XML parse failed, falling back to N3 parser:', xmlErr);
      }
    }

    // Existing N3/Turtle/JSON-LD parsing path
    // Extract base URI from @prefix : definition
    const basePrefixMatch = rdfContent.match(/@prefix\s*:\s*<([^>]+)>\s*\./);
    if (basePrefixMatch) {
      this.prefixes[':'] = basePrefixMatch[1];
      this.namespaces[':'] = basePrefixMatch[1];
    } else {
      // Default base URI
      this.prefixes[':'] = 'https://example.org/';
      this.namespaces[':'] = 'https://example.org/';
    }

    return new Promise((resolve, reject) => {
      const quads: Quad[] = [];

      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          reject(error);
          return;
        }

        if (quadItem) {
          quads.push(quadItem);
          this.store.addQuad(quadItem);
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

  /**
   * Lightweight RDF/XML parsing to populate the internal N3 store.
   *
   * This is not a full-featured RDF/XML parser but handles the common cases found
   * in ontology files:
   *  - rdf:Description / typed elements with rdf:about / rdf:ID / rdf:nodeID
   *  - child elements with rdf:resource -> named object
   *  - child elements with text content -> literal object (datatype via rdf:datatype attr)
   *  - rdf:type with rdf:resource handled as type triples
   */
  private parseRdfXml(rdfXml: string, onProgress?: (progress: number, message: string) => void): Promise<ParsedGraph> {
    onProgress?.(35, 'Parsing RDF/XML content...');
    // Use DOMParser available in browsers. In environments without DOMParser this will throw.
    const parser = new DOMParser();
    const doc = parser.parseFromString(rdfXml, 'application/xml');

    // Check for parse errors
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('Failed to parse RDF/XML: invalid XML document');
    }

    // Collect namespace prefixes from the root element
    const root = doc.documentElement;
    const nsMap: Record<string, string> = {};
    for (let i = 0; i < root.attributes.length; i++) {
      const attr = root.attributes[i];
      if (attr.name === 'xmlns') {
        nsMap[''] = attr.value;
      } else if (attr.name.startsWith('xmlns:')) {
        const prefix = attr.name.substring('xmlns:'.length);
        nsMap[prefix] = attr.value;
      }
    }

    // store prefixes/namespaces for later shortening
    this.prefixes = { ...this.prefixes, ...nsMap };
    Object.entries(nsMap).forEach(([p, uri]) => {
      // Use prefix or generate fallback
      const prefix = p === '' ? ':' : p;
      this.namespaces[prefix] = uri;
    });

    const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

    // Helper to build a predicate URI from element namespace/localName
    const predicateUriFromElement = (el: Element) => {
      const ns = el.namespaceURI || '';
      const local = el.localName || el.nodeName;
      // Many RDF/XML namespaces end with / or # so concatenation is fine
      return `${ns}${local}`;
    };

    // Iterate through all elements and extract triples where possible.
    const allElements = Array.from(doc.getElementsByTagName('*'));

    // Helper to get rdf:about / rdf:ID / rdf:nodeID values
    const getSubjectFromElement = (el: Element): string | null => {
      // rdf:about
      const about = el.getAttributeNS(RDF_NS, 'about') || el.getAttribute('about');
      if (about) return about;

      const id = el.getAttributeNS(RDF_NS, 'ID') || el.getAttribute('ID') || el.getAttribute('rdf:ID');
      if (id) {
        // rdf:ID is relative to base; produce a fragment identifier
        // Best-effort: use document base or root xmlns as base
        const base = this.prefixes[':'] || this.namespaces[':'] || (doc.baseURI || '');
        // If ID starts with '#' strip it
        const cleaned = id.startsWith('#') ? id.substring(1) : id;
        return base ? `${base}#${cleaned}` : `#${cleaned}`;
      }

      const nodeID = el.getAttributeNS(RDF_NS, 'nodeID') || el.getAttribute('nodeID');
      if (nodeID) {
        return `_:${nodeID}`;
      }

      return null;
    };

    // We'll collect triples into the N3 store
    const triples: Quad[] = [];

    // First pass: elements that represent subjects (have rdf:about/ID/nodeID or are rdf:Description)
    for (const el of allElements) {
      const subjectUri = getSubjectFromElement(el);
      if (!subjectUri) {
        // Some nested property elements may not declare subject; skip
        continue;
      }

      // For each child element, derive predicate and object
      for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        const predUri = predicateUriFromElement(child);

        // Skip if predicate is rdf:type handled below specially, but we'll handle generically too
        // If child has rdf:resource attribute -> object is a NamedNode
        const resource = child.getAttributeNS(RDF_NS, 'resource') || child.getAttribute('resource');
        if (resource) {
          triples.push(quad(
            namedNode(subjectUri),
            namedNode(predUri),
            namedNode(resource)
          ));
          continue;
        }

        // If child has rdf:nodeID -> blank node object
        const childNodeId = child.getAttributeNS(RDF_NS, 'nodeID') || child.getAttribute('nodeID');
        if (childNodeId) {
          triples.push(quad(
            namedNode(subjectUri),
            namedNode(predUri),
            DataFactory.blankNode(childNodeId)
          ));
          continue;
        }

        // If child has rdf:datatype attribute -> typed literal
        const dtype = child.getAttributeNS(RDF_NS, 'datatype') || child.getAttribute('datatype');
        const text = (child.textContent || '').trim();
        if (text.length === 0) continue;

        if (dtype) {
          triples.push(quad(
            namedNode(subjectUri),
            namedNode(predUri),
            literal(text, namedNode(dtype))
          ));
        } else {
          // Un-typed literal
          triples.push(quad(
            namedNode(subjectUri),
            namedNode(predUri),
            literal(text)
          ));
        }
      }

      // Also check for rdf:type expressed as an attribute or child element
      // rdf:type as child element with rdf:resource handled above.
      // Some files may express type via element name (e.g., <owl:Class rdf:about="...">).
      // If the element's own tag is a typed element (namespace different from rdf and not rdf:Description),
      // interpret that as rdf:type triple.
      const elNs = el.namespaceURI || '';
      const elLocal = el.localName || el.nodeName;
      const isDescription = (elNs === RDF_NS && (elLocal === 'Description' || elLocal === 'RDF'));
      if (!isDescription) {
        // Treat the element name as a type
        const typeUri = `${elNs}${elLocal}`;
        triples.push(quad(
          namedNode(subjectUri),
          namedNode(`${RDF_NS}type`),
          namedNode(typeUri)
        ));
      }
    }

    // Second pass: also detect top-level typed properties declared as separate nodes (e.g., property nodes)
    // and simple property resources defined with rdf:Description root children.
    // (Already covered in first pass for most cases.)

    // Add triples into internal store
    triples.forEach(t => {
      try {
        this.store.addQuad(t);
      } catch (e) {
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to add triple from RDF/XML parse:', e);
      }
    });

    onProgress?.(60, 'RDF/XML parsed; extracting graph...');

    // Reuse extractGraph to turn the store into ParsedGraph
    const result = this.extractGraph(onProgress);
    return Promise.resolve(result);
  }

  private extractGraph(onProgress?: (progress: number, message: string) => void): ParsedGraph {
    onProgress?.(60, 'Identifying individuals and classes...');

    const entities = new Map<string, GraphNode>();
    const objectProperties = new Map<string, GraphEdge>();

    // Add base namespace (ensure ':' maps to a real base URI, not literal ':' placeholder)
    const defaultBase = this.prefixes[':'] || this.namespaces[':'] || 'http://example.org/';
    this.namespaces[':'] = this.namespaces[':'] || defaultBase;
    this.prefixes[':'] = this.prefixes[':'] || defaultBase;

    // Find all entities and their types
    const typeQuads = this.store.getQuads(null, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', null, null);

    onProgress?.(70, 'Processing entities...');

    typeQuads.forEach((tq) => {
      const quadItem = tq;
      if (quadItem.subject.termType === 'NamedNode' || quadItem.subject.termType === 'BlankNode') {
        const subjectUri = quadItem.subject.value;
        const typeUri = (quadItem.object as NamedNode).value;

        const { namespace: typeNamespace, localName: typeName } = this.splitUri(typeUri);
        const { namespace: subjectNamespace, localName: subjectName } = this.splitUri(subjectUri);

        // Determine entity type based on rdf:type
        let entityType: 'individual' | 'class' | 'property' = 'individual';
        if (typeNamespace === 'owl') {
          if (typeName === 'Class') entityType = 'class';
          else if (typeName === 'ObjectProperty' || typeName === 'DatatypeProperty' || typeName === 'AnnotationProperty') entityType = 'property';
        }

        if (!entities.has(subjectUri)) {
          entities.set(subjectUri, {
            id: this.createSafeId(subjectUri),
            iri: subjectUri,
            // store classType as the local name and keep the namespace separate so consumers
            // can assert on `data.classType === 'Length'` and `data.namespace === 'iof-qual'`
            classType: typeName,
            individualName: subjectName,
            namespace: entityType === 'individual' ? typeNamespace : subjectNamespace,
            rdfType: `${typeNamespace}:${typeName}`,
            rdfTypes: [`${typeNamespace}:${typeName}`],
            entityType,
            literalProperties: [],
            annotationProperties: [],
            position: { x: Math.random() * 800 + 100, y: Math.random() * 600 + 100 },
            data: {}
          });
        } else {
          // Add additional rdf:type
          const entity = entities.get(subjectUri)!;
          const prefixed = `${typeNamespace}:${typeName}`;
          if (!entity.rdfTypes.includes(prefixed)) {
            entity.rdfTypes.push(prefixed);
            entity.rdfType = entity.rdfTypes.join(', ');
          }
        }
      }
    });

    onProgress?.(80, 'Processing properties...');

    // Find literal and annotation properties
    entities.forEach((node, subjectUri) => {
      const propertyQuads = this.store.getQuads(subjectUri, null, null, null)
        .filter(quadItem => quadItem.object.termType === 'Literal');

      propertyQuads.forEach(quadItem => {
        const propertyUri = (quadItem.predicate as NamedNode).value;
        const lit = quadItem.object as Literal;
        const { namespace: propNamespace, localName: propName } = this.splitUri(propertyUri);

        // Skip rdf:type as it's handled separately
        if (propertyUri !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
          // Determine if annotation property or literal property
          if (propNamespace === 'rdfs' && propName === 'label') {
            node.annotationProperties.push({
              propertyUri: `${propNamespace}:${propName}`,
              value: lit.value
            });
          } else if (propNamespace === 'rdfs' || propNamespace === 'dc' || propNamespace === 'dct') {
            node.annotationProperties.push({
              propertyUri: `${propNamespace}:${propName}`,
              value: lit.value
            });
          } else {
          const dtype = (lit.datatype && (lit.datatype as NamedNode).value) || undefined;
          const normalizedType = dtype === 'http://www.w3.org/2001/XMLSchema#string' ? undefined : dtype;

          node.literalProperties.push({
            key: `${propNamespace}:${propName}`,
            value: lit.value,
            type: normalizedType
          });
          }
        }
      });
    });

    onProgress?.(90, 'Processing object properties...');

    // Find object properties (relationships between entities)
    const objectQuads = this.store.getQuads(null, null, null, null)
      .filter(quadItem =>
        quadItem.object.termType === 'NamedNode' &&
        entities.has(quadItem.subject.value) &&
        entities.has((quadItem.object as NamedNode).value) &&
        quadItem.predicate.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      );

    objectQuads.forEach(quadItem => {
      const sourceId = this.createSafeId(quadItem.subject.value);
      const targetId = this.createSafeId((quadItem.object as NamedNode).value);
      const propertyUri = (quadItem.predicate as NamedNode).value;
      const { namespace, localName } = this.splitUri(propertyUri);

      const edgeId = `${sourceId}-${targetId}-${localName}`;

      // Find rdfs:label for this property
      const propertyLabelQuads = this.store.getQuads(propertyUri, 'http://www.w3.org/2000/01/rdf-schema#label', null, null);
      const label = propertyLabelQuads.length > 0 ?
        (propertyLabelQuads[0].object as Literal).value : localName;

      objectProperties.set(edgeId, {
        id: edgeId,
        source: sourceId,
        target: targetId,
        propertyType: `${namespace}:${localName}`,
        propertyUri: propertyUri,
        label: label,
        namespace: namespace,
        rdfType: `${namespace}:${localName}`,
        data: {}
      });
    });

    onProgress?.(100, 'Graph extraction complete');

    // Normalize nodes to canonical shape: add iri, type, type_namespace, annotations while preserving legacy fields
    const nodesArray = Array.from(entities.values()).map((n) => {
      // Ensure canonical IRI field
      (n as any).iri = (n as any).iri || (n as any).id || '';

      // Derive type and type_namespace from rdfTypes (preferred) or classType fallback.
      // Prefer the first rdfType that is not an owl:NamedIndividual marker so that
      // node templates display the meaningful class (e.g. iof-mat:Specimen) instead
      // of the generic NamedIndividual marker when multiple types are present.
      let typeStr = '';
      let typeNs = '';
      if ((n as any).rdfTypes && (n as any).rdfTypes.length > 0) {
        const typesArr: string[] = (n as any).rdfTypes.slice();
        // Find the first non-NamedIndividual entry if present
        const nonNamed = typesArr.find(t => typeof t === 'string' && t && !/NamedIndividual\b/i.test(String(t)));
        const chosen = (nonNamed && String(nonNamed)) || String(typesArr[0]);
        const idx = chosen.indexOf(':');
        if (idx > -1) {
          typeNs = chosen.substring(0, idx);
          typeStr = chosen.substring(idx + 1);
        } else {
          typeStr = chosen;
        }
      } else if ((n as any).classType) {
        const ct = (n as any).classType;
        const idx = ct.indexOf(':');
        if (idx > -1) {
          typeNs = ct.substring(0, idx);
          typeStr = ct.substring(idx + 1);
        } else {
          typeStr = ct;
        }
      }

      (n as any).type = (n as any).type || typeStr || '';
      (n as any).type_namespace = (n as any).type_namespace || typeNs || (n as any).namespace || '';

      // Map legacy annotationProperties -> canonical annotations: [{ "prefix:prop": "value" }, ...]
      (n as any).annotations = (n as any).annotations || ((n as any).annotationProperties || []).map((ap: any) => {
        const key = ap.propertyUri || ap.property || ap.key || 'unknown';
        return { [key]: ap.value };
      });

      return n;
    });

    return {
      nodes: nodesArray,
      edges: Array.from(objectProperties.values()),
      namespaces: this.namespaces,
      prefixes: this.prefixes
    };
  }

  private splitUri(uri: string): { namespace: string; localName: string } {
    // Try to match with existing prefixes first
    for (const [prefix, namespaceUri] of Object.entries(this.prefixes)) {
      if (!namespaceUri) continue;
      if (uri.startsWith(namespaceUri)) {
        return {
          namespace: prefix === ':' ? '' : prefix,
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
    try {
      const url = new URL(namespace);
      const path = url.pathname;
      const segments = path.split('/').filter(s => s.length > 0);

      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        return lastSegment.substring(0, 3).toLowerCase();
      }

      return url.hostname.split('.')[0] || 'ns';
    } catch {
      return 'ns';
    }
  }

  private createSafeId(uri: string): string {
    // Create a safe DOM ID from URI
    return uri.replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  shortenUri(uri: string): string {
    // Try to match with existing prefixes first
    for (const [prefix, namespaceUri] of Object.entries(this.prefixes)) {
      if (!namespaceUri) continue;
      if (uri.startsWith(namespaceUri)) {
        return `${prefix}${uri.substring(namespaceUri.length)}`;
      }
    }
    return uri;
  }
}

export const parseRDFFile = async (
  content: string,
  onProgress?: (progress: number, message: string) => void
): Promise<ParsedGraph> => {
  const parser = new RDFParser();
  return parser.parseRDF(content, onProgress);
};
