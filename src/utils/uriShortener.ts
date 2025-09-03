// Utility for shortening URIs using prefixes
export class URIShortener {
  private prefixes: Record<string, string> = {
    ':': 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/',
    'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
    'owl': 'http://www.w3.org/2002/07/owl#',
    'xsd': 'http://www.w3.org/2001/XMLSchema#',
    'foaf': 'http://xmlns.com/foaf/0.1/',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'skos': 'http://www.w3.org/2004/02/skos/core#',
  };

  constructor(customPrefixes?: Record<string, string>) {
    if (customPrefixes) {
      this.prefixes = { ...this.prefixes, ...customPrefixes };
    }
  }

  shortenURI(uri: string): string {
    for (const [prefix, namespace] of Object.entries(this.prefixes)) {
      if (uri.startsWith(namespace)) {
        const localName = uri.substring(namespace.length);
        return prefix === ':' ? `:${localName}` : `${prefix}:${localName}`;
      }
    }
    return uri;
  }

  expandURI(shortUri: string): string {
    const colonIndex = shortUri.indexOf(':');
    if (colonIndex === -1) return shortUri;
    
    const prefix = shortUri.substring(0, colonIndex);
    const localName = shortUri.substring(colonIndex + 1);
    
    if (this.prefixes[prefix]) {
      return this.prefixes[prefix] + localName;
    }
    
    return shortUri;
  }

  setPrefixes(prefixes: Record<string, string>) {
    this.prefixes = { ...this.prefixes, ...prefixes };
  }

  getPrefixes(): Record<string, string> {
    return { ...this.prefixes };
  }
}

export const defaultURIShortener = new URIShortener();