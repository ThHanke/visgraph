/**
 * Namespace / palette helper utilities for Canvas
 *
 * Export pure functions so they can be imported into components and used
 * in effect dependencies without changing identity between renders.
 */

/**
 * Normalize a namespace key by stripping trailing characters typically used
 * in RDF namespace URIs (like ':' or '#' and trailing path segments).
 */
export function normalizeNamespaceKey(ns: string | undefined): string {
  if (ns == null) return '';
  const s = String(ns);
  // Remove trailing colon
  if (s.endsWith(':')) return s.replace(/:$/, '');
  // Strip after first # or last slash segment
  return s.replace(/[:#].*$/, '');
}

/**
 * Lookup a palette color for a given namespace using a palette map.
 * The paletteMap is expected to be an object mapping namespace keys to color strings.
 *
 * Strategy:
 * - Try the raw key
 * - Try a normalized key (strip suffixes)
 * - Try a few reasonable fallbacks (empty key)
 * - Return fallback color when nothing matches
 */
export function getNamespaceColorFromPalette(paletteMap: Record<string, string> | undefined, namespace?: string): string | undefined {
  if (!paletteMap || typeof paletteMap !== 'object') return undefined;

  // treat undefined as empty string key
  const nsKey = namespace == null ? '' : String(namespace);

  const tryKeys = new Set<string>();
  tryKeys.add(nsKey);
  tryKeys.add(normalizeNamespaceKey(nsKey));
  if (nsKey === '') tryKeys.add(':');

  // Also try with/without trailing colon
  if (nsKey && !nsKey.endsWith(':')) tryKeys.add(`${nsKey}:`);
  if (nsKey && nsKey.endsWith(':')) tryKeys.add(nsKey.replace(/:$/, ''));

  for (const k of tryKeys) {
    if (k && (paletteMap as any)[k]) return (paletteMap as any)[k];
  }

  if ((paletteMap as any)['']) return (paletteMap as any)[''];
  return undefined;
}
