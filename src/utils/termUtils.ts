import { NamedNode, DataFactory } from "n3";
import type { RDFManager } from "../utils/rdfManager";
import { buildPaletteMap } from "../components/Canvas/core/namespacePalette";
import { WELL_KNOWN } from "../utils/wellKnownOntologies";

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
  // Optional human-friendly label and its source (fatmap preferred).
  label?: string | undefined;
  labelSource?: 'fatmap' | 'computed' | undefined;
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

  // Collect matching prefixes along with their namespace URIs so we can prefer the
  // most specific (longest) namespace match. Some parsers register a default namespace
  // under the empty string key; prefer explicit named prefixes when available.
  const candidates: { prefix: string; uri: string }[] = [];
  for (const [prefix, uri] of Object.entries(nsMap)) {
    if (!uri) continue;
    if (fullUri.startsWith(uri)) candidates.push({ prefix, uri });
  }
  if (candidates.length === 0) return undefined;

  // Sort by namespace URI length (longest first) so more specific namespaces win.
  candidates.sort((a, b) => {
    return (b.uri ? String(b.uri).length : 0) - (a.uri ? String(a.uri).length : 0);
  });

  // Prefer a non-empty named prefix among the sorted candidates.
  const named = candidates.find((c) => c.prefix && String(c.prefix).trim() !== "");
  if (named) return named.prefix;

  // Otherwise return the first candidate's prefix (may be the empty/default prefix).
  return candidates[0].prefix;
}

/**
 * Convert a full IRI to a strict prefixed form.
 * Throws if no matching prefix exists.
 */
export function toPrefixed(iri: string | NamedNode, rdfManager?: RDFManager | Record<string,string>): string {
  const iriStr = typeof iri === "string" ? iri : (iri as NamedNode).value;
  if (iriStr.startsWith("_:")) return iriStr; // blank node passthrough

  const prefix = findPrefixForUri(iriStr, rdfManager);
  // Allow empty-string (default) prefix: only throw when prefix is truly undefined.
  if (typeof prefix === "undefined") {
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
 *
 * Note: All try/catch blocks have been removed per request — errors will now bubble.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
  rdfManager?: RDFManager | Record<string,string>,
  palette?: Record<string,string> | undefined,
  opts?: { availableProperties?: any[]; availableClasses?: any[] },
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
      label: iri,
      labelSource: 'computed',
    };
  }

  // Ensure we have a target IRI (expand prefixed names when needed)
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    if (!rdfManager) {
      // If caller didn't provide rdfManager we treat the input as-is and compute local forms
      targetIri = iri;
    } else {
      targetIri = expandPrefixed(targetIri, rdfManager);
    }
  }

  // Determine a prefixed presentation for the targetIri.
  let prefixed: string

  // Compute namespace prefix and local name so the rest of the function can refer to them.
  // Derive prefix via findPrefixForUri when an rdfManager / namespace map is available.
  let prefix: string | undefined = rdfManager ? findPrefixForUri(targetIri, rdfManager) : undefined;

  // Derive a local name: prefer extracting by removing the namespace URI when available,
  // otherwise fall back to shortLocalName.
  let local: string;
  if (prefix && rdfManager) {
    const ns = resolveNamespaces(rdfManager)[prefix];
    if (ns && targetIri.startsWith(ns)) {
      local = targetIri.substring(ns.length);
    } else {
      local = shortLocalName(targetIri);
    }
  } else {
    local = shortLocalName(targetIri);
  }

  // Attempt to compute a strict prefixed form. Errors will bubble.
  prefixed = toPrefixed(targetIri, rdfManager);

  // Determine authoritative color using provided palette first, otherwise derive from rdfManager
  let color: string | undefined = undefined;
  if (prefix) {
    if (palette && typeof palette === "object") {
      color = palette[prefix] || palette[prefix.toLowerCase()];
    } else if (rdfManager) {
      const nsMap =
        (rdfManager as any) && typeof (rdfManager as any).getNamespaces === "function"
          ? (rdfManager as any).getNamespaces()
          : {};
      const prefixes = Object.keys(nsMap || {}).filter(Boolean).sort();
      const textColors =
        typeof window !== "undefined" && window.getComputedStyle
          ? [
              String(getComputedStyle(document.documentElement).getPropertyValue("--node-foreground") || "#000000"),
              String(getComputedStyle(document.documentElement).getPropertyValue("--primary-foreground") || "#000000"),
            ]
          : ["#000000", "#000000"];
      const derived = buildPaletteMap(prefixes, { avoidColors: textColors });
      color = derived[prefix] || derived[prefix.toLowerCase()];
    }
  }

  // Primary: fat-map lookup (availableProperties) — authoritative label & optional color hint
  let label: string | undefined;
  let labelSource: 'fatmap' | 'computed' | undefined;

  const props = opts && Array.isArray(opts.availableProperties) ? opts.availableProperties : undefined;
  if (props && props.length > 0) {
    // Build a quick lookup by IRI (prefer absolute IRIs in fat map)
    const mapByIri = new Map<string, any>();
    for (const p of props) {
      if (!p) continue;
      const iriKey = String((p && p.iri) || '').trim();
      if (!iriKey) continue;
      if (!mapByIri.has(iriKey)) mapByIri.set(iriKey, p);
    }
    // Direct match on targetIri
    const direct = mapByIri.get(String(targetIri));
    if (direct) {
      if (direct.label) {
        label = String(direct.label);
        labelSource = 'fatmap';
      }
      // fat-map hint color
      if (!color && (direct.color || direct.style?.color)) {
        color = String(direct.color || direct.style?.color);
      }
    } else {
      // Also try match by prefixed form or short local name if entries might store prefixed keys
      const byPref = mapByIri.get(String(prefixed || ''));
      if (byPref && byPref.label) {
        label = String(byPref.label);
        labelSource = 'fatmap';
        if (!color && (byPref.color || byPref.style?.color)) {
          color = String(byPref.color || byPref.style?.color);
        }
      }
    }
  }

  // Read an rdfs:label from the RDF store when available (authoritative).
  if (!label && rdfManager && (rdfManager as any).getStore && typeof (rdfManager as any).getStore === "function") {
    const store = (rdfManager as any).getStore();

    // Prefer direct subject+predicate lookup first (exact match).
    const pred = DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#label");
    const subj = DataFactory.namedNode(String(targetIri));
    const directMatches =
      (store && typeof store.getQuads === "function")
        ? store.getQuads(subj, pred, null, null) || []
        : [];
    if (directMatches && directMatches.length > 0) {
      const obj = (directMatches[0] as any).object;
      if (obj && typeof (obj as any).value === "string" && (obj as any).value.trim() !== "") {
        label = String((obj as any).value);
        labelSource = "computed";
      }
    }

    // Fallback: scan all quads and match by subject string & predicate local-name 'label'.
    if (!label) {
      const allQuads = (store && typeof store.getQuads === "function")
        ? store.getQuads(null, pred, null, null) || []
        : [];
      for (const q of allQuads) {
        const sVal = (q && (q.subject as any) && (q.subject as any).value) || "";
        const pVal = (q && (q.predicate as any) && (q.predicate as any).value) || "";
        if (!sVal || !pVal) continue;
        // Match subject and predicate that ends with 'label' (robust to different namespace forms)
        if (String(sVal) === String(targetIri) && /(?:[#/])label$/.test(String(pVal))) {
          const obj = (q as any).object;
          if (obj && typeof (obj as any).value === "string" && (obj as any).value.trim() !== "") {
            label = String((obj as any).value);
            labelSource = "computed";
            break;
          }
        }
      }
    }
  }

  // Fallback: computed prefixed/short
  if (!label) {
    label = prefixed || local;
    labelSource = 'computed';
  }

  return {
    iri: targetIri,
    prefixed: prefixed || shortLocalName(targetIri),
    short: local,
    namespace: prefix || "",
    tooltipLines: [local],
    color,
    label,
    labelSource,
  };
}
