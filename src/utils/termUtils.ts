import { NamedNode } from "n3";
import { useOntologyStore } from "../stores/ontologyStore";

/**
 * Strict, store-first term utilities.
 *
 * Rules:
 * - No try/catch blocks are introduced.
 * - No multi-step fallbacks or probing (rdfManager, window, etc).
 * - Canonical sources:
 *    - namespaceRegistry: useOntologyStore.getState().namespaceRegistry
 *    - fat-map: useOntologyStore.getState().availableClasses / availableProperties
 *
 * The functions accept optional overrides (registry, availableProperties, availableClasses)
 * primarily for testing convenience. When an explicit registry is provided and a requested
 * prefix/lookup cannot be resolved, an Error is thrown.
 */

/* Public type returned by computeTermDisplay */
export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  tooltipLines: string[];
  color?: string | undefined;
  label?: string | undefined;
  labelSource?: "fatmap" | "computed" | undefined;
}

type RegistryEntry = { prefix: string; namespace: string; color?: string };

/**
 * Extract local name from a URI or prefixed name.
 */
export function shortLocalName(uriOrPrefixed?: string): string {
  if (!uriOrPrefixed) return "";
  const s = String(uriOrPrefixed);
  if (s.includes("://")) {
    const parts = s.split(/[#/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
  }
  if (s.includes(":",1)) {
    return s.split(":").pop() || s;
  }
  const parts = s.split(/[#/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * Normalize registry input into RegistryEntry[].
 * Accepts:
 *  - RegistryEntry[] => returned as-is (if non-empty)
 *  - Record<string,string> => converted to array of entries (color undefined)
 *
 * Returns undefined when no usable registry can be derived.
 */
export function normalizeRegistry(input?: RegistryEntry[] | Record<string, string>): RegistryEntry[] | undefined {
  if (!input) return undefined;
  if (Array.isArray(input) && input.length > 0) return input as RegistryEntry[];
  if (typeof input === "object") {
    const entries = Object.entries(input as Record<string, string>).map(([p, ns]) => ({ prefix: String(p), namespace: String(ns) }));
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
}

/**
 * Helper: read the ontology store's current namespaceRegistry.
 * This is the canonical runtime registry.
 */
function getStoreRegistry(): RegistryEntry[] | undefined {
  const st = useOntologyStore && (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : undefined;
  const persisted = st && Array.isArray((st as any).namespaceRegistry) ? (st as any).namespaceRegistry : undefined;
  return normalizeRegistry(persisted as any) || undefined;
}

/**
 * Helper: read the ontology store fat-map arrays.
 */
function getStoreFatMap() {
  const st = useOntologyStore && (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : undefined;
  const availableProperties = st && Array.isArray((st as any).availableProperties) ? (st as any).availableProperties : [];
  const availableClasses = st && Array.isArray((st as any).availableClasses) ? (st as any).availableClasses : [];
  return { availableProperties, availableClasses };
}

/**
 * Choose the best registry entry that matches a given IRI.
 * Prefers the longest namespace match to handle nested namespaces.
 * Returns the entry or undefined.
 */
export function findRegistryEntryForIri(targetIri: string, registry?: RegistryEntry[] | Record<string,string>): RegistryEntry | undefined {
  if (!targetIri) return undefined;
  const reg = getStoreRegistry();
  if (!reg || reg.length === 0) return undefined;
  let best: RegistryEntry | undefined = undefined;
  for (const e of reg) {
    const uri = String((e && e.namespace) || "");
    if (!uri) continue;
    if (targetIri.startsWith(uri)) {
      if (!best || uri.length > String(best.namespace || "").length) best = e;
    }
  }
  return best;
}

/**
 * Expand a prefixed name using only the provided registry or the persisted
 * ontology store namespaceRegistry when registry is omitted.
 * Throws on unknown prefix or empty registry.
 */
export function expandPrefixed(prefixedOrIri: string, registry?: RegistryEntry[] | Record<string,string>): string {
  if (!prefixedOrIri) throw new Error("Empty value passed to expandPrefixed");
  if (prefixedOrIri.includes("://")) return prefixedOrIri;
  if (prefixedOrIri.startsWith("_:")) return prefixedOrIri;

  const idx = prefixedOrIri.indexOf(":");
  if (idx === -1) throw new Error(`Value '${prefixedOrIri}' is not a prefixed name`);
  const prefix = prefixedOrIri.substring(0, idx);
  const local = prefixedOrIri.substring(idx + 1);

  const reg = getStoreRegistry();

  if (!reg || reg.length === 0) throw new Error(`Namespace registry is empty; cannot expand '${prefixedOrIri}'`);

  // Find entry for the exact prefix (note: empty string "" is valid default prefix)
  const entry = reg.find((e) => String(e.prefix) === String(prefix));
  if (!entry) throw new Error(`Unknown prefix '${prefix}' while expanding '${prefixedOrIri}'`);
  return `${entry.namespace}${local}`;
}

/**
 * Convert a full IRI into a prefixed form using the fat-map and/or registry.
 * Returns a prefixed string such as "ex:LocalName" or the full IRI if no registry match.
 *
 * This function prefers explicit parameters but will fall back to the ontology store
 * canonical data when parameters are omitted.
 */

export function toPrefixed(
  iri: string,
  availableProperties?: any[],
  availableClasses?: any[],
  registry?: RegistryEntry[] | Record<string,string>,
): string {
  if (!iri) return "";

  // const props = Array.isArray(availableProperties) ? availableProperties : [];
  // const classes = Array.isArray(availableClasses) ? availableClasses : [];

  // // Prefer an exact fat-map match (property first, then class)
  // const fatMatch =
  //   props.find((p: any) => String((p && (p.iri || p.key)) || "") === String(iri)) ||
  //   classes.find((c: any) => String((c && c.iri) || "") === String(iri));

  const reg = normalizeRegistry(registry as any) || normalizeRegistry((useOntologyStore && (useOntologyStore as any).getState && (useOntologyStore as any).getState().namespaceRegistry) || undefined);


    const entry = findRegistryEntryForIri(String(iri), reg);
    if (entry && entry.namespace) {
      const local = String(iri).startsWith(entry.namespace) ? String(iri).substring(entry.namespace.length) : shortLocalName(iri);
      const p = String(entry.prefix || "");
      if (p === ":" || p === "") return `:${local}`;
      return `${p}:${local}`;
    }


  return iri;
}


/**
 * Return a palette color for a given IRI using the registry and optional palette override.
 * - If a registry entry matching the IRI exists and has a color, return that color.
 * - Otherwise, if a palette map is provided, try to find a color by prefix (case-insensitive).
 * - Returns undefined when no color can be determined.
 *
 * Registry will be read from the provided parameter or from the persisted ontology store.
 */
export function getNodeColor(
  targetIri: string,
  palette?: Record<string, string> | undefined,
): string | undefined {
  if (!targetIri) return undefined;

  // Strict: determine node color using fat-map namespace -> namespaceRegistry
  const storeFat = getStoreFatMap();
  const props = storeFat.availableProperties || [];
  const classes = storeFat.availableClasses || [];

  const fatMatch =
    props.find((p: any) => String((p && (p.iri || p.key)) || "") === String(targetIri)) ||
    classes.find((c: any) => String((c && c.iri) || "") === String(targetIri));

  if (!fatMatch) {
    // No fat-map entry -> cannot determine color from namespace. Return undefined as safe fallback.
    return undefined;
  }

  const nsUri = String((fatMatch as any).namespace || "");
  const reg = getStoreRegistry();
  if (reg && reg.length > 0) {
    const entry = reg.find((e) => String(e.namespace || "") === nsUri);
    if (entry && entry.color) {
      const c = String(entry.color || "").trim();
      if (c) return c;
    }
  }

  // If no color in registry, allow palette override keyed by prefix only if a prefix exists
  if (reg && reg.length > 0) {
    const entry = reg.find((e) => String(e.namespace || "") === nsUri);
    const prefix = entry ? String(entry.prefix || "") : undefined;
    if (prefix && palette && typeof palette === "object") {
      return palette[prefix] || palette[prefix.toLowerCase()] || undefined;
    }
  }

  return undefined;
}

/**
 * Compute a TermDisplayInfo using only namespaceRegistry and optional fat-map data (opts).
 * When an explicit registry parameter is provided and a matching entry cannot be found
 * for a given IRI/prefixed input, the function will throw to enforce a single-source assertion.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
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
      tooltipLines: [iri],
      color: undefined,
      label: iri,
      labelSource: "computed",
    };
  }

  // Expand prefixed names using store-only registry
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    targetIri = expandPrefixed(targetIri);
  }

  // Strict: fat-map is the canonical source for entity data.
  const storeFat = getStoreFatMap();
  const props = Array.isArray(opts && opts.availableProperties) ? opts!.availableProperties! : storeFat.availableProperties;
  const classes = Array.isArray(opts && opts.availableClasses) ? opts!.availableClasses! : storeFat.availableClasses;

  const fatMatch =
    (props || []).find((p: any) => String((p && (p.iri || p.key)) || "") === String(targetIri)) ||
    (classes || []).find((c: any) => String((c && c.iri) || "") === String(targetIri));

  if (!fatMatch) {
    // No fat-map entry found — return a computed fallback TermDisplayInfo using the input IRI.
    const canonicalIri = targetIri;
    const local = shortLocalName(targetIri);
    const prefixed = targetIri;
    const color = undefined;
    const label = local;
    const labelSource = "computed" as const;
    return {
      iri: canonicalIri,
      prefixed,
      short: local,
      tooltipLines: [local],
      color,
      label,
      labelSource,
    };
  }

  const canonicalIri = String(fatMatch.iri || targetIri);
  const nsUri = String((fatMatch as any).namespace || "");
  const local = shortLocalName(targetIri);

  // Lookup prefix and color live from namespaceRegistry by exact namespace match
  const reg = getStoreRegistry();
  const prefixed = toPrefixed(targetIri);
  let color: string | undefined = undefined;
  if (reg && reg.length > 0 && nsUri) {
    const entryForFat = reg.find((e) => String(e.namespace || "") === nsUri);
    if (entryForFat) {
      const prefixToken = String(entryForFat.prefix || "");
      if (entryForFat.color) {
        color = String(entryForFat.color || "").trim() || undefined;
      }
    } 
  }

  // Label resolution: fat-map is authoritative
    const label = String((fatMatch as any).label || targetIri);
    const labelSource = "fatmap" as const;

  return {
    iri: canonicalIri,
    prefixed,
    short: local,
    tooltipLines: [local],
    color,
    label,
    labelSource,
  };
}
