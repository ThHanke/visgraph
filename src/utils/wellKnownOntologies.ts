/**
 * Centralized well-known ontology and prefix mappings.
 *
 * New canonical structure:
 *  - WELL_KNOWN_PREFIXES: Array of { prefix, url, name }
 *  - WELL_KNOWN_BY_PREFIX: Record<prefix, record>
 *  - WELL_KNOWN_BY_URL: Map<url, prefixes[]>
 *
 * For backwards compatibility we also export a derived WELL_KNOWN object
 * with `prefixes` and `ontologies` keys to minimize churn in the codebase.
 *
 * When adding entries prefer the simple WELL_KNOWN_PREFIXES array.
 */

export const WELL_KNOWN_PREFIXES = [
  { prefix: 'rdf', url: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', name: 'RDF - The RDF Concepts Vocabulary' },
  { prefix: 'rdfs', url: 'http://www.w3.org/2000/01/rdf-schema#', name: 'RDFS - The RDF Schema Vocabulary' },
  { prefix: 'owl', url: 'http://www.w3.org/2002/07/owl#', name: 'OWL' },
  { prefix: 'xsd', url: 'http://www.w3.org/2001/XMLSchema#', name: 'XSD' },
  { prefix: 'skos', url: 'http://www.w3.org/2004/02/skos/core#', name: 'SKOS' },
  { prefix: 'dcterms', url: 'http://purl.org/dc/terms/', name: 'Dublin Core Terms' },
  { prefix: 'dc', url: 'http://purl.org/dc/elements/1.1/', name: 'Dublin Core' },
  { prefix: 'foaf', url: 'http://xmlns.com/foaf/0.1/', name: 'FOAF' },
  { prefix: 'org', url: 'https://www.w3.org/TR/vocab-org/', name: 'Organization' },
  { prefix: 'iof-core', url: 'https://spec.industrialontologies.org/ontology/core/Core/', name: 'IOF Core' },
  { prefix: 'iof-mat', url: 'https://spec.industrialontologies.org/ontology/materials/Materials/', name: 'IOF Materials' },
  { prefix: 'iof-qual', url: 'https://spec.industrialontologies.org/ontology/qualities/', name: 'IOF Qualities' }
] as const;

export const WELL_KNOWN_BY_PREFIX: Record<string, { prefix: string; url: string; name: string }> =
  Object.fromEntries(WELL_KNOWN_PREFIXES.map(p => [p.prefix, p])) as any;

// Map from namespace URL -> array of prefixes that point to it
export const WELL_KNOWN_BY_URL: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const p of WELL_KNOWN_PREFIXES) {
    const arr = m.get(p.url) || [];
    arr.push(p.prefix);
    m.set(p.url, arr);
  }
  return m;
})();

// Backwards-compatible derived object
export const WELL_KNOWN = {
  prefixes: Object.fromEntries(WELL_KNOWN_PREFIXES.map(p => [p.prefix, p.url])) as Record<string, string>,
  // ontologies: map known ontology URL -> metadata (name + namespaces)
  ontologies: (() => {
    const out: Record<string, { name: string; namespaces?: Record<string, string>; aliases?: string[] }> = {};
    for (const p of WELL_KNOWN_PREFIXES) {
      // If the prefix's url looks like an ontology URL (ends with / or #) we add an entry.
      // Use the namespace URI itself as the ontology key.
      if (!out[p.url]) {
        out[p.url] = { name: p.name, namespaces: {}, aliases: [p.url] };
      }
      out[p.url].namespaces = { ...(out[p.url].namespaces || {}), [p.prefix]: p.url };
    }
    return out;
  })()
} as const;
