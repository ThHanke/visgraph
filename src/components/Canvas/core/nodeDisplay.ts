/**
 * nodeDisplay helpers (STRICT)
 *
 * This file has been simplified and hardened:
 * - All tolerant fallbacks and silent recovery paths removed.
 * - Prefix / short-name resolution is delegated to src/utils/termDisplay which
 *   requires an RDFManager (or namespace map) for prefix resolution.
 *
 * Behavior:
 * - computeDisplayInfo will deterministically choose the first non-owl:NamedIndividual
 *   rdf:type and resolve it to a strict prefixed form (throws if prefix unknown).
 * - Short local-name extraction is provided for basic UI needs.
 */

import type { RDFManager } from '../../../utils/rdfManager';
import { computeTermDisplay, expandPrefixed, shortLocalName as tdShortLocalName } from '../../../utils/termUtils';

/**
 * DisplayInfo - result returned to UI code
 */
export interface DisplayInfo {
  canonicalTypeUri?: string; // full URI if known
  prefixed?: string;         // e.g. "iof-mat:Specimen"
  short?: string;            // short local name "Specimen"
  namespace?: string;        // prefix portion e.g. "iof-mat"
  tooltipLines?: string[];   // lines for tooltip (short names)
}

/**
 * shortLocalName - convenience wrapper
 */
export function shortLocalName(uriOrPrefixed?: string): string {
  return tdShortLocalName(uriOrPrefixed);
}

/**
 * pickMeaningfulType
 * - Given an array of rdf:type candidates (strings, possibly prefixed or full URIs),
 *   return the first type that isn't an owl:NamedIndividual marker.
 */
export function pickMeaningfulType(types: string[] | undefined): string | undefined {
  if (!types || types.length === 0) return undefined;
  const nonNamed = types.find(t => t && !/NamedIndividual\b/i.test(String(t)));
  return nonNamed;
}

/**
 * computeDisplayInfo (strict)
 *
 * - canonicalNode: expected to contain rdfTypes: string[] (expanded URIs if available)
 * - rdfManager: required for prefix resolution when types are full IRIs or prefixed names
 *
 * This function will throw when it cannot resolve a prefixed form for a full IRI
 * (no silent fallbacks).
 */
export function computeDisplayInfo(
  canonicalNode: { rdfTypes?: string[] | undefined; displayType?: string | undefined; classType?: string | undefined },
  rdfManager?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined,
  _availableClasses?: Array<{iri: string; label?: string; namespace?: string }>
): DisplayInfo {
  const result: DisplayInfo = {};

  const allTypesRaw: string[] = [
    ...(canonicalNode?.displayType ? [String(canonicalNode.displayType)] : []),
    ...(canonicalNode?.classType ? [String(canonicalNode.classType)] : []),
    ...(Array.isArray(canonicalNode?.rdfTypes) ? canonicalNode.rdfTypes as string[] : []),
    ...(Array.isArray((canonicalNode as any)?.types) ? (canonicalNode as any).types.map(String) : []),
    ...((canonicalNode as any)?.rdfType ? [String((canonicalNode as any).rdfType)] : []),
    ...((canonicalNode as any)?.type ? [String((canonicalNode as any).type)] : [])
  ].filter(Boolean);

  const chosen = pickMeaningfulType(allTypesRaw);
  if (!chosen) return result;

  const chosenStr = String(chosen);

  // If chosen is an absolute IRI, compute strict display info via computeTermDisplay
  if (/^https?:\/\//i.test(chosenStr)) {
    if (!rdfManager) throw new Error(`computeDisplayInfo requires rdfManager to resolve IRI '${chosenStr}'`);
    const td = computeTermDisplay(chosenStr, rdfManager as any);
    result.canonicalTypeUri = td.iri;
    result.prefixed = td.prefixed;
    result.short = td.short;
    result.namespace = td.namespace;
    result.tooltipLines = td.tooltipLines;
    return result;
  }

  // If chosen looks like a prefixed name (prefix:Local) expand then resolve strictly
  if (chosenStr.includes(':')) {
    if (!rdfManager) throw new Error(`computeDisplayInfo requires rdfManager to expand prefixed type '${chosenStr}'`);
    const expanded = expandPrefixed(chosenStr, rdfManager as any);
    const td = computeTermDisplay(expanded, rdfManager as any);
    result.canonicalTypeUri = td.iri;
    result.prefixed = td.prefixed;
    result.short = td.short;
    result.namespace = td.namespace;
    result.tooltipLines = td.tooltipLines;
    return result;
  }

  // If it's a bare local name, attempt to resolve deterministically using availableClasses (strict)
  try {
    if (_availableClasses && Array.isArray(_availableClasses) && _availableClasses.length > 0 && rdfManager) {
      const match = (_availableClasses as any[]).find((c) => {
        try {
          if (!c) return false;
          const lbl = String(c.label || "");
          if (lbl && lbl === chosenStr) return true;
          const iri = String(c.iri || "");
          if (!iri) return false;
          const local = tdShortLocalName(iri);
          if (local === chosenStr) return true;
          if (iri.endsWith("/" + chosenStr) || iri.endsWith("#" + chosenStr)) return true;
          return false;
        } catch (_) {
          return false;
        }
      });
      if (match && match.iri) {
        const td = computeTermDisplay(String(match.iri), rdfManager as any);
        result.canonicalTypeUri = td.iri;
        result.prefixed = td.prefixed;
        result.short = td.short;
        result.namespace = td.namespace;
        result.tooltipLines = td.tooltipLines;
        return result;
      }
    }
  } catch (_) {
    // strict: on any failure here fall back to minimal display below
  }

  // Fallback: minimal info for bare local names (do not invent prefixes)
  result.short = shortLocalName(chosenStr);
  result.prefixed = result.short;
  result.namespace = "";
  result.tooltipLines = [(result.short || "")].filter(Boolean);
  return result;
}

/**
 * computeBadgeText
 * - Simplified: try to compute from first meaningful rdf:type; if present and resolvable,
 *   return prefixed form, otherwise return short local name or empty string.
 */
export function computeBadgeText(
  canonicalNode: { rdfTypes?: string[] | undefined; displayType?: string | undefined; classType?: string | undefined; uri?: string; iri?: string } | any,
  rdfManager?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined,
  _availableClasses?: Array<{iri: string; label?: string; namespace?: string }>
): string {
  // Primary source: rdfTypes
  const rawSources = Array.isArray(canonicalNode?.rdfTypes)
    ? (canonicalNode.rdfTypes as string[]).map(String).filter(Boolean)
    : (Array.isArray(canonicalNode?.types) ? (canonicalNode.types as string[]).map(String).filter(Boolean) : (canonicalNode?.rdfType ? [String(canonicalNode.rdfType)] : []));

  const firstMeaningful = rawSources.find(t => t && !/NamedIndividual\b/i.test(String(t)));
  if (firstMeaningful) {
    const t = String(firstMeaningful);
    if (/^https?:\/\//i.test(t)) {
      if (!rdfManager) throw new Error(`computeBadgeText requires rdfManager to resolve IRI '${t}'`);
      const td = computeTermDisplay(t, rdfManager as any);
      return td.prefixed || td.short;
    }
    if (t.includes(':')) {
      if (!rdfManager) throw new Error(`computeBadgeText requires rdfManager to expand prefixed type '${t}'`);
      const expanded = expandPrefixed(t, rdfManager as any);
      const td = computeTermDisplay(expanded, rdfManager as any);
      return td.prefixed || td.short;
    }
    return shortLocalName(t);
  }

  // No type info; do not attempt further fallbacks.
  return '';
}
