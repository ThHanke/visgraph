import { NamedNode } from "n3";
import type { RDFManager } from "../utils/rdfManager";
import { buildPaletteForRdfManager } from "../components/Canvas/core/namespacePalette";

/**
 * Combined term & prefix utilities.
 *
 * This module centralizes:
 * - prefix/namespace helpers (expand/contract)
 * - local-name extraction
 * - computeTermDisplay (friendly label generation)
 *
 * Keep the API small and strict: callers must pass an RDFManager or a raw
 * namespace map when prefix resolution is required.
 */

/* Public type returned by computeTermDisplay */
export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  namespace: string;
  tooltipLines: string[];
  // Optional authoritative color resolved from the RDF manager's palette.
  // When present, callers should use this color as the single source of truth.
  color?: string | undefined;
}

/**
 * Extract local name from a URI or prefixed name.
 */
export function shortLocalName(uriOrPrefixed?: string): string {
  if (!uriOrPrefixed) return "";
  const s = String(uriOrPrefixed);
  if (s.includes("://")) {
    const parts = s.split(new RegExp("[#/]")).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
  }
  if (s.includes(":")) {
    return s.split(":").pop() || s;
  }
  const parts = s.split(new RegExp("[#/]")).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * Resolve namespace map from an RDFManager instance or a raw map.
 * Throws if the resolver is not provided.
 */
function resolveNamespaces(mgr?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined): Record<string,string> {
  if (!mgr) throw new Error("RDF namespaces are required for strict term utilities (pass rdfManager or a namespace map).");
  // If an RDFManager-like object with getNamespaces, call it.
  if ((mgr as any).getNamespaces && typeof (mgr as any).getNamespaces === "function") {
    return (mgr as any).getNamespaces();
  }
  // If it's already a map
  if (typeof mgr === "object") {
    return mgr as Record<string,string>;
  }
  throw new Error("Invalid rdfManager / namespace map provided.");
}

/**
 * Find prefix for a full IRI using provided rdfManager / namespace map.
 * Returns the prefix string (e.g. "iof") if found, otherwise undefined.
 */
export function findPrefixForUri(fullUri: string, rdfManager?: RDFManager | Record<string,string>): string | undefined {
  if (!fullUri) return undefined;
  const nsMap = resolveNamespaces(rdfManager);

  // Collect all matching prefixes, but prefer non-empty named prefixes over the
  // empty/default prefix. Some RDF parsers may register a default namespace with
  // an empty string key; when a named prefix exists for the same namespace we
  // want to prefer the named prefix (e.g. prefer "iof-mat" over "").
  const matches: string[] = [];
  for (const [prefix, uri] of Object.entries(nsMap)) {
    if (!uri) continue;
    try {
      if (fullUri.startsWith(uri)) matches.push(prefix);
    } catch (_) { /* ignore */ }
  }
  if (matches.length === 0) return undefined;
  // Prefer the first non-empty prefix, otherwise fall back to any match (possibly empty).
  const nonEmpty = matches.find((p) => p && String(p).trim() !== "");
  return nonEmpty !== undefined ? nonEmpty : matches[0];
}

/**
 * Convert a full IRI to a strict prefixed form.
 * Throws if no matching prefix exists.
 */
export function toPrefixed(iri: string | NamedNode, rdfManager?: RDFManager | Record<string,string>): string {
  const iriStr = typeof iri === "string" ? iri : (iri as NamedNode).value;
  if (iriStr.startsWith("_:")) return iriStr; // blank node passthrough

  const prefix = findPrefixForUri(iriStr, rdfManager);
  if (!prefix) {
    throw new Error(`No prefix known for IRI: ${iriStr}`);
  }

  const nsMap = resolveNamespaces(rdfManager);
  const nsUri = nsMap[prefix];
  if (!nsUri) throw new Error(`Namespace URI not found for prefix '${prefix}'`);
  const local = iriStr.substring(nsUri.length);
  return `${prefix}:${local}`;
}

/**
 * Expand a prefixed name using rdfManager.expandPrefix if available, or using the namespace map.
 * Throws if expansion cannot be performed.
 */
export function expandPrefixed(prefixedOrIri: string, rdfManager?: RDFManager | Record<string,string>): string {
  if (!prefixedOrIri) throw new Error("Empty value passed to expandPrefixed");
  // If it already looks like a full IRI, return as-is.
  if (prefixedOrIri.includes("://")) return prefixedOrIri;
  // Blank node passthrough
  if (prefixedOrIri.startsWith("_:")) return prefixedOrIri;

  // If rdfManager has expandPrefix method, use it.
  if (rdfManager && (rdfManager as any).expandPrefix && typeof (rdfManager as any).expandPrefix === "function") {
    return (rdfManager as any).expandPrefix(prefixedOrIri);
  }

  // Otherwise, resolve using namespaces map.
  const colonIndex = prefixedOrIri.indexOf(":");
  if (colonIndex === -1) throw new Error(`Value '${prefixedOrIri}' is not a prefixed name`);
  const prefix = prefixedOrIri.substring(0, colonIndex);
  const local = prefixedOrIri.substring(colonIndex + 1);
  const nsMap = resolveNamespaces(rdfManager);
  const ns = nsMap[prefix];
  if (!ns) throw new Error(`Unknown prefix '${prefix}' while expanding '${prefixedOrIri}'`);
  return `${ns}${local}`;
}

/**
 * Compute a strict TermDisplayInfo for a given IRI or NamedNode.
 * - Requires rdfManager / namespace map for prefix resolution.
 * - Throws on missing prefixes unless the value is a blank node.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
  rdfManager?: RDFManager | Record<string,string>
): TermDisplayInfo {
  const iri = typeof iriOrTerm === "string" ? iriOrTerm : (iriOrTerm as NamedNode).value;
  if (!iri) throw new Error("Empty IRI passed to computeTermDisplay");

  // Blank nodes are passed through
  if (iri.startsWith("_:")) {
    return {
      iri,
      prefixed: iri,
      short: iri,
      namespace: "",
      tooltipLines: [iri],
      color: undefined,
    };
  }

  // If the input does not look like a full IRI, attempt to expand a prefixed name
  // using the provided rdfManager / namespace map. If expansion fails or no rdfManager
  // is available, throw to keep behavior strict and explicit.
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    if (!rdfManager) {
      throw new Error(`computeTermDisplay requires a full IRI or NamedNode; received '${iri}'`);
    }
    try {
      targetIri = expandPrefixed(targetIri, rdfManager);
    } catch (e) {
      throw new Error(`computeTermDisplay could not expand prefixed name '${iri}': ${String(e)}`);
    }
  }

  // Prefer producing a prefix:local form when a matching namespace is available.
  // Strict behavior: only use prefixes that can be resolved via the provided rdfManager/namespace map.
  // If no explicit prefix exists, try a conservative fallback: if the IRI's namespace
  // matches any registered namespace, render as ':local' to indicate default-namespace form.
  let prefixed: string;
  try {
    prefixed = toPrefixed(targetIri, rdfManager);
  } catch (_) {
    // No explicit prefix found via normal lookup -> attempt conservative fallback
    try {
      const nsMap = rdfManager && (rdfManager as any).getNamespaces && typeof (rdfManager as any).getNamespaces === 'function'
        ? (rdfManager as any).getNamespaces()
        : (rdfManager && typeof rdfManager === 'object' ? (rdfManager as unknown as Record<string,string>) : undefined);
      if (nsMap) {
        const target = String(targetIri);
        for (const nsUri of Object.values(nsMap)) {
          try {
            if (nsUri && target.startsWith(nsUri)) {
              // Found a matching namespace; render as default-namespace form ":local"
              prefixed = `:${shortLocalName(targetIri)}`;
              // Ensure we record namespace as empty to indicate default
              // (caller uses namespace field to decide styling/colouring).
              // We'll set namespace below.
              break;
            }
          } catch (_) { /* ignore per-candidate */ }
        }
      }
    } catch (_) {
      /* ignore fallback failures */
    }
    // If still not resolved, fall back to local name
    if (!prefixed) prefixed = shortLocalName(targetIri);
  }

  // Derive prefix/local from prefixed form when possible
  let prefix: string | undefined = undefined;
  let local = String(prefixed || "");
  const idx = local.indexOf(":");
  if (idx > 0) {
    prefix = local.substring(0, idx);
    local = local.substring(idx + 1);
  }

  // Determine authoritative color using the rdfManager-derived palette.
  // Strict: only use a palette color when a named prefix is available and the
  // palette contains an explicit color for that prefix. Do not synthesize.
  let color: string | undefined = undefined;
  try {
    if (prefix && rdfManager) {
      const palette = buildPaletteForRdfManager(rdfManager);
      if (palette && typeof palette === "object") {
        // Try exact prefix first, then lowercase.
        color = (palette as Record<string,string>)[prefix] || (palette as Record<string,string>)[prefix.toLowerCase()];
      }
    }
  } catch (_) {
    color = undefined;
  }

  return {
    iri: targetIri,
    prefixed,
    short: local,
    namespace: prefix || "",
    tooltipLines: [local],
    color,
  };
}
