// Shared IRI prefix expansion for MCP tools.
// Reads the namespace registry from ontologyStore at call time so it stays
// in sync with namespaces added via addNamespace / the UI.
// Built-in fallbacks match the KP map in public/relay-bookmarklet.js.

const BUILTIN_PREFIXES: Record<string, string> = {
  'rdf:':     'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'rdfs:':    'http://www.w3.org/2000/01/rdf-schema#',
  'owl:':     'http://www.w3.org/2002/07/owl#',
  'xsd:':     'http://www.w3.org/2001/XMLSchema#',
  'foaf:':    'http://xmlns.com/foaf/0.1/',
  'skos:':    'http://www.w3.org/2004/02/skos/core#',
  'dc:':      'http://purl.org/dc/elements/1.1/',
  'dcterms:': 'http://purl.org/dc/terms/',
  'schema:':  'https://schema.org/',
  'ex:':      'http://example.org/',
};

function getPrefixMap(): Record<string, string> {
  try {
    // Lazy import to avoid circular deps — ontologyStore is a Zustand store.
    const { useOntologyStore } = require('@/stores/ontologyStore');
    const entries: Array<{ prefix: string; uri: string }> = useOntologyStore.getState().namespaceRegistry;
    const map: Record<string, string> = { ...BUILTIN_PREFIXES };
    for (const e of entries) {
      if (e.prefix && e.uri) {
        const key = e.prefix.endsWith(':') ? e.prefix : e.prefix + ':';
        map[key] = e.uri;
      }
    }
    return map;
  } catch {
    return { ...BUILTIN_PREFIXES };
  }
}

/**
 * Expand a prefixed IRI (e.g. "rdf:type") to its full form.
 * Returns the original value if already full or not prefixed.
 * Returns an error string starting with "Unknown prefix:" for unrecognised prefixes.
 */
// URI schemes that are pass-through — never treated as RDF prefixes.
const URI_SCHEMES = ['http:', 'https:', 'urn:', 'mailto:', 'ftp:', 'file:', 'urn:'];

/**
 * Expand a prefixed IRI (e.g. "rdf:type") to its full form.
 * Values that start with a URI scheme (http:, https:, mailto:, urn: …) are
 * returned as-is — including truncated/fragmented ones — so the caller gets
 * the original string and can validate further if needed.
 * Returns an error string starting with "Unknown prefix:" for unrecognised
 * short prefixes (e.g. "ex2:Foo" when ex2 is not registered).
 */
export function expandIri(value: string): string {
  if (!value) return value;
  // Pass through any value whose scheme is a known URI scheme (not an RDF prefix).
  for (const scheme of URI_SCHEMES) {
    if (value.startsWith(scheme)) return value;
  }
  const map = getPrefixMap();
  for (const prefix of Object.keys(map)) {
    if (value.startsWith(prefix)) {
      return map[prefix] + value.slice(prefix.length);
    }
  }
  const colonIdx = value.indexOf(':');
  if (colonIdx > 0 && !value.includes(' ')) {
    const known = Object.keys(map).join(' ');
    return `Unknown prefix: ${value.slice(0, colonIdx + 1)} in "${value}". Known: ${known}`;
  }
  return value;
}
