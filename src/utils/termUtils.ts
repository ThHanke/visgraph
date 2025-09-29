import { NamedNode, DataFactory } from "n3";
const { namedNode } = DataFactory;
import { useOntologyStore } from "../stores/ontologyStore";

/**
 * termUtils - registry-only implementation
 *
 * This module now treats the ontology store's namespaceRegistry as the single
 * authoritative source of prefix -> namespace -> color mappings. computeTermDisplay
 * and the helper functions below will NOT consult any RDF manager or perform
 * store-level queries. They rely only on:
 *  - a provided namespaceRegistry (preferred),
 *  - optionally on availableProperties / availableClasses passed in opts.
 *
 * Behavior:
 * - If no matching registry entry (longest-match) exists for an IRI, functions
 *   will throw. This makes missing registry entries explicit for debugging.
 * - Color resolution comes only from registry entries.
 * - Label resolution prefers the fat-map (opts.availableProperties / availableClasses).
 *
 * Notes:
 * - To avoid circular imports, callers should pass registry into these helpers
 *   when possible. For convenience many components use the ontology store directly
 *   (useOntologyStore.getState().namespaceRegistry) before calling these helpers.
 */

/* Public type returned by computeTermDisplay */
export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  namespace: string;
  tooltipLines: string[];
  color?: string | undefined;
  label?: string | undefined;
  labelSource?: "fatmap" | "computed" | undefined;
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

type RegistryEntry = { prefix: string; namespace: string; color?: string };

/**
 * Normalize various registry inputs into a RegistryEntry[].
 * Accepts:
 *  - an array of RegistryEntry (returned as-is)
 *  - an object map { prefix: namespace, ... } (converted)
 *  - an RDFManager-like object exposing getNamespaces(): Record<string,string>
 *
 * Returns undefined when no usable registry can be derived.
 */
function normalizeRegistry(input?: RegistryEntry[] | Record<string, string> | any): RegistryEntry[] | undefined {
  if (!input) return undefined;
  try {
    if (Array.isArray(input) && input.length > 0) return input as RegistryEntry[];
    // If it's an object map (prefix -> namespace)
    if (typeof input === "object" && !Array.isArray(input)) {
      // If it looks like an RDFManager with getNamespaces()
      if (typeof (input as any).getNamespaces === "function") {
        try {
          const map = (input as any).getNamespaces();
          if (map && typeof map === "object") {
            return Object.entries(map).map(([p, ns]) => ({ prefix: String(p), namespace: String(ns) }));
          }
        } catch (_) {
          // fall through
        }
      }
      // Otherwise treat input as a plain map of prefix->namespace
      const entries = Object.entries(input as Record<string, string>).map(([p, ns]) => ({ prefix: String(p), namespace: String(ns) }));
      if (entries.length > 0) return entries;
    }
  } catch (_) { /* ignore */ }
  return undefined;
}

/**
 * Choose the best registry entry that matches a given IRI.
 * Prefers the longest namespace match to handle nested namespaces.
 * Returns the entry or undefined.
 */
export function findRegistryEntryForIri(targetIri: string, registry?: RegistryEntry[] | Record<string,string> | any): RegistryEntry | undefined {
  if (!targetIri) return undefined;
  const reg = normalizeRegistry(registry as any);
  if (!reg || reg.length === 0) return undefined;
  let best: RegistryEntry | undefined = undefined;
  for (const e of reg) {
    try {
      const uri = String(e && e.namespace || "");
      const p = String(e && e.prefix || "");
      if (uri === undefined || p === undefined) continue;
      if (!uri || typeof uri !== "string") continue;
      if (targetIri.startsWith(uri)) {
        if (!best || uri.length > String(best.namespace || "").length) best = e;
      }
    } catch (_) {
      // ignore per-entry
    }
  }
  return best;
}

/**
 * Expand a prefixed name using only the namespaceRegistry.
 * Throws if prefix is unknown.
 */
export function expandPrefixed(prefixedOrIri: string, registry?: RegistryEntry[] | Record<string,string> | any): string {
  if (!prefixedOrIri) throw new Error("Empty value passed to expandPrefixed");
  if (prefixedOrIri.includes("://")) return prefixedOrIri;
  if (prefixedOrIri.startsWith("_:")) return prefixedOrIri;

  const idx = prefixedOrIri.indexOf(":");
  if (idx === -1) throw new Error(`Value '${prefixedOrIri}' is not a prefixed name`);
  const prefix = prefixedOrIri.substring(0, idx);
  const local = prefixedOrIri.substring(idx + 1);

  const reg = normalizeRegistry(registry as any);
  if (!reg || reg.length === 0) throw new Error(`Namespace registry is empty; cannot expand '${prefixedOrIri}'`);
  const entry = reg.find((e) => String(e && e.prefix || "") === String(prefix));
  if (!entry) throw new Error(`Unknown prefix '${prefix}' while expanding '${prefixedOrIri}'`);
  const ns = String(entry.namespace || "");
  if (!ns) throw new Error(`Registry entry for prefix '${prefix}' has empty namespace`);
  return `${ns}${local}`;
}

/**
 * Convert a full IRI into a prefixed form using the fat-map and/or registry.
 *
 * Behavior:
 * - If availableProperties / availableClasses contains an entry whose iri matches the given IRI,
 *   prefer using the registry entry that matches that iri's namespace when available.
 * - Otherwise, use the registry to find the longest matching namespace and return prefix:local.
 * - If no registry entry is found, fall back to returning the short local name.
 *
 * Signature:
 *   toPrefixed(iri, availableProperties?, availableClasses?, registry?)
 *
 * Returns a prefixed string such as "ex:LocalName" or the shortLocalName if no registry match.
 */
export function toPrefixed(
  iri: string,
  availableProperties?: any[],
  availableClasses?: any[],
  registry?: RegistryEntry[] | Record<string,string> | any,
): string {
  if (!iri) return "";

  try {
    // Normalize fat-map inputs
    const props = Array.isArray(availableProperties) ? availableProperties : [];
    const classes = Array.isArray(availableClasses) ? availableClasses : [];

    // Prefer an exact fat-map match (property first, then class)
    const fatMatch =
      props.find((p: any) => String((p && (p.iri || p.key)) || "") === String(iri)) ||
      classes.find((c: any) => String((c && c.iri) || "") === String(iri));

    // If we have a fat-match, try to find a registry entry that matches the fatMatch's iri (or the provided iri)
    if (fatMatch) {
      const candidateIri = String(fatMatch.iri || fatMatch.key || iri);
      const entryForFat = findRegistryEntryForIri(candidateIri, registry);
      if (entryForFat && entryForFat.namespace) {
        const local = candidateIri.startsWith(entryForFat.namespace) ? candidateIri.substring(entryForFat.namespace.length) : shortLocalName(candidateIri);
        return `${entryForFat.prefix}:${local}`;
      }
    }

    // No fat-match or no registry entry for it: fall back to longest-match from registry using the full iri
    const entry = findRegistryEntryForIri(String(iri), registry);
    if (entry && entry.namespace) {
      const local = String(iri).startsWith(entry.namespace) ? String(iri).substring(entry.namespace.length) : shortLocalName(iri);
      return `${entry.prefix}:${local}`;
    }

   // Final fallback: return full IRI
   return iri;
  } catch (_) {
    return iri;
  }
}

/**
 * Return a palette color for a given IRI using the registry and optional palette override.
 * - If a registry entry matching the IRI exists and has a color, return that color.
 * - Otherwise, if a palette map is provided, try to find a color by prefix (case-insensitive).
 * - Returns undefined when no color can be determined.
 */
export function getNodeColor(
  targetIri: string,
  registry?: RegistryEntry[] | Record<string,string> | any,
  palette?: Record<string, string> | undefined,
): string | undefined {
  try {
    if (!targetIri) return undefined;

    // Try to normalize any registry passed in
    let reg = normalizeRegistry(registry as any);

    // If no registry provided or it's empty, attempt to read the persisted namespaceRegistry
    // from the ontology store (synchronously). This is the canonical persisted snapshot
    // that rdfManager / ontologyStore persist after RDF loads.
    if ((!reg || reg.length === 0) && typeof useOntologyStore !== "undefined") {
      try {
        const st =
          (useOntologyStore && typeof (useOntologyStore as any).getState === "function")
            ? (useOntologyStore as any).getState()
            : undefined;
        const persisted = st && Array.isArray((st as any).namespaceRegistry) ? (st as any).namespaceRegistry : undefined;
        if (persisted && Array.isArray(persisted) && persisted.length > 0) {
          // persisted entries are expected to have { prefix, namespace, color }
          reg = normalizeRegistry(persisted as any) || reg;
        }
      } catch (_) {
        // ignore store read failures and continue with existing reg (may be undefined)
      }
    }

    // First try registry entry color (when reg present)
    const entry = reg ? findRegistryEntryForIri(String(targetIri), reg) : findRegistryEntryForIri(String(targetIri), registry);
    if (entry && entry.color) {
      const c = String(entry.color || "").trim();
      if (c) return c;
    }

    // If palette provided, try to resolve by prefix found in registry (longest-match)
    let prefix: string | undefined = undefined;
    if (reg && reg.length > 0) {
      const e = findRegistryEntryForIri(String(targetIri), reg);
      if (e) prefix = String(e.prefix || "");
    } else {
      // As a last resort, try to derive a prefix via the original registry parameter
      const alt = normalizeRegistry(registry as any);
      if (alt && alt.length > 0) {
        const e = findRegistryEntryForIri(String(targetIri), alt);
        if (e) prefix = String(e.prefix || "");
      }
    }

    if (prefix && palette && typeof palette === "object") {
      return palette[prefix] || palette[prefix.toLowerCase()] || undefined;
    }

    return undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Compute a TermDisplayInfo using only namespaceRegistry and optional fat-map data (opts).
 * Throws when registry lacks a matching prefix for the IRI.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
  registry?: RegistryEntry[],
  palette?: Record<string, string> | undefined, // optional; if not provided will be derived from registry
  opts?: { availableProperties?: any[]; availableClasses?: any[] },
): TermDisplayInfo {
  const iri = typeof iriOrTerm === "string" ? iriOrTerm : (iriOrTerm as NamedNode).value;
  if (!iri) throw new Error("Empty IRI passed to computeTermDisplay");

  // Blank nodes handled transparently
  if (iri.startsWith("_:")) {
    return {
      iri,
      prefixed: iri,
      short: iri,
      namespace: "",
      tooltipLines: [iri],
      color: undefined,
      label: iri,
      labelSource: "computed",
    };
  }

  // If input is prefixed, expand only via registry
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    // treat as prefixed; expand using registry
    targetIri = expandPrefixed(targetIri, registry);
  }

  // Determine registry entry.
  const entry = findRegistryEntryForIri(targetIri, registry);

  // If a registry was explicitly provided (array/object), require a matching entry.
  // This enforces the registry-only policy for callers that pass an explicit registry.
  if (typeof registry !== "undefined" && registry !== null && !entry) {
    throw new Error(`No registry prefix found for IRI: ${targetIri}`);
  }

  // Normalize prefix handling: treat default prefix (':') specially so callers see namespace = ""
  let rawPrefix = "";
  let nsUri = "";
  let local = shortLocalName(targetIri);
  let prefixed = local;
    if (entry) {
      rawPrefix = String(entry.prefix || "");
      nsUri = String(entry.namespace || "");
      local = targetIri.startsWith(nsUri) ? targetIri.substring(nsUri.length) : shortLocalName(targetIri);
      // For display purposes, if the registry stores the default prefix as ":" or the empty prefix ''
      // we keep the prefixed form ":local" so UI/tests can render the default prefix explicitly.
      // Accept both ":" and "" as the default prefix marker; avoid producing "::local" when prefix === ":".
      prefixed = rawPrefix === ":" || rawPrefix === "" ? `:${local}` : (rawPrefix ? `${rawPrefix}:${local}` : local);
    }
  // Expose a consumer-friendly namespace field: empty string when default prefix used (':' or empty string)
  const prefix = rawPrefix === ":" || rawPrefix === "" ? "" : rawPrefix;
  // If no entry exists (and no registry provided), we still keep prefixed=local and prefix=""

  // palette derivation: prefer explicit palette param, otherwise derive from registry entry color
  let color: string | undefined = undefined;
  if (prefix && palette && typeof palette === "object") {
    color = palette[prefix] || palette[prefix.toLowerCase()];
  }
  if (!color) {
    // Only read entry.color when an entry was actually found to avoid runtime TypeErrors
    if (entry) {
      color = entry.color || undefined;
    } else {
      color = undefined;
    }
  }

  // Label resolution: prefer an explicit rdfs:label from the RDF manager when available,
  // then fall back to fat-map entries (availableProperties / availableClasses) and finally
  // the computed prefixed/local form.
  let label: string | undefined = undefined;
  let labelSource: "fatmap" | "computed" | undefined = undefined;

  try {
    // If the caller passed an RDFManager-like object as the registry parameter, try to read rdfs:label from its store.
    if (registry && typeof (registry as any).getStore === "function") {
      try {
        const mgr = registry as any;
        const store = mgr.getStore && mgr.getStore();
        const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
        if (store && typeof store.getQuads === "function") {
          // Preferred: direct match on rdfs:label predicate across any graph
          const lq = store.getQuads(namedNode(targetIri), namedNode(RDFS_LABEL), null, null) || [];
          if (lq.length > 0 && lq[0].object && (lq[0].object as any).value) {
            label = String((lq[0].object as any).value);
            labelSource = "computed";
          } else {
            // Fallback: fetch all quads for the subject and heuristically find a label-like predicate
            const all = store.getQuads(namedNode(targetIri), null, null, null) || [];
            const found = (all || []).find((qq: any) => {
              try {
                const pv = (qq && qq.predicate && (qq.predicate as any).value) || "";
                if (!pv) return false;
                const pvl = String(pv).toLowerCase();
                return pvl === RDFS_LABEL || pvl.endsWith("/rdfs#label") || pvl.endsWith("#label") || /rdfs[#/]label$/.test(pv) || pvl.includes("rdfs:label");
              } catch (_) {
                return false;
              }
            });
            if (found && found.object && (found.object as any).value) {
              label = String((found.object as any).value);
              labelSource = "computed";
            }
          }
        }
      } catch (_) {
        /* ignore label read failures */
      }
    }
  } catch (_) { /* ignore outer */ }

  const props = opts && Array.isArray(opts.availableProperties) ? opts.availableProperties : undefined;
  if (!label && props && props.length > 0) {
    const match = props.find((p) => String((p && (p.iri || p.key)) || "") === String(targetIri));
    if (match && (match.label || match.name)) {
      label = String(match.label || match.name);
      labelSource = "fatmap";
    }
  }
  const classes = opts && Array.isArray(opts.availableClasses) ? opts.availableClasses : undefined;
  if (!label && classes && classes.length > 0) {
    const match = classes.find((c) => String((c && c.iri) || "") === String(targetIri));
    if (match && match.label) {
      label = String(match.label);
      labelSource = "fatmap";
    }
  }

  if (!label) {
    label = prefixed;
    labelSource = "computed";
  }

  return {
    iri: targetIri,
    prefixed,
    short: local,
    namespace: prefix || "",
    tooltipLines: [local],
    color,
    label,
    labelSource,
  };
}
