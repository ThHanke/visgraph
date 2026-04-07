export function prefixShorten(iri: string, prefixes: Record<string, string>): string {
  for (const [prefix, uri] of Object.entries(prefixes)) {
    if (uri && iri.startsWith(uri)) return `${prefix}:${iri.slice(uri.length)}`;
  }
  return iri.split(/[/#]/).pop() ?? iri;
}
