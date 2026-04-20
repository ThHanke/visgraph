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
  {
    prefix: "rdf",
    url: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    name: "RDF - The RDF Concepts Vocabulary",
    isCore: true,
  },
  {
    prefix: "rdfs",
    url: "http://www.w3.org/2000/01/rdf-schema#",
    name: "RDFS - The RDF Schema Vocabulary",
    isCore: true,
  },
  { prefix: "owl", url: "http://www.w3.org/2002/07/owl#", name: "OWL", isCore: true },
  { prefix: "xsd", url: "http://www.w3.org/2001/XMLSchema#", name: "XSD", isCore: true },
  { prefix: "skos", url: "http://www.w3.org/2004/02/skos/core#", name: "SKOS" },
  {
    prefix: "prov",
    url: "http://www.w3.org/ns/prov#",
    name: "PROV-O - The PROV Ontology",
    ontologyUrl: "http://www.w3.org/ns/prov-o#",
  },
  {
    prefix: "p-plan",
    url: "http://purl.org/net/p-plan#",
    name: "P-Plan - The P-Plan Ontology",
    ontologyUrl: "http://purl.org/net/p-plan",
  },
  {
    prefix: "bfo",
    url: "http://purl.obolibrary.org/obo/BFO_",
    name: "BFO 2 - Basic Formal Ontology 2.0",
    ontologyUrl: "http://purl.obolibrary.org/obo/bfo/2.0/bfo.owl",
  },
  {
    prefix: "bfo2020",
    url: "https://basic-formal-ontology.org/2020/formulas/owl/",
    name: "BFO 2020 - Basic Formal Ontology 2020",
    ontologyUrl: "https://raw.githubusercontent.com/BFO-ontology/BFO-2020/master/src/owl/bfo-2020.owl",
  },
  {
    prefix: "dcat",
    url: "http://www.w3.org/ns/dcat#",
    name: "DCAT - Data Catalog Vocabulary",
    ontologyUrl: "http://www.w3.org/ns/dcat2",
  },
  {
    prefix: "qudt",
    url: "http://qudt.org/schema/qudt/",
    name: "QUDT - Quantities, Units, Dimensions and Types",
  },
  {
    prefix: "unit",
    url: "http://qudt.org/vocab/unit/",
    name: "QUDT Units Vocabulary",
  },
  {
    prefix: "dcterms",
    url: "http://purl.org/dc/terms/",
    name: "Dublin Core Terms",
  },
  {
    prefix: "dc",
    url: "http://purl.org/dc/elements/1.1/",
    name: "Dublin Core",
  },
  { prefix: "foaf", url: "http://xmlns.com/foaf/0.1/", name: "FOAF" },
  {
    prefix: "org",
    url: "http://www.w3.org/ns/org#",
    name: "Organization",
  },
  {
    prefix: "pmdco",
    url: "https://w3id.org/pmd/co/",
    name: "PMD Core",
  },
  {
    prefix: "tto",
    url: "https://w3id.org/pmd/ao/tto/",
    name: "PMD Tensile Test",
  },
  {
    prefix: "iof-core",
    url: "https://spec.industrialontologies.org/ontology/core/Core/",
    name: "IOF Core",
  },
  {
    prefix: "iof-mat",
    url: "https://spec.industrialontologies.org/ontology/materials/Materials/",
    name: "IOF Materials",
  },
  {
    prefix: "iof-qual",
    url: "https://spec.industrialontologies.org/ontology/qualities/",
    name: "IOF Qualities",
  },
] as const;

export const WELL_KNOWN_BY_PREFIX: Record<
  string,
  { prefix: string; url: string; name: string; ontologyUrl?: string }
> = Object.fromEntries(WELL_KNOWN_PREFIXES.map((p) => [p.prefix, p])) as any;

/**
 * Resolve a well-known prefix name or arbitrary URI to the URL that should be
 * fetched when loading the ontology.  For entries with an explicit `ontologyUrl`
 * (e.g. BFO, DCAT) that URL is returned; otherwise the namespace `url` is used.
 * Unrecognised strings are returned as-is so callers can pass raw URIs directly.
 */
export function resolveOntologyLoadUrl(prefixOrUri: string): string {
  const entry = WELL_KNOWN_BY_PREFIX[prefixOrUri];
  if (entry) {
    return (entry as any).ontologyUrl ?? entry.url;
  }
  return prefixOrUri;
}

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
  prefixes: Object.fromEntries(
    WELL_KNOWN_PREFIXES.map((p) => [p.prefix, p.url]),
  ) as Record<string, string>,
  // ontologies: map known ontology URL -> metadata (name + namespaces)
  ontologies: (() => {
    const out: Record<
      string,
      { name: string; namespaces?: Record<string, string>; aliases?: string[] }
    > = {};
    for (const p of WELL_KNOWN_PREFIXES) {
      // If the prefix's url looks like an ontology URL (ends with / or #) we add an entry.
      // Use the namespace URI itself as the ontology key.
      if (!out[p.url]) {
        out[p.url] = { name: p.name, namespaces: {}, aliases: [p.url] };
      }
      out[p.url].namespaces = {
        ...(out[p.url].namespaces || {}),
        [p.prefix]: p.url,
      };
    }
    return out;
  })(),
} as const;
