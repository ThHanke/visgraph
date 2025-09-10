/**
 * nodeDisplay helpers
 *
 * Centralize all UI-facing decisions about how to display a node's type
 * (badge text, namespace, short label, tooltip lines) so parser/store can remain
 * canonical and display logic is fast, memoized, and testable.
 */

import type { RDFManager } from '../../../utils/rdfManager';

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
 * shortLocalName
 * - extract local name for a URI or prefixed name
 */
export function shortLocalName(uriOrPrefixed?: string): string {
  if (!uriOrPrefixed) return '';
  const s = String(uriOrPrefixed);
  if (s.includes('://')) {
    const parts = s.split(new RegExp('[#/]')).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
  }
  if (s.includes(':')) {
    return s.split(':').pop() || s;
  }
  const parts = s.split(new RegExp('[#/]')).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * findPrefixForUri
 * - given an expanded URI and an rdfManager (or namespace map), try to find a matching prefix
 * - returns prefix ('' for default) or undefined if no match
 */
export function findPrefixForUri(fullUri: string, rdfManager?: { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined): string | undefined {
  if (!fullUri) return undefined;
  const nsMap = typeof rdfManager === 'function' ? undefined : (rdfManager as any)?.getNamespaces ? (rdfManager as any).getNamespaces() : (rdfManager as Record<string,string> | undefined);
  if (!nsMap) return undefined;
  for (const [prefix, uri] of Object.entries(nsMap || {})) {
    if (!uri) continue;
    if (fullUri.startsWith(uri)) return prefix === ':' ? '' : prefix;
  }
  return undefined;
}

/**
 * pickMeaningfulType
 * - Given an array of rdf:type candidates (strings, possibly prefixed or full URIs),
 *   return the first type that isn't an owl:NamedIndividual marker.
 * - If none found, return the first element or undefined.
 */
export function pickMeaningfulType(types: string[] | undefined): string | undefined {
  if (!types || types.length === 0) return undefined;
  // Prefer the first non-NamedIndividual type. If none exists, return undefined
  // (do not fallback to returning a NamedIndividual marker).
  const nonNamed = types.find(t => t && !/NamedIndividual\b/i.test(String(t)));
  return nonNamed;
}

/**
 * computeDisplayInfo
 * - canonicalNode: expected to contain rdfTypes: string[] (expanded URIs if available)
 * - rdfManager: optional; used to map full URIs to prefixes
 * - availableClasses: optional list of known classes (to prefer a registered prefixed version)
 *
 * Behavior:
 * - prefer first non-NamedIndividual rdf:type (use pickMeaningfulType)
 * - if chosen is a full URI and rdfManager knows a prefix, produce prefixed value
 * - short is always computed from chosen (local name)
 * - tooltipLines returns short names for all rdfTypes (filtering NamedIndividual)
 */
export function computeDisplayInfo(
  canonicalNode: { rdfTypes?: string[] | undefined; displayType?: string | undefined; classType?: string | undefined },
  rdfManager?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined,
  availableClasses?: Array<{ uri: string; label?: string; namespace?: string }>
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

  let chosen = pickMeaningfulType(allTypesRaw);
  let chosenStr = chosen ? String(chosen) : '';

  // If no meaningful type was found (e.g. only owl:NamedIndividual present),
  // try to match any of the raw types against availableClasses (if provided).
  // This helps at runtime when the node contains short labels or prefixed types
  // and the memoized helper is invoked before namespaces are fully registered.
  if (!chosenStr && Array.isArray(availableClasses) && availableClasses.length > 0) {
    for (const t of allTypesRaw) {
      if (!t) continue;
      const match = availableClasses.find(c => c && (c.uri === t || c.uri === String(t)));
      if (match) {
        chosen = match.uri;
        chosenStr = String(chosen);
        break;
      }
      // try tolerant matching by local name
      const local = shortLocalName(String(t));
      const tolerant = availableClasses.find(c => c && (shortLocalName(c.uri) === local || c.label === local));
      if (tolerant) {
        chosen = tolerant.uri;
        chosenStr = String(chosen);
        break;
      }
    }
  }

  if (!chosenStr) return result;

  result.canonicalTypeUri = chosenStr;

  // If chosen is a full URI, try to map to prefix
  if (/^https?:\/\//i.test(chosenStr)) {
    const prefix = findPrefixForUri(chosenStr, rdfManager);
    if (prefix !== undefined) {
      // use prefix:local
      const ns = (rdfManager && (rdfManager as any).getNamespaces) ? (rdfManager as any).getNamespaces() : (rdfManager as Record<string,string> | undefined);
      const uri = ns && prefix in ns ? ns[prefix] : undefined;
      const local = uri ? chosenStr.substring(uri.length) : shortLocalName(chosenStr);
      result.prefixed = prefix ? `${prefix}:${local}` : `${local}`;
      result.namespace = prefix;
      result.short = local;
      result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
      return result;
    } else {
      // No prefix known from rdfManager. Try to match availableClasses (if provided) so
      // loaded ontology class metadata (which may carry a namespace/prefix token) is used.
      if (Array.isArray(availableClasses)) {
        const match = availableClasses.find(c => c && c.uri === chosenStr);
        if (match) {
          const local = shortLocalName(chosenStr);
          // Prefer explicit namespace from class metadata, otherwise infer from rdfManager namespaces.
          const inferredNs = match.namespace || (rdfManager ? findPrefixForUri(match.uri, rdfManager) : undefined);
          result.namespace = inferredNs || '';
          result.prefixed = inferredNs ? `${inferredNs}:${local}` : local;
          result.short = local;
          result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
          return result;
        }
      }
      // fallback: no prefix known, just use short local name
      const short = shortLocalName(chosenStr);
      result.short = short;
      result.prefixed = short;
      result.namespace = '';
      result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
      return result;
    }
  }

  // If chosen is prefixed already (prefix:Local) -> use it
  if (chosenStr.includes(':')) {
    const parts = chosenStr.split(':');
    const prefix = parts[0];
    const local = parts.slice(1).join(':');
    result.prefixed = chosenStr;
    result.namespace = prefix === ':' ? '' : prefix;
    result.short = local;
    result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
    return result;
  }

  // If chosen is a short label (e.g. "Specimen"), try to resolve it via availableClasses so we can
  // prefer a prefixed display like "iof-mat:Specimen" rather than just the bare local name.
  if (Array.isArray(availableClasses) && chosenStr) {
    const localCandidate = String(chosenStr);
    const match = availableClasses.find(c => {
      if (!c) return false;
      if (c.uri === localCandidate || c.label === localCandidate) return true;
      const cLocal = shortLocalName(c.uri);
      return cLocal === localCandidate;
    });
    if (match) {
      const local = shortLocalName(match.uri || localCandidate);
      const inferredNs = match.namespace || (rdfManager ? findPrefixForUri(match.uri, rdfManager) : undefined);
      result.namespace = inferredNs || '';
      result.prefixed = inferredNs ? `${inferredNs}:${local}` : local;
      result.short = local;
      result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
      return result;
    }
  }

  // fallback: treat as short label
  result.short = shortLocalName(chosenStr);
  result.prefixed = result.short;
  result.namespace = '';
  result.tooltipLines = (allTypesRaw || []).map(t => shortLocalName(t)).filter(Boolean);
  return result;
}

/**
 * Simple memoization for computeDisplayInfo
 * - Cache keyed by chosen type + namespace map + availableClasses URIs list.
 * - Exported clear function so callers (e.g. ontologyStore) can clear the cache when namespaces or classes change.
 */
export const _displayInfoCache = new Map<string, DisplayInfo>();

function _namespacesKey(rdfManager?: any): string {
  try {
    const ns = rdfManager && typeof rdfManager.getNamespaces === 'function'
      ? rdfManager.getNamespaces()
      : (rdfManager || {});
    // Normalize entries to a sorted array so the key is stable regardless of object iteration order
    const entries = Object.entries(ns || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify(entries);
  } catch {
    return '';
  }
}

export function computeDisplayInfoMemo(
  canonicalNode: { rdfTypes?: string[] | undefined; displayType?: string | undefined; classType?: string | undefined } | any,
  rdfManager?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined,
  availableClasses?: Array<{ uri: string; label?: string }>
): DisplayInfo {
  const allTypes = [
    ...(canonicalNode?.displayType ? [String(canonicalNode.displayType)] : []),
    ...(canonicalNode?.classType ? [String(canonicalNode.classType)] : []),
    ...(Array.isArray(canonicalNode?.rdfTypes) ? canonicalNode.rdfTypes as string[] : []),
    ...(Array.isArray((canonicalNode as any)?.types) ? (canonicalNode as any).types.map(String) : []),
    ...((canonicalNode as any)?.rdfType ? [String((canonicalNode as any).rdfType)] : []),
    ...((canonicalNode as any)?.type ? [String((canonicalNode as any).type)] : [])
  ].filter(Boolean);

  const chosen = pickMeaningfulType(allTypes);
  const chosenStr = chosen ? String(chosen) : '';

  const nsKey = _namespacesKey(rdfManager);
  const classesKey = Array.isArray(availableClasses) ? (availableClasses.map(c => (c && c.uri ? `${c.uri}@${(c as any).namespace || ''}` : '')).join('|')) : '';

  const cacheKey = `${chosenStr}::${nsKey}::${classesKey}`;
  const cached = _displayInfoCache.get(cacheKey);
  if (cached) return cached;

  const info = computeDisplayInfo(canonicalNode, rdfManager, availableClasses);
  _displayInfoCache.set(cacheKey, info);
  return info;
}

export function clearDisplayInfoCache() {
  _displayInfoCache.clear();
}

export function computeBadgeText(
  canonicalNode: { rdfTypes?: string[] | undefined; displayType?: string | undefined; classType?: string | undefined; uri?: string; iri?: string } | any,
  rdfManager?: RDFManager | { getNamespaces?: () => Record<string,string> } | Record<string,string> | undefined,
  availableClasses?: Array<{ uri: string; label?: string; namespace?: string }>
): string {
  try {
    // Primary source: RDF type triples (rdfTypes / types / rdfType)
    const rawSources = Array.isArray(canonicalNode?.rdfTypes)
      ? (canonicalNode.rdfTypes as string[]).map(String).filter(Boolean)
      : (Array.isArray(canonicalNode?.types) ? (canonicalNode.types as string[]).map(String).filter(Boolean) : (canonicalNode?.rdfType ? [String(canonicalNode.rdfType)] : []));

    const arr = Array.isArray(rawSources) ? rawSources : [];
    const firstMeaningful = arr.find(t => t && !/NamedIndividual\b/i.test(String(t)));

    if (firstMeaningful) {
      const t = String(firstMeaningful);

      // Full URI -> try to map to prefix and return prefixed local name if possible
      if (/^https?:\/\//i.test(t)) {
        const prefix = findPrefixForUri(t, rdfManager);
        if (prefix !== undefined) {
          const ns = (rdfManager && (rdfManager as any).getNamespaces) ? (rdfManager as any).getNamespaces() : (rdfManager as Record<string,string> | undefined);
          const uri = ns && prefix in ns ? ns[prefix] : undefined;
          const local = uri ? t.substring(uri.length) : shortLocalName(t);
          return prefix ? `${prefix}:${local}` : `${local}`;
        }
        // No known prefix: return short local name
        return shortLocalName(t);
      }

      // Already prefixed form (prefix:Local) -> return as-is
      if (t.includes(':')) {
        return t;
      }

      // Short local name -> return as-is
      return shortLocalName(t);
    }

    // Secondary: attempt to compute display info (may use availableClasses / prefixed URIs)
    const info = computeDisplayInfoMemo(canonicalNode, rdfManager, availableClasses);
    if (info) {
      if (info.prefixed) return info.prefixed;
      if (info.short) return info.short;
    }

    // Tertiary fallback: derive from the canonical node URI/IRI local name (ensures demo nodes without rdfTypes still show a badge)
    const possibleUri = String(canonicalNode?.uri || canonicalNode?.iri || canonicalNode?.canonicalTypeUri || '');
    if (possibleUri) {
      const short = shortLocalName(possibleUri);
      if (short) return short;
    }

    // Nothing usable found
    return '';
  } catch {
    return '';
  }
}
