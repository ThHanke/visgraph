import type { NamedNode } from "n3";
import { useOntologyStore } from "../stores/ontologyStore";
import {
  assertPlainObject,
  assertString,
  invariant,
  isPlainObject,
} from "./guards";
import {
  normalizeString,
} from "./normalizers";

export interface NamespaceRegistryEntry {
  prefix: string;
  namespace: string;
  color?: string;
}

export interface FatMapEntry {
  iri: string;
  label?: string;
  namespace?: string;
  key?: string;
  color?: string;
}

type RegistryInput = NamespaceRegistryEntry[] | Record<string, string> | undefined;

interface TermDataOverrides {
  registry?: RegistryInput;
  availableProperties?: unknown;
  availableClasses?: unknown;
}

interface OntologyStoreSnapshot {
  namespaceRegistry: NamespaceRegistryEntry[];
  availableProperties: FatMapEntry[];
  availableClasses: FatMapEntry[];
}

function coerceNamespaceEntry(value: unknown, context: string): NamespaceRegistryEntry {
  assertPlainObject(value, context);
  const record = value as Record<string, unknown>;
  const prefix = normalizeString(record.prefix ?? "", `${context}.prefix`, {
    allowEmpty: true,
  });
  const namespace = normalizeString(record.namespace, `${context}.namespace`);
  const color =
    typeof record.color === "string" && record.color.trim().length > 0
      ? record.color.trim()
      : undefined;
  return { prefix, namespace, color };
}

function coerceNamespaceRegistry(
  source: RegistryInput,
  context: string,
): NamespaceRegistryEntry[] {
  if (typeof source === "undefined") return [];
  if (Array.isArray(source)) {
    return source.map((entry, index) =>
      coerceNamespaceEntry(entry, `${context}[${index}]`),
    );
  }
  if (isPlainObject(source)) {
    // Accept legacy record<string,string> inputs at boundaries (tests, adapter shims).
    return Object.entries(source as Record<string, unknown>).map(
      ([prefix, namespace]) => {
        assertString(namespace, `${context}.${prefix}`);
        return coerceNamespaceEntry(
          { prefix, namespace },
          `${context}.${prefix}`,
        );
      },
    );
  }
  throw new Error(`${context} must be an array or record of namespaces`);
}

function coerceFatMapEntry(value: unknown, context: string): FatMapEntry {
  assertPlainObject(value, context);
  const record = value as Record<string, unknown>;
  const iriCandidate =
    (typeof record.iri === "string" && record.iri.trim().length > 0
      ? record.iri
      : undefined) ??
    (typeof record.key === "string" && record.key.trim().length > 0
      ? record.key
      : undefined);
  invariant(iriCandidate, `${context} is missing an iri/key string`);
  const namespace =
    typeof record.namespace === "string" && record.namespace.trim().length > 0
      ? record.namespace.trim()
      : undefined;
  const label =
    typeof record.label === "string" && record.label.trim().length > 0
      ? record.label
      : undefined;
  const color =
    typeof record.color === "string" && record.color.trim().length > 0
      ? record.color.trim()
      : undefined;
  const key =
    typeof record.key === "string" && record.key.trim().length > 0
      ? record.key
      : undefined;
  return {
    iri: iriCandidate,
    namespace,
    label,
    color,
    key,
  };
}

function coerceFatMapEntries(source: unknown, context: string): FatMapEntry[] {
  if (typeof source === "undefined") return [];
  invariant(
    Array.isArray(source),
    `${context} must be an array of fat-map entries`,
  );
  return (source as unknown[]).map((entry, index) =>
    coerceFatMapEntry(entry, `${context}[${index}]`),
  );
}

function readOntologyStoreSnapshot(): OntologyStoreSnapshot {
  const getState =
    useOntologyStore && typeof (useOntologyStore as any).getState === "function"
      ? (useOntologyStore as any).getState
      : null;
  if (!getState) {
    return {
      namespaceRegistry: [],
      availableProperties: [],
      availableClasses: [],
    };
  }
  const state = getState() as Record<string, unknown>;
  return {
    namespaceRegistry: coerceNamespaceRegistry(
      state.namespaceRegistry as RegistryInput,
      "ontologyStore.namespaceRegistry",
    ),
    availableProperties: coerceFatMapEntries(
      state.availableProperties,
      "ontologyStore.availableProperties",
    ),
    availableClasses: coerceFatMapEntries(
      state.availableClasses,
      "ontologyStore.availableClasses",
    ),
  };
}

function resolveTermData(overrides?: TermDataOverrides): OntologyStoreSnapshot {
  let snapshot: OntologyStoreSnapshot | null = null;
  const ensureSnapshot = () => {
    if (!snapshot) snapshot = readOntologyStoreSnapshot();
    return snapshot;
  };

  const haveRegistryOverride =
    overrides && Object.prototype.hasOwnProperty.call(overrides, "registry");
  const havePropertiesOverride =
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, "availableProperties");
  const haveClassesOverride =
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, "availableClasses");

  return {
    namespaceRegistry: haveRegistryOverride
      ? coerceNamespaceRegistry(overrides!.registry, "termData.registry")
      : ensureSnapshot().namespaceRegistry,
    availableProperties: havePropertiesOverride
      ? coerceFatMapEntries(
          overrides!.availableProperties,
          "termData.availableProperties",
        )
      : ensureSnapshot().availableProperties,
    availableClasses: haveClassesOverride
      ? coerceFatMapEntries(
          overrides!.availableClasses,
          "termData.availableClasses",
        )
      : ensureSnapshot().availableClasses,
  };
}

/**
 * Extract the local name from a URI or prefixed name.
 */
export function shortLocalName(value?: string): string {
  if (!value) return "";
  const source = value.trim();
  if (!source) return "";
  const delimiters = ["#", "/", ":"];
  let position = -1;
  for (const delimiter of delimiters) {
    const idx = source.lastIndexOf(delimiter);
    if (idx > position) position = idx;
  }
  return position >= 0 ? source.slice(position + 1) : source;
}

/**
 * Normalize registry input to NamespaceRegistryEntry[] for compatibility with legacy map callers.
 */
export function normalizeRegistry(
  input?: RegistryInput,
): NamespaceRegistryEntry[] {
  return coerceNamespaceRegistry(input, "normalizeRegistry.input");
}

/**
 * Locate the registry entry whose namespace best matches the provided IRI.
 * Prefers the longest matching namespace.
 */
export function findRegistryEntryForIri(
  targetIri: string,
  registryInput?: RegistryInput,
): NamespaceRegistryEntry | undefined {
  const iri = normalizeString(targetIri, "findRegistryEntryForIri.targetIri");
  const { namespaceRegistry } = resolveTermData({
    registry: registryInput,
  });
  let winner: NamespaceRegistryEntry | undefined;
  for (const entry of namespaceRegistry) {
    if (!entry.namespace) continue;
    if (!iri.startsWith(entry.namespace)) continue;
    if (!winner || entry.namespace.length > winner.namespace.length) {
      winner = entry;
    }
  }
  return winner;
}

/**
 * Expand a prefixed name using the namespace registry.
 */
export function expandPrefixed(
  value: string,
  registryInput?: RegistryInput,
): string {
  const term = normalizeString(value, "expandPrefixed.value");
  if (term.includes("://") || term.startsWith("_:")) return term;
  const idx = term.indexOf(":");
  if (idx < 0) return term;
  const prefix = term.slice(0, idx);
  const local = term.slice(idx + 1);
  const { namespaceRegistry } = resolveTermData({ registry: registryInput });
  if (!namespaceRegistry.length) return term;
  const entry = namespaceRegistry.find((candidate) => {
    if (!candidate.namespace) return false;
    if (candidate.prefix === prefix) return true;
    if (prefix === ":" || prefix === "") {
      return candidate.prefix === ":" || candidate.prefix === "";
    }
    return false;
  });
  if (!entry) return term;
  return `${entry.namespace}${local}`;
}

/**
 * Convert an IRI into a prefixed representation using the namespace registry.
 * Returns the original IRI if no matching namespace is available.
 */
export function toPrefixed(
  iri: string,
  registryInput?: RegistryInput,
): string {
  const target = normalizeString(iri, "toPrefixed.iri");
  if (target.startsWith("_:")) return target;
  const entry = findRegistryEntryForIri(target, registryInput);
  if (!entry) return target;

  // Check if this is an exact match (entity-specific prefix, not a namespace base)
  // If the namespace exactly matches the IRI, return just the prefix with colon
  if (entry.namespace === target) {
    const prefix = entry.prefix ?? "";
    if (!prefix || prefix === ":") {
      return `:`;
    }
    return `${prefix}:`;
  }

  const local =
    target.startsWith(entry.namespace) && entry.namespace.length < target.length
      ? target.slice(entry.namespace.length)
      : shortLocalName(target);
  const prefix = entry.prefix ?? "";
  if (!prefix || prefix === ":") {
    return `:${local}`;
  }
  return `${prefix}:${local}`;
}

/**
 * Resolve a palette color for the provided IRI using the namespace registry
 * and optional palette overrides keyed by prefix.
 */
export function getNodeColor(
  targetIri: string,
  palette?: Record<string, string>,
  overrides?: TermDataOverrides,
): string | undefined {
  const iri = normalizeString(targetIri, "getNodeColor.targetIri");
  const { availableProperties, availableClasses, namespaceRegistry } =
    resolveTermData(overrides);
  const fatMatch =
    availableProperties.find((entry) => entry.iri === iri) ??
    availableClasses.find((entry) => entry.iri === iri);
  if (!fatMatch) return undefined;
  if (fatMatch.color) return fatMatch.color;
  const entry =
    namespaceRegistry.find(
      (candidate) => candidate.namespace === fatMatch.namespace,
    ) ?? findRegistryEntryForIri(iri, overrides?.registry);
  if (entry && entry.color) {
    return entry.color;
  }
  if (!palette) return undefined;
  if (!entry || !entry.prefix) return undefined;
  const prefix = entry.prefix;
  return (
    palette[prefix] ??
    palette[prefix.toLowerCase()] ??
    palette[prefix.toUpperCase()]
  );
}

export interface TermDisplayInfo {
  iri: string;
  prefixed: string;
  short: string;
  tooltipLines: string[];
  color?: string;
  label?: string;
  labelSource?: "fatmap" | "computed";
}

export interface TermDisplayOptions extends TermDataOverrides {
  palette?: Record<string, string>;
}

/**
 * Compute display metadata for an IRI or prefixed term.
 */
export function computeTermDisplay(
  iriOrTerm: string | NamedNode,
  options?: TermDisplayOptions,
): TermDisplayInfo {
  const raw = typeof iriOrTerm === "string" ? iriOrTerm : iriOrTerm.value;
  const source = normalizeString(raw, "computeTermDisplay.input");

  if (source.startsWith("_:")) {
    return {
      iri: source,
      prefixed: source,
      short: source,
      tooltipLines: [source],
      color: undefined,
      label: source,
      labelSource: "computed",
    };
  }

  let iri = source;
  if (!iri.includes("://")) {
    iri = expandPrefixed(iri, options?.registry);
  }

  const { availableProperties, availableClasses, namespaceRegistry } =
    resolveTermData(options);
  const fatMatch =
    availableProperties.find((entry) => entry.iri === iri) ??
    availableClasses.find((entry) => entry.iri === iri);

  if (!fatMatch) {
    const prefixed = toPrefixed(iri, options?.registry);
    const local = shortLocalName(iri);
    // For entity-specific prefixes (ending with :), use that as the label
    const label = prefixed.endsWith(':') ? prefixed : local;
    return {
      iri,
      prefixed,
      short: local,
      tooltipLines: [label],
      color: undefined,
      label,
      labelSource: "computed",
    };
  }

  const prefixed = toPrefixed(iri, options?.registry);
  // For entity-specific prefixes (ending with :), use that as the label
  // Otherwise use the fat-map label or fall back to short local name
  const label = prefixed.endsWith(':')
    ? prefixed
    : (fatMatch.label ?? shortLocalName(iri));
  const namespaceEntry =
    namespaceRegistry.find(
      (entry) => entry.namespace === fatMatch.namespace,
    ) ?? findRegistryEntryForIri(iri, options?.registry);
  const color =
    fatMatch.color ??
    namespaceEntry?.color ??
    (options?.palette && namespaceEntry?.prefix
      ? options.palette[namespaceEntry.prefix] ??
        options.palette[namespaceEntry.prefix.toLowerCase()] ??
        options.palette[namespaceEntry.prefix.toUpperCase()]
      : undefined);

  return {
    iri,
    prefixed,
    short: shortLocalName(prefixed || iri),
    tooltipLines: [label],
    color,
    label,
    labelSource: "fatmap",
  };
}
