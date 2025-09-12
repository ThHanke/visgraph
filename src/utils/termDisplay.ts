import { NamedNode } from "n3";
import type { RDFManager } from "../utils/rdfManager";
import { shortIriString } from "./shortIri";

/**
 * Strict term display utilities.
 * - Aggressive / no-fallback policy: callers must supply full IRIs or NamedNode.
 * - Prefix resolution requires an RDFManager (or namespace map) that contains the matching prefix.
 *
 * Functions always return plain strings (no RDFJS objects).
 */

export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  namespace: string;
  tooltipLines: string[];
}

/**
 * Extract local name from a URI.
 * This replicates the simple local-name extraction used elsewhere.
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
  if (!mgr) throw new Error("RDF namespaces are required for strict term display (pass rdfManager or a namespace map).");
  // If an RDFManager like object with getNamespaces, call it.
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
  for (const [prefix, uri] of Object.entries(nsMap)) {
    if (!uri) continue;
    if (fullUri.startsWith(uri)) return prefix;
  }
  return undefined;
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
    };
  }

  // Ensure it's a full IRI
  if (!iri.includes("://")) {
    throw new Error(`computeTermDisplay requires a full IRI or NamedNode; received '${iri}'`);
  }

  const nsMap = resolveNamespaces(rdfManager);

  // Prefer producing a prefix:local form when a matching namespace is available,
  // but fall back to a friendly local name when no prefix is known.
  const prefixed = shortIriString(iri, nsMap);

  // Derive prefix/local from prefixed form when possible
  let prefix: string | undefined = undefined;
  let local = String(prefixed || "");
  const idx = local.indexOf(":");
  if (idx > 0) {
    prefix = local.substring(0, idx);
    local = local.substring(idx + 1);
  }

  return {
    iri,
    prefixed,
    short: local,
    namespace: prefix,
    tooltipLines: [local],
  };
}
