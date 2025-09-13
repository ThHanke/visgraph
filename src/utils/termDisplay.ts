import { NamedNode } from "n3";
import type { RDFManager } from "../utils/rdfManager";
import { shortLocalName as _shortLocalName, expandPrefixed as _expandPrefixed, toPrefixed as _toPrefixed, findPrefixForUri as _findPrefixForUri } from "./prefixUtils";

/**
 * Term display utilities (delegates prefix work to ./prefixUtils)
 *
 * This module keeps a small, strict API for computing a friendly display for
 * RDF terms while relying on the centralized prefix utilities implemented in
 * src/utils/prefixUtils.ts. Callers that previously used computeTermDisplay
 * continue to work unchanged.
 */

export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  namespace: string;
  tooltipLines: string[];
}

/**
 * Re-exported shortLocalName (kept here for compatibility).
 */
export function shortLocalName(uriOrPrefixed?: string): string {
  return _shortLocalName(uriOrPrefixed);
}

/**
 * Find prefix for a full IRI using provided rdfManager / namespace map.
 * Thin wrapper around prefixUtils to preserve naming used across the codebase.
 */
export function findPrefixForUri(fullUri: string, rdfManager?: RDFManager | Record<string,string>): string | undefined {
  return _findPrefixForUri(fullUri, rdfManager);
}

/**
 * Convert a full IRI to a strict prefixed form.
 * Throws if no matching prefix exists.
 */
export function toPrefixed(iri: string | NamedNode, rdfManager?: RDFManager | Record<string,string>): string {
  return _toPrefixed(iri as any, rdfManager as any);
}

/**
 * Expand a prefixed name using rdfManager.expandPrefix if available, or using the namespace map.
 * Throws if expansion cannot be performed.
 */
export function expandPrefixed(prefixedOrIri: string, rdfManager?: RDFManager | Record<string,string>): string {
  return _expandPrefixed(prefixedOrIri, rdfManager as any);
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

  // Prefer producing a prefix:local form when a matching namespace is available,
  // but fall back to a friendly local name when no prefix is known.
  let prefixed: string;
  try {
    prefixed = toPrefixed(targetIri, rdfManager);
  } catch (_) {
    prefixed = shortLocalName(targetIri);
  }

  // Derive prefix/local from prefixed form when possible
  let prefix: string | undefined = undefined;
  let local = String(prefixed || "");
  const idx = local.indexOf(":");
  if (idx > 0) {
    prefix = local.substring(0, idx);
    local = local.substring(idx + 1);
  }

  return {
    iri: targetIri,
    prefixed,
    short: local,
    namespace: prefix || "",
    tooltipLines: [local],
  };
}
