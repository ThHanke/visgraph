/**
 * Utility to create short/prefixed IRI forms using a prefix map.
 *
 * Usage:
 *   import { shortIriString } from '../utils/shortIri';
 *   const short = shortIriString('http://xmlns.com/foaf/0.1/name', rdfManager.getNamespaces());
 *
 * Behavior:
 * - If a namespace URI from the provided map is a prefix of the IRI, returns "prefix:local".
 *   Prefers the longest matching namespace to handle nested namespaces.
 * - Otherwise returns the last path or fragment segment as a fallback.
 */

export type NamespacesMap = Record<string, string>;

/**
 * Split an IRI into [prefix, local] using provided namespaces.
 * If no prefix match, returns [undefined, localName].
 */
export function splitIri(iri: string, namespaces?: NamespacesMap): [string | undefined, string] {
  try {
    const iriStr = String(iri || "");
    if (!iriStr) return [undefined, ""];

    // Prefer matching registered prefixes (longest namespace wins)
    if (namespaces && typeof namespaces === "object") {
      // Build entries sorted by namespace length descending to pick longest match
      const entries = Object.entries(namespaces).sort((a, b) => {
        const la = (a[1] || "").length;
        const lb = (b[1] || "").length;
        return lb - la;
      });
      for (const [prefix, nsUri] of entries) {
        try {
          if (!nsUri) continue;
          if (iriStr.startsWith(nsUri)) {
            const local = iriStr.substring(nsUri.length);
            return [prefix, local || ""];
          }
        } catch (_) {
          /* ignore per-entry failures */
        }
      }
    }

    // If not matched, try to split by common separators (# or /)
    const parts = iriStr.split(/[#\/]/).filter(Boolean);
    const local = parts.length ? parts[parts.length - 1] : iriStr;
    return [undefined, local];
  } catch (_) {
    return [undefined, String(iri || "")];
  }
}

/**
 * Return a human-friendly short string for an IRI.
 * If a prefix match is found, returns "prefix:local", otherwise returns the derived local name.
 */
export function shortIriString(iri: string, namespaces?: NamespacesMap): string {
  try {
    const [prefix, local] = splitIri(iri, namespaces);
    if (prefix) {
      return `${prefix}:${local}`;
    }
    return local;
  } catch (_) {
    return String(iri || "");
  }
}

export default shortIriString;
