let _iriCounter = 1;

/**
 * Extract the local name from an IRI (the part after the last '#' or '/').
 * Falls back to 'entity' if nothing useful is found.
 */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const sep = Math.max(hash, slash);
  const name = sep >= 0 ? iri.slice(sep + 1) : iri;
  // Strip angle brackets or whitespace, ensure non-empty
  const clean = name.replace(/[<>\s]/g, '');
  return clean || 'entity';
}

/**
 * Generate a new IRI for a freshly created entity.
 *
 * Pattern: `{namespaceUri}{TypeLocalName}_{counter}`
 * Example: `http://example.com/Person_1`
 */
export function generateEntityIri(namespaceUri: string, typeIri: string): string {
  const local = localName(typeIri);
  return `${namespaceUri}${local}_${_iriCounter++}`;
}
