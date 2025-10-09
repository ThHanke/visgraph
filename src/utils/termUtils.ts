import { NamedNode } from "n3";
import { useOntologyStore } from "../stores/ontologyStore";

/**
 * Strict, store-first term utilities.
 *
 * Assumptions:
 * - The ontology store's namespaceRegistry is the canonical source of
 *   prefix -> namespace -> color entries and is always populated at runtime.
 * - availableProperties / availableClasses (fat-map) are the canonical source
 *   for labels when provided.
 *
 * This implementation intentionally omits try/catch fallbacks and RDF-manager
 * probing. Callers must ensure required registry entries and fat-map data are
 * present; otherwise explicit errors will be thrown.
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
  if (s.includes(":")) {
    return s.split(":").pop() || s;
  }
  const parts = s.split(/[#/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * Normalize registry input into RegistryEntry[].
 * Accepts:
 *  - RegistryEntry[] => returned as-is
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
 * Choose the best registry entry that matches a given IRI.
 * Prefers the longest namespace match to handle nested namespaces.
 * Returns the entry or undefined.
 */
export function findRegistryEntryForIri(targetIri: string, registry?: RegistryEntry[] | Record<string,string>): RegistryEntry | undefined {
  if (!targetIri) return undefined;
  const reg = normalizeRegistry(registry as any);
  if (!reg || reg.length === 0) return undefined;
  let best: RegistryEntry | undefined = undefined;
  for (const e of reg) {
    const uri = String(e && e.namespace || "");
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

  let reg = normalizeRegistry(registry as any);
  if (!reg || reg.length === 0) {
    const st = (useOntologyStore && (useOntologyStore as any).getState) ? (useOntologyStore as any).getState() : undefined;
    const persisted = st && Array.isArray((st as any).namespaceRegistry) ? (st as any).namespaceRegistry : undefined;
    reg = normalizeRegistry(persisted as any);
  }

  if (!reg || reg.length === 0) throw new Error(`Namespace registry is empty; cannot expand '${prefixedOrIri}'`);
  const entry = reg.find((e) => String(e.prefix) === String(prefix));
  if (!entry) throw new Error(`Unknown prefix '${prefix}' while expanding '${prefixedOrIri}'`);
  return `${entry.namespace}${local}`;
}

/**
 * Convert a full IRI into a prefixed form using the fat-map and/or registry.
 * Returns a prefixed string such as "ex:LocalName" or the full IRI if no registry match.
 */
export function toPrefixed(
  iri: string,
  availableProperties?: any[],
  availableClasses?: any[],
  registry?: RegistryEntry[] | Record<string,string>,
): string {
  if (!iri) return "";

  const props = Array.isArray(availableProperties) ? availableProperties : [];
  const classes = Array.isArray(availableClasses) ? availableClasses : [];

  // Prefer an exact fat-map match (property first, then class)
  const fatMatch =
    props.find((p: any) => String((p && (p.iri || p.key)) || "") === String(iri)) ||
    classes.find((c: any) => String((c && c.iri) || "") === String(iri));

  const reg = normalizeRegistry(registry as any) || normalizeRegistry((useOntologyStore && (useOntologyStore as any).getState && (useOntologyStore as any).getState().namespaceRegistry) || undefined);

  if (fatMatch && reg) {
    const candidateIri = String(fatMatch.iri || fatMatch.key || iri);
    const entryForFat = findRegistryEntryForIri(candidateIri, reg);
    if (entryForFat && entryForFat.namespace) {
      const local = candidateIri.startsWith(entryForFat.namespace) ? candidateIri.substring(entryForFat.namespace.length) : shortLocalName(candidateIri);
      return `${entryForFat.prefix}:${local}`;
    }
  }

  if (reg) {
    const entry = findRegistryEntryForIri(String(iri), reg);
    if (entry && entry.namespace) {
      const local = String(iri).startsWith(entry.namespace) ? String(iri).substring(entry.namespace.length) : shortLocalName(iri);
      return `${entry.prefix}:${local}`;
    }
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
  registry?: RegistryEntry[] | Record<string,string>,
  palette?: Record<string, string> | undefined,
): string | undefined {
  if (!targetIri) return undefined;

  let reg = normalizeRegistry(registry as any);
  if (!reg || reg.length === 0) {
    const st = (useOntologyStore && (useOntologyStore as any).getState) ? (useOntologyStore as any).getState() : undefined;
    const persisted = st && Array.isArray((st as any).namespaceRegistry) ? (st as any).namespaceRegistry : undefined;
    reg = normalizeRegistry(persisted as any);
  }

  const entry = reg ? findRegistryEntryForIri(String(targetIri), reg) : undefined;
  if (entry && entry.color) {
    const c = String(entry.color || "").trim();
    if (c) return c;
  }

  // Derive prefix for palette lookup when registry available
  let prefix: string | undefined = undefined;
  if (reg && reg.length > 0) {
    const e = findRegistryEntryForIri(String(targetIri), reg);
    if (e) prefix = String(e.prefix || "");
  }

  if (prefix && palette && typeof palette === "object") {
    return palette[prefix] || palette[prefix.toLowerCase()] || undefined;
  }

  return undefined;
}

/**
 * Compute a TermDisplayInfo using only namespaceRegistry and optional fat-map data (opts).
 * Throws when registry lacks a matching prefix for the IRI when a registry was explicitly provided.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
  registry?: RegistryEntry[],
  palette?: Record<string, string> | undefined,
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

  // Expand prefixed names using registry (or store registry)
  let targetIri = iri;
  if (!targetIri.includes("://")) {
    targetIri = expandPrefixed(targetIri, registry);
  }

  // Determine registry entry (use provided registry parameter when present)
  const regParamProvided = typeof registry !== "undefined" && registry !== null;
  const reg = normalizeRegistry(registry as any) || normalizeRegistry((useOntologyStore && (useOntologyStore as any).getState && (useOntologyStore as any).getState().namespaceRegistry) || undefined);
  const entry = reg ? findRegistryEntryForIri(targetIri, reg) : undefined;

  if (regParamProvided && !entry) {
    throw new Error(`No registry prefix found for IRI: ${targetIri}`);
  }

  let rawPrefix = "";
  let nsUri = "";
  let local = shortLocalName(targetIri);
  let prefixed = local;
  if (entry) {
    rawPrefix = String(entry.prefix || "");
    nsUri = String(entry.namespace || "");
    local = targetIri.startsWith(nsUri) ? targetIri.substring(nsUri.length) : shortLocalName(targetIri);
    prefixed = rawPrefix === ":" || rawPrefix === "" ? `:${local}` : (rawPrefix ? `${rawPrefix}:${local}` : local);
  }

  const prefix = rawPrefix === ":" || rawPrefix === "" ? "" : rawPrefix;

  // Color resolution
  let color: string | undefined = undefined;
  if (entry && entry.color) color = entry.color;
  if (!color && prefix && palette && typeof palette === "object") {
    color = palette[prefix] || palette[prefix.toLowerCase()] || undefined;
  }

  // Label resolution: prefer fat-map entries (availableProperties then availableClasses)
  let label: string | undefined = undefined;
  let labelSource: "fatmap" | "computed" | undefined = undefined;

  const props = opts && Array.isArray(opts.availableProperties) ? opts.availableProperties : undefined;
  if (props && props.length > 0) {
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
