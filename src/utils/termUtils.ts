import { NamedNode } from "n3";
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
    try {
      if (fullUri.startsWith(uri)) candidates.push({ prefix, uri });
    } catch (_) { /* ignore */ }
  }
  if (candidates.length === 0) return undefined;

  // Sort by namespace URI length (longest first) so more specific namespaces win.
  candidates.sort((a, b) => {
    try {
      return (b.uri ? String(b.uri).length : 0) - (a.uri ? String(a.uri).length : 0);
    } catch (_) {
      return 0;
    }
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
  rdfManager?: RDFManager | Record<string,string>,
  palette?: Record<string,string> | undefined
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

  // Ensure we have a target IRI (expand prefixed names when needed)
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    if (!rdfManager) {
      throw new Error(`computeTermDisplay requires a full IRI or NamedNode; received '${iri}'`);
    }
    try {
      // Try to expand a runtime-known prefixed name first (strict)
      targetIri = expandPrefixed(targetIri, rdfManager);
    } catch (_) {
      // If expansion fails, prefer to produce a sensible prefixed/local representation
      // rather than throwing — try WELL_KNOWN, then runtime namespaces, then fallback to local name.
    }
  }

  // Determine a prefixed presentation for the targetIri.
  let prefixed: string | undefined;
  try {
    // 1) Try strict conversion using runtime-known prefixes
    prefixed = toPrefixed(targetIri, rdfManager);
  } catch (_) {
    // 2) FALLBACKS: WELL_KNOWN prefixes, then runtime namespace map (prefer named prefixes), then default/empty prefix mapping.
    try {
      const target = String(targetIri);

      // a) WELL_KNOWN canonical prefixes
      try {
        if (WELL_KNOWN && (WELL_KNOWN as any).prefixes) {
          const wkPrefixes = (WELL_KNOWN as any).prefixes as Record<string, string>;
          for (const [wkPrefix, wkUri] of Object.entries(wkPrefixes)) {
            try {
              if (!wkUri) continue;
              const norm = (s: string) => String(s).replace(/[#\/]+$/, "");
              if (norm(target).startsWith(norm(wkUri))) {
                prefixed = `${wkPrefix}:${shortLocalName(targetIri)}`;
                break;
              }
            } catch (_) {
              /* ignore per-entry */
            }
          }
        }
      } catch (_) {
        /* ignore WELL_KNOWN failures */
      }

      // b) runtime-registered namespaces
      if (!prefixed && rdfManager) {
        try {
          const nsMap =
            (rdfManager as any)?.getNamespaces && typeof (rdfManager as any).getNamespaces === "function"
              ? (rdfManager as any).getNamespaces()
              : (rdfManager && typeof rdfManager === "object" ? (rdfManager as unknown as Record<string,string>) : undefined);

          if (nsMap) {
            // Prefer named prefixes; remember default empty prefix if present.
            let defaultPrefixed: string | undefined = undefined;
            for (const [p, nsUri] of Object.entries(nsMap)) {
              try {
                if (!nsUri) continue;
                if (target.startsWith(nsUri)) {
                  if (p && String(p).trim() !== "") {
                    prefixed = `${p}:${shortLocalName(targetIri)}`;
                    break;
                  } else if (!defaultPrefixed) {
                    defaultPrefixed = `:${shortLocalName(targetIri)}`;
                  }
                }
              } catch (_) {
                /* ignore per-entry */
              }
            }
            if (!prefixed && defaultPrefixed) prefixed = defaultPrefixed;
          }
        } catch (_) {
          /* ignore runtime nsMap failures */
        }
      }
    } catch (_) {
      /* ignore fallback failures */
    }
    // Final fallback to local name
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

  // Determine authoritative color using a provided palette (preferred) or the rdfManager-derived palette.
  let color: string | undefined = undefined;
  try {
    if (prefix) {
      let paletteToUse: Record<string,string> | undefined = undefined;
      if (palette && typeof palette === "object") {
        paletteToUse = palette;
      } else if (rdfManager) {
        // Synchronously derive a palette from the rdfManager's registered namespaces
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
        paletteToUse = buildPaletteMap(prefixes, { avoidColors: textColors });
      }
      if (paletteToUse && typeof paletteToUse === "object") {
        color = (paletteToUse as Record<string,string>)[prefix] || (paletteToUse as Record<string,string>)[prefix.toLowerCase()];
      }
    }
  } catch (_) {
    color = undefined;
  }

  return {
    iri: targetIri,
    prefixed: prefixed || shortLocalName(targetIri),
    short: local,
    namespace: prefix || "",
    tooltipLines: [local],
    color,
  };
}
