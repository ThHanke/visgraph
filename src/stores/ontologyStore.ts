/**
 * @fileoverview Ontology Store
 * Manages loaded ontologies, knowledge graphs, and validation for the application.
 * Provides centralized state management for RDF/OWL data and graph operations.
 */

/* eslint-disable */

import { create } from "zustand";
import { RDFManager, rdfManager } from "../utils/rdfManager";
import { useAppConfigStore } from "./appConfigStore";
import { debug, info, warn, error, fallback } from "../utils/startupDebug";
import { WELL_KNOWN } from "../utils/wellKnownOntologies";
import { DataFactory, Quad } from "n3";
import { toast } from "sonner";
import { buildPaletteMap } from "../components/Canvas/core/namespacePalette";
import { RDF_TYPE, RDFS_LABEL, OWL_ONTOLOGY, OWL_IMPORTS } from "../constants/vocabularies";
import {
  ensureDefaultRegistry,
  DEFAULT_NAMESPACE_ENTRY,
  DEFAULT_NAMESPACE_PREFIX,
  DEFAULT_NAMESPACE_URI,
} from "../constants/namespaces";
import { shortLocalName, toPrefixed } from "../utils/termUtils";
import {
  assertArray,
  assertPlainObject,
  invariant,
  isPlainObject,
} from "../utils/guards";
import {
  normalizeNumber,
  normalizeOptionalString,
  normalizeStringArray,
} from "../utils/normalizers";
const { namedNode, quad, blankNode, literal } = DataFactory;

type SerializedQuad = {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
};

type QuadFilter = { subject?: string; predicate?: string; object?: string };

interface SerializedQuadPage {
  items: SerializedQuad[];
  total: number | null;
  limit: number | null;
}

interface RdfPageFetcher {
  fetchQuadsPage: (
    graph: string,
    offset: number,
    limit: number,
    options: { serialize: true; filter?: QuadFilter },
  ) => Promise<unknown>;
}

function assertRdfPageFetcher(value: unknown, context: string): asserts value is RdfPageFetcher {
  invariant(
    value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).fetchQuadsPage === "function",
    `${context} must expose fetchQuadsPage(graph, offset, limit, options)`,
    { value },
  );
}

function normalizeQuadFilter(filter: QuadFilter | undefined): QuadFilter | undefined {
  if (typeof filter === "undefined") return undefined;
  assertPlainObject(filter, "quad filter must be a plain object");
  const normalized: QuadFilter = {};
  if (Object.prototype.hasOwnProperty.call(filter, "subject")) {
    const subject = normalizeOptionalString(filter.subject, "filter.subject");
    if (subject) normalized.subject = subject;
  }
  if (Object.prototype.hasOwnProperty.call(filter, "predicate")) {
    const predicate = normalizeOptionalString(filter.predicate, "filter.predicate");
    if (predicate) normalized.predicate = predicate;
  }
  if (Object.prototype.hasOwnProperty.call(filter, "object")) {
    const object = normalizeOptionalString(filter.object, "filter.object", { allowEmpty: true });
    if (typeof object !== "undefined") normalized.object = object;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function coerceSerializedQuadEntry(
  value: unknown,
  fallbackGraph: string,
  context: string,
): SerializedQuad | null {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }
  const entry = value as Record<string, unknown>;
  const subject = normalizeOptionalString(entry.subject, `${context}.subject`);
  if (!subject) return null;
  const predicate =
    normalizeOptionalString(entry.predicate, `${context}.predicate`, { allowEmpty: true }) ?? "";
  const object =
    normalizeOptionalString(entry.object, `${context}.object`, { allowEmpty: true }) ?? "";
  const graph =
    normalizeOptionalString(entry.graph, `${context}.graph`, { allowEmpty: false }) ??
    fallbackGraph;
  return { subject, predicate, object, graph };
}

function normalizeSerializedQuadPage(
  raw: unknown,
  defaultGraph: string,
): SerializedQuadPage {
  assertPlainObject(raw, "fetchQuadsPage result must be a plain object");
  const page = raw as Record<string, unknown>;
  assertArray(page.items, "fetchQuadsPage.items must be an array");

  const items: SerializedQuad[] = [];
  for (const [index, entry] of (page.items as unknown[]).entries()) {
    const normalized = coerceSerializedQuadEntry(
      entry,
      defaultGraph,
      `fetchQuadsPage.items[${index}]`,
    );
    if (normalized) items.push(normalized);
  }

  let total: number | null = null;
  if (Object.prototype.hasOwnProperty.call(page, "total") && page.total !== undefined) {
    const value = normalizeNumber(page.total, "fetchQuadsPage.total", { min: 0 });
    total = Math.trunc(value);
  }

  let limit: number | null = null;
  if (Object.prototype.hasOwnProperty.call(page, "limit") && page.limit !== undefined) {
    const value = normalizeNumber(page.limit, "fetchQuadsPage.limit", { min: 1 });
    limit = Math.max(1, Math.trunc(value));
  }

  return { items, total, limit };
}

async function fetchSerializedQuads(
  mgr: any,
  graphName: string,
  filter?: QuadFilter,
  pageSize = 2000,
): Promise<SerializedQuad[]> {
  assertRdfPageFetcher(mgr, "rdfManager");
  const graph =
    normalizeOptionalString(graphName, "fetchSerializedQuads.graphName") ?? "urn:vg:data";
  const limit = Math.max(1, Math.trunc(normalizeNumber(pageSize, "fetchSerializedQuads.pageSize", { min: 1 })));
  const normalizedFilter = normalizeQuadFilter(filter);

  const results: SerializedQuad[] = [];

  let offset = 0;
  let total: number | null = null;

  while (true) {
    const rawPage = await mgr.fetchQuadsPage(graph, offset, limit, {
      serialize: true,
      ...(normalizedFilter ? { filter: normalizedFilter } : {}),
    });
    const page = normalizeSerializedQuadPage(rawPage, graph);
    if (page.items.length === 0) break;
    results.push(...page.items);

    offset += page.items.length;
    if (page.total !== null && offset >= page.total) break;

    const expectedPageSize = page.limit ?? limit;
    if (page.items.length < expectedPageSize) break;
  }

  return results;
}

async function fetchSerializedQuadsAcrossGraphs(
  mgr: any,
  graphNames: string[],
  filter?: QuadFilter,
  pageSize = 2000,
): Promise<SerializedQuad[]> {
  const normalizedGraphs = Array.from(
    new Set(
      normalizeStringArray(
        graphNames,
        "fetchSerializedQuadsAcrossGraphs.graphNames",
      ),
    ),
  );
  const combined: SerializedQuad[] = [];
  const seen = new Set<string>();
  for (const graph of normalizedGraphs) {
    const quads = await fetchSerializedQuads(mgr, graph, filter, pageSize);
    for (const q of quads) {
      const key = `${q.graph}::${q.subject}::${q.predicate}::${q.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(q);
    }
  }
  return combined;
}


/*
  Deferred namespace registration:

  Do NOT eagerly register all WELL_KNOWN prefixes at startup. Prefix registration
  is best-effort and should be performed opportunistically when an ontology or
  RDF content is actually loaded. Registering everything upfront populates the
  RDF manager with prefixes that may never be used and pollutes UI components
  that rely on the RDF manager as the single source of truth.

  Registration will occur on-demand via ensureNamespacesPresent(...) at the
  points where we already add parsed namespaces or when a well-known ontology
  entry is explicitly recognized during load. This keeps the RDF manager's
  namespace map aligned with actual usage.
*/

// Opt-in debug logging for call-graph / instrumentation.
// Enable via environment variable VG_CALL_GRAPH_LOGGING=true or via the app config
// store property `callGraphLogging` (useful for tests).
function shouldLogCallGraph(): boolean {
  try {
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.VG_CALL_GRAPH_LOGGING === "true"
    )
      return true;
  } catch (_) {
    try {
      if (typeof fallback === "function") {
        fallback("emptyCatch", { error: String(_) });
      }
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const cfg = useAppConfigStore.getState();
    if (cfg && (cfg as any).callGraphLogging) return true;
  } catch (_) {
    try {
      if (typeof fallback === "function") {
        fallback("emptyCatch", { error: String(_) });
      }
    } catch (_) {
      /* ignore */
    }
  }

  return false;
}

function logCallGraph(...args: any[]) {
  if (shouldLogCallGraph()) {
    ((...__vg_args) => {
      try {
        debug("console.debug", {
          args: __vg_args.map((a: any) =>
            a && (a as any).message ? (a as any).message : String(a),
          ),
        });
      } catch (_) {
        try {
          if (typeof fallback === "function") {
            fallback("emptyCatch", { error: String(_) });
          }
        } catch (_) {
          /* ignore */
        }
      }
      console.debug(...__vg_args);
    })("[vg-call-graph]", ...args);
  }
}

/**
 * Lightweight types used across this store to avoid pervasive `any`.
 * These model the parsed RDF output and the shapes used by the UI.
 */
type LiteralProperty = { key: string; value: string; type?: string };
type AnnotationPropertyShape = {
  property?: string;
  key?: string;
  value?: string;
  type?: string;
  propertyUri?: string;
};

type ParsedNode = {
  id: string;
  uri?: string;
  iri?: string;
  namespace?: string;
  classType?: string;
  rdfType?: string;
  rdfTypes?: string[];
  entityType?: string;
  individualName?: string;
  literalProperties?: LiteralProperty[];
  annotationProperties?: (
    | AnnotationPropertyShape
    | { propertyUri: string; value: string; type?: string }
  )[];
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  [k: string]: unknown;
};

type ParsedEdge = {
  id?: string;
  source: string;
  target: string;
  propertyType?: string;
  propertyUri?: string;
  label?: string;
  namespace?: string;
  rdfType?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
};

type DiagramNode = Record<string, any>;
type DiagramEdge = Record<string, any>;

/**
 * Compare two ontology URLs for equivalence for deduplication purposes.
 * Comparison is scheme-agnostic (treats http/https as equivalent) but preserves
 * the remainder of the IRI including trailing slashes, fragments and queries.
 * This function is used only for duplicate-detection; it does NOT rewrite stored URLs.
 */
function urlsEquivalent(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  try {
    const sa = String(a || "").trim();
    const sb = String(b || "").trim();
    if (!sa || !sb) return sa === sb;
    const ra = sa.replace(/^https?:\/\//i, "");
    const rb = sb.replace(/^https?:\/\//i, "");
    return ra === rb;
  } catch (_) {
    try {
      return String(a) === String(b);
    } catch {
      return false;
    }
  }
}

interface OntologyClass {
  iri: string;
  label: string;
  namespace: string;
  properties: string[];
  restrictions: Record<string, any>;
}

interface ObjectProperty {
  iri: string;
  label: string;
  domain: string[];
  range: string[];
  namespace: string;
}

interface LoadedOntology {
  url: string;
  name?: string;
  classes: OntologyClass[];
  properties: ObjectProperty[];
  namespaces: Record<string, string>;
  aliases?: string[]; // optional list of alias URLs (scheme/variant) for the same ontology
  // Optional named graph where the ontology/data was stored (e.g. 'urn:vg:ontologies' or 'urn:vg:data')
  graphName?: string;
  // How the entry was introduced:
  // 'requested' - user requested / explicit load
  // 'fetched'   - autoload/fetch finished and was registered
  // 'discovered' - inferred/canonicalized from parsed namespaces
  // 'auto'      - auto-loaded vocabularies (rdf/rdfs/owl)
  source?: "requested" | "fetched" | "discovered" | "auto" | string;
  // Optional fields to indicate the result of an attempted load (useful for UI / diagnostics)
  loadStatus?: "ok" | "fail" | "pending";
  loadError?: string;
}

/**
 * Normalize a URI for consistent comparison and storage.
 * Converts http:// to https://, parses URL if possible, otherwise trims and removes trailing slashes.
 */
function normalizeOntologyUri(u: string): string {
  if (typeof u === "string" && u.trim().toLowerCase().startsWith("http://")) {
    return u.trim().replace(/^http:\/\//i, "https://");
  }
  try {
    return new URL(String(u)).toString();
  } catch {
    return String(u).trim().replace(/\/+$/, "");
  }
}

/**
 * Add a valid IRI candidate to a set if it matches the IRI pattern.
 */
function addIriCandidate(value: unknown, targetSet: Set<string>): void {
  if (!value) return;
  const trimmed = String(value).trim();
  if (!trimmed) return;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(trimmed)) {
    targetSet.add(trimmed);
  }
}

/**
 * Extract namespace from an IRI by matching up to the last # or /.
 * Returns empty string if no namespace delimiter is found.
 */
function extractNamespace(iri: string | unknown): string {
  const nsMatch = String(iri || "").match(/^(.*[\/#])/);
  return nsMatch && nsMatch[1] ? String(nsMatch[1]) : "";
}

function filterNamespacesToCandidates(
  nsMap: Record<string, string>,
  iriCandidates?: Set<string>,
  existingRegistry?: { prefix: string; namespace: string; color?: string }[],
): Record<string, string> {
  const seeded: Record<string, string> = {};
  if (Array.isArray(existingRegistry)) {
    for (const entry of existingRegistry) {
      if (entry && typeof entry.prefix === "string" && entry.prefix.length > 0 &&
          typeof entry.namespace === "string" && entry.namespace.length > 0) {
        seeded[entry.prefix] = entry.namespace;
      }
    }
  }
  if (!nsMap || typeof nsMap !== "object") return seeded;
  if (!iriCandidates || iriCandidates.size === 0) return { ...seeded, ...nsMap };
  const iriList = Array.from(iriCandidates).filter(iri => typeof iri === "string" && iri.trim().length > 0);
  if (iriList.length === 0) return { ...nsMap };
  const filtered: Record<string, string> = { ...seeded };
  for (const [prefix, namespace] of Object.entries(nsMap)) {
    if (typeof namespace !== "string" || namespace.length === 0) continue;
    if (iriList.some(iri => iri.startsWith(namespace))) filtered[prefix] = namespace;
  }
  return filtered;
}

/**
 * Sync the rdfManager namespace map into the ontology store's namespaceRegistry.
 * Called by rdfManager whenever its prefix map changes (file load, user setNamespaces).
 * Preserves existing colors; assigns palette colors for new prefixes.
 */
export function syncNamespaceRegistryFromRdfManager(
  nsMap: Record<string, string>,
  iriCandidates?: Set<string>,
): void {
  try {
    const state = useOntologyStore.getState() as any;
    const existingRegistry: Array<{ prefix: string; namespace: string; color: string }> =
      Array.isArray(state.namespaceRegistry) ? state.namespaceRegistry : [];
    const filteredNsMap = filterNamespacesToCandidates(nsMap, iriCandidates, existingRegistry);
    const prefixes = Object.keys(filteredNsMap).sort();
    const paletteMap = buildPaletteMap(prefixes);
    const colorMap = new Map(existingRegistry.map((e: any) => [e.prefix, e.color ?? '']));
    const registry = prefixes.map(p => ({
      prefix: p,
      namespace: filteredNsMap[p],
      color: colorMap.get(p) || String(paletteMap[p] ?? ''),
    }));
    if (typeof state.setNamespaceRegistry === "function") {
      state.setNamespaceRegistry(registry);
    }
  } catch (err) {
    // ignore
  }
}

type LoadResult =
  | { success: true; url: string; canonicalUrl?: string }
  | { success: false; url: string; error: string };

interface ValidationError {
  nodeId: string;
  message: string;
  severity: "error" | "warning";
}

interface OntologyStore {
  loadedOntologies: LoadedOntology[];
  validationErrors: ValidationError[];
  rdfManager: RDFManager;
  // incremented whenever the ontology store is updated from the RDF store
  ontologiesVersion: number;

  // Minimal currentGraph snapshot used by tests/UI seeding
  currentGraph: {
    nodes: (ParsedNode | DiagramNode)[];
    edges: (ParsedEdge | DiagramEdge)[];
  };
  // Setter for currentGraph (used by tests / UI helpers)
  setCurrentGraph: (
    nodes: (ParsedNode | DiagramNode)[],
    edges: (ParsedEdge | DiagramEdge)[],
  ) => void;

  // Update a single entity in the RDF store (annotationProperties, rdfTypes).
  // Returns a Promise to allow async rdfManager implementations; tests call this as async.
  updateNode: (entityUri: string, updates: any) => Promise<void>;

  loadOntology: (url: string, options?: { autoload?: boolean; discovered?: boolean }) => Promise<LoadResult>;
  loadOntologyFromRDF: (
    rdfContent: string,
    onProgress?: (progress: number, message: string) => void,
    preserveGraph?: boolean,
    graphName?: string,
    filename?: string,
  ) => Promise<void>;
  loadKnowledgeGraph: (
    source: string,
    options?: {
      onProgress?: (progress: number, message: string) => void;
      timeout?: number;
      filename?: string;
      apiKey?: string;
      apiKeyHeader?: string;
    },
  ) => Promise<void>;
  loadAdditionalOntologies: (
    ontologyUris: string[],
    onProgress?: (progress: number, message: string) => void,
  ) => Promise<void>;
  discoverReferencedOntologies?: (
    options?: {
      graphName?: string;
      load?: false | "async" | "sync";
      timeoutMs?: number;
      concurrency?: number;
      onProgress?: (p: number, message: string) => void;
    },
  ) => Promise<{
    candidates: string[];
    results?: { url: string; status: "ok" | "fail"; error?: string }[];
  }>;
  clearOntologies: () => void;
  exportGraph: (format: "turtle" | "json-ld" | "rdf-xml") => Promise<string>;
  getRdfManager: () => RDFManager;
  removeLoadedOntology: (url: string) => void;
  // Namespace registry (joined prefix -> namespace -> color) persisted after reconcile
  namespaceRegistry: { prefix: string; namespace: string; color: string }[];
  setNamespaceRegistry: (registry: { prefix: string; namespace: string; color: string }[]) => void;
}
export const useOntologyStore = create<OntologyStore>((set, get) => ({
  loadedOntologies: [],
  validationErrors: [],
  rdfManager: rdfManager,
  // incremented whenever the ontology store is updated from the RDF store
  ontologiesVersion: 0,
  // persisted namespace registry (joined prefix, namespace, color) populated after reconcile
  namespaceRegistry: [{ ...DEFAULT_NAMESPACE_ENTRY }],
  setNamespaceRegistry: (registry: { prefix: string; namespace: string; color: string }[]) => {
    try {
      const nextRegistry = ensureDefaultRegistry(
        Array.isArray(registry) ? registry : [],
      ).map((entry) => ({
        prefix: entry.prefix,
        namespace: entry.namespace,
        color: entry.color ?? "",
      }));
      set(() => ({
        namespaceRegistry: nextRegistry,
      }));
    } catch (_) {
      try {
        const fallbackRegistry = ensureDefaultRegistry([]).map((entry) => ({
          prefix: entry.prefix,
          namespace: entry.namespace,
          color: entry.color ?? "",
        }));
        set({ namespaceRegistry: fallbackRegistry });
      } catch (_) { void 0; }
    }
  },

  // Minimal currentGraph state kept for compatibility with tests and UI seeding.
  currentGraph: { nodes: [], edges: [] },

  // Setter used by tests and editors to seed or update the displayed graph snapshot.
  setCurrentGraph: (nodes: (ParsedNode | DiagramNode)[], edges: (ParsedEdge | DiagramEdge)[]) => {
    try {
      set({ currentGraph: { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] } });
    } catch (_) {
      try { set({ currentGraph: { nodes: [], edges: [] } }); } catch (_) { void 0; }
    }
  },

  // Public helper to persist node-level updates. Prefers rdfManager.updateNode when available.
  updateNode: async (entityUri: string, updates: any) => {
    {
      if (!entityUri || !updates) return;
      const mgr = get().rdfManager;
      if (mgr && typeof (mgr as any).updateNode === "function") {
        try {
          // delegate to manager implementation if present
          await (mgr as any).updateNode(String(entityUri), updates);
          return;
        } catch (_) {
          // fallback to local apply
        }
      }

      // Fallback: build adds array and apply to urn:vg:data (best-effort)
      try {
        const adds: any[] = [];
        const ann = Array.isArray(updates.annotationProperties) ? updates.annotationProperties : [];
        for (const ap of ann) {
          try {
            const predRaw = (ap && (ap.propertyUri || ap.property || ap.key)) || "";
            const pred = typeof mgr?.expandPrefix === "function" && predRaw ? mgr.expandPrefix(String(predRaw)) : String(predRaw);
            if (!pred) continue;

            // Prefer provided native Term if present; otherwise build a Term from the value.
            let objTerm: any = undefined;
            try {
              if (ap && ap.objectTerm && (ap.objectTerm.termType || ap.objectTerm.termType === 0)) {
                objTerm = ap.objectTerm;
              } else {
                const v = ap && ap.value !== undefined && ap.value !== null ? String(ap.value) : "";
                if (/^_:/i.test(v)) {
                  objTerm = blankNode(String(v).replace(/^_:/, ""));
                } else if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) {
                  objTerm = namedNode(v);
                } else {
                  objTerm = literal(v);
                }
              }
            } catch (_) {
              objTerm = literal(String(ap && ap.value || ""));
            }

            adds.push({ subject: String(entityUri), predicate: String(pred), object: objTerm });
          } catch (_) { /* ignore per-item */ }
        }
        const types = Array.isArray(updates.rdfTypes) ? updates.rdfTypes : [];
        for (const t of types) {
          try {
            const rdfTypePred =
              mgr && typeof mgr.expandPrefix === "function"
                ? mgr.expandPrefix("rdf:type")
                : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
            const expanded =
              mgr && typeof mgr.expandPrefix === "function"
                ? mgr.expandPrefix(String(t))
                : String(t);
            if (expanded) {
              adds.push({ subject: String(entityUri), predicate: String(rdfTypePred), object: String(expanded) });
            }
          } catch (_) { /* ignore per-type */ }
        }

        if (adds.length > 0) {
          if (mgr && typeof (mgr as any).applyBatch === "function") {
            await (mgr as any).applyBatch({ removes: [], adds }, "urn:vg:data");
          } else if (mgr && typeof (mgr as any).addTriple === "function") {
            for (const a of adds) {
              try { (mgr as any).addTriple(String(a.subject), String(a.predicate), String(a.object), "urn:vg:data"); } catch (_) { void 0; }
            }
          }
        }
      } catch (_) { /* ignore fallback failures */ }
    }
  },

  loadOntology: async (url: string, options?: { autoload?: boolean; discovered?: boolean }) => {
    logCallGraph?.("loadOntology:start", url);
    const autoload = !!(options && (options as any).autoload);
    const discovered = !!(options && (options as any).discovered);
    try {
      const { rdfManager: mgr } = get();

      // normalize requested URL (http -> https, trim)
      const normRequestedUrl = normalizeOntologyUri(url);
      let canonicalNorm: string | undefined = undefined;

      // If well-known, register a lightweight entry so UI shows it immediately
      const wkEntry =
        WELL_KNOWN.ontologies[
          normRequestedUrl as keyof typeof WELL_KNOWN.ontologies
        ] || WELL_KNOWN.ontologies[url as keyof typeof WELL_KNOWN.ontologies];

      if (wkEntry) {
        try {
          set((state: any) => {
            const exists = (state.loadedOntologies || []).some((o: any) =>
              urlsEquivalent(o.url, normRequestedUrl),
            );
            if (exists) return {};
              const meta: LoadedOntology = {
              url: normRequestedUrl,
              name: wkEntry.name || deriveOntologyName(String(normRequestedUrl || url)),
              classes: [],
              properties: [],
              // LoadedOntology must not be coupled to the runtime namespace map.
              // Do not populate namespaces here; namespaceRegistry is authoritative.
              namespaces: {},
              source: wkEntry && (wkEntry as any).isCore ? "auto" : "requested",
              graphName: "urn:vg:ontologies",
              // mark placeholder as pending so consumers know this load is in-flight
              loadStatus: "pending",
            };
            return {
              loadedOntologies: [...(state.loadedOntologies || []), meta],
              ontologiesVersion: (state.ontologiesVersion || 0) + 1,
            };
          });
        } catch (_) { /* ignore */ }
      }

      // Delegate fetching/parsing/loading to rdfManager.loadRDFFromUrl
      try {
        if (mgr && typeof (mgr as any).loadRDFFromUrl === "function") {
          await (mgr as any).loadRDFFromUrl(normRequestedUrl, "urn:vg:ontologies", { timeoutMs: 15000 });
        } else {
          // fallback to module-level manager
          await (rdfManager as any).loadRDFFromUrl(normRequestedUrl, "urn:vg:ontologies", { timeoutMs: 15000 });
        }
      } catch (err) {
        warn(
          "ontology.load.failed",
          { url: normRequestedUrl, error: String(err) },
          { caller: true },
        );
        // Mark any placeholder entry as failed so UI shows the failed import rather than silently keeping a pending placeholder.
        try {
          set((s: any) => {
            const list = Array.isArray(s.loadedOntologies) ? (s.loadedOntologies || []).slice() : [];
            let updated = false;
            const norm = (function (u: string) {
              try { return new URL(String(u)).toString(); } catch { return String(u).trim().replace(/\/+$/, ""); }
            })(normRequestedUrl);
            const mapped = (list || []).map((o: any) => {
              try {
                if (urlsEquivalent(o.url, norm)) {
                  updated = true;
                  return { ...o, loadStatus: "fail", loadError: String(err && err.message ? err.message : String(err)) };
                }
              } catch (_) {/* noop */}
              return o;
            });
            if (!updated) {
              // Insert a failed placeholder entry for diagnostics
              const meta: LoadedOntology = {
                url: norm,
                name: deriveOntologyName(String(norm || "")),
                classes: [],
                properties: [],
                namespaces: {},
                aliases: undefined,
                source: "fetched",
                graphName: "urn:vg:ontologies",
                loadStatus: "fail",
                loadError: String(err && err.message ? err.message : String(err)),
              } as any;
              mapped.push(meta);
            }
            return {
              loadedOntologies: mapped,
              ontologiesVersion: (s.ontologiesVersion || 0) + 1,
            };
          });
        } catch (_) { /* ignore state update failures */ }
        return { success: false, url: normRequestedUrl, error: String(err && err.message ? err.message : String(err)) };
      }

      // After a successful fetch/parse, register the fetched URL as a primary entry if not already present
      try {
        set((s: any) => {
          try {
            const list = Array.isArray(s.loadedOntologies) ? (s.loadedOntologies || []).slice() : [];
            const norm = (function (u: string) {
              try { return new URL(String(u)).toString(); } catch { return String(u).trim().replace(/\/+$/, ""); }
            })(normRequestedUrl);
            
            // Check if the fetched URL is already registered
            const alreadyRegistered = (list || []).some((o: any) => {
              try {
                return urlsEquivalent(o.url, norm);
              } catch (_) {
                return String(o.url) === String(norm);
              }
            });
            
            // Update existing entry if found, otherwise create new entry for the fetched URL
            const mapped = (list || []).map((o: any) => {
              try {
                if (urlsEquivalent(o.url, norm)) {
                  return { ...o, loadStatus: "ok", loadError: undefined };
                }
              } catch (_) {/* noop */}
              return o;
            });
            
            // If not already registered, add the fetched URL as a new entry
            if (!alreadyRegistered) {
              // Check if this is a well-known core ontology
              const wkForFetched = WELL_KNOWN.ontologies[norm as keyof typeof WELL_KNOWN.ontologies];
              const isAutoCore = wkForFetched && (wkForFetched as any).isCore;

              const meta: LoadedOntology = {
                url: norm,
                name: deriveOntologyName(String(norm || "")),
                classes: [],
                properties: [],
                namespaces: {},
                source: isAutoCore ? "auto" : (discovered ? "discovered" : (autoload ? "fetched" : "requested")),
                graphName: "urn:vg:ontologies",
                loadStatus: "ok",
                loadError: undefined,
              };
              console.debug("[VG_DEBUG] loadOntology.registerFetchedUrl", {
                url: norm,
                name: meta.name,
                source: meta.source,
                autoload,
                isAutoCore,
              });
              mapped.push(meta);
            }
            
            return {
              loadedOntologies: mapped,
              ontologiesVersion: (s.ontologiesVersion || 0) + 1,
            };
          } catch (_) {
            return {};
          }
        });
      } catch (_) { /* ignore */ }

      // The fetched URL has already been registered above - no additional discovery needed
      // We only register actual fetched ontology URLs, not arbitrary owl:Ontology subjects from data

      // After a successful ontology load via loadOntology (explicit user request),
      // re-emit subject-level notifications for the data graph so UI consumers
      // receive updated subject events. Do NOT emit for autoloaded ontology loads.
      try {
        if (!autoload) {
          try {
            const mgrInst = get().rdfManager;
            if (mgrInst && typeof (mgrInst as any).emitAllSubjects === "function") {
              await (mgrInst as any).emitAllSubjects();
            } else if (typeof rdfManager !== "undefined" && typeof (rdfManager as any).emitAllSubjects === "function") {
              await (rdfManager as any).emitAllSubjects();
            }
          } catch (e) {
            try {
              if (typeof fallback === "function") {
                fallback("ontology.emitAllSubjects.failed", {
                  url: normRequestedUrl,
                  error: String(e),
                });
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
      } catch (_) {
        /* ignore overall emit failures */
      }

      return { success: true, url: normRequestedUrl, canonicalUrl: canonicalNorm };
    } catch (error: any) {
      try {
        fallback(
          "console.error",
          {
            args: [error && error.message ? error.message : String(error)],
          },
          { level: "error", captureStack: true },
        );
      } catch (_) { /* ignore */ }
      throw error;
    }
  },

  loadOntologyFromRDF: async (
    rdfContent: string,
    onProgress?: (progress: number, message: string) => void,
    preserveGraph: boolean = true,
    graphName?: string,
    filename?: string,
  ) => {
    logCallGraph?.("loadOntologyFromRDF:start", {
      length: (rdfContent || "").length,
    });
    try {
      const { rdfManager } = get();

      onProgress?.(10, "Starting RDF parsing...");

      try {
        // Enforce an explicit target graph so callers that omit graphName do not
        // accidentally write ontology triples into the default/data graph.
        // Conservative defaulting:
        //  - if preserveGraph === true => ontology graph
        //  - if preserveGraph === false => data graph
        let targetGraph = graphName;
        if (!targetGraph) {
          targetGraph = preserveGraph ? "urn:vg:ontologies" : "urn:vg:data";
          try {
            console.warn(
              `[VG] loadOntologyFromRDF: graphName omitted, defaulting to ${targetGraph}`,
            );
          } catch (_) {
            /* ignore */
          }
        }

        await rdfManager.loadRDFIntoGraph(rdfContent, targetGraph, undefined, filename);

        // Debug: report triple count after parser load using manager graph counts
        try {
          if (rdfManager && typeof (rdfManager as any).getGraphCounts === "function") {
            const counts = await (rdfManager as any).getGraphCounts();
            const tripleCount =
              counts && typeof counts === "object"
                ? Object.values(counts).reduce((acc: number, val: any) => {
                    return acc + (typeof val === "number" && Number.isFinite(val) ? val : 0);
                  }, 0)
                : -1;
            console.debug("[VG_DEBUG] rdfManager.loadRDFIntoGraph.tripleCount", { tripleCount });
          }
        } catch (_) { /* ignore debug failures */ }
      } catch (loadErr) {
        warn(
          "rdfManager.loadIntoGraph.failed",
          {
            error:
              loadErr && (loadErr as any).message
                ? (loadErr as any).message
                : String(loadErr),
          },
          { caller: true },
        );
      }


    } catch (error: any) {
      ((...__vg_args) => {
        try {
          fallback(
            "console.error",
            {
              args: __vg_args.map((a: any) =>
                a && (a as any).message ? (a as any).message : String(a),
              ),
            },
            { level: "error", captureStack: true },
          );
        } catch (_) {
          /* ignore */
        }
        console.error("Failed to load ontology from RDF:", error);
      })();
      throw error;
    }
  },

  // Backwards-compatible alias used by many tests: loadOntologyRDFtoGraph
  loadOntologyRDFtoGraph: async (
    rdfContent: string,
    graphName?: string,
    preserveGraph: boolean = true,
  ) => {
    // Delegate to the canonical loader to preserve behavior.
    try {
      return await (get().loadOntologyFromRDF as any)(rdfContent, undefined, preserveGraph, graphName);
    } catch (err) {
      // Re-throw so callers/tests receive same failure semantics.
      throw err;
    }
  },

  loadKnowledgeGraph: async (
    source: string,
    options?: {
      onProgress?: (progress: number, message: string) => void;
      timeout?: number;
      filename?: string;
      apiKey?: string;
      apiKeyHeader?: string;
    },
  ) => {
    logCallGraph?.("loadKnowledgeGraph:start", source);
    const timeout = options?.timeout || 30000;


    try {
      // If source is a URL, delegate fetching/parsing to rdfManager and then run a single authoritative fat-map rebuild.
      if (source.startsWith("http://") || source.startsWith("https://")) {
        options?.onProgress?.(10, "Loading RDF from URL via RDF manager...");

        const mgrInstance = get().rdfManager || (typeof rdfManager !== "undefined" ? rdfManager : null);
        if (!mgrInstance) throw new Error("No RDF manager available to load URL");

        // Delegate fetch + parse + store insertion to rdfManager; it will handle formats and prefix merging.
        await (mgrInstance as any).loadRDFFromUrl(source, "urn:vg:data", {
          timeoutMs: timeout,
          apiKey: options?.apiKey,
          apiKeyHeader: options?.apiKeyHeader,
        });
        // (mgrInstance as any).addNamespace(":", String(source));

        // Intentionally do NOT request a canvas layout here.
        // Layout must be driven by the canvas' own one-shot flag (forceLayoutNextMappingRef)
        // which is set by the caller that initiated a data-graph load (e.g. onLoadFile or startup rdfUrl).
        // Calling the global layout trigger here caused races that prevented the canvas from
        // honouring the original flag-based layout scheduling.

        // Ensure the canvas is requested to force layout on next mapping run for explicit data-graph loads.
        if (typeof window !== "undefined" && typeof (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING === "function") {
          (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING();
        }

        // After manager insertion, request the RDF manager to emit subject-level notifications
        // so the canvas sees the newly inserted data and can schedule the mapping run itself.
        try {
          const mgrInstEmit = get().rdfManager;
          if (mgrInstEmit && typeof (mgrInstEmit as any).emitAllSubjects === "function") {
            await (mgrInstEmit as any).emitAllSubjects();
          } else if (typeof rdfManager !== "undefined" && typeof (rdfManager as any).emitAllSubjects === "function") {
            await (rdfManager as any).emitAllSubjects();
          }
        } catch (_) { /* ignore emit failures - mapping will still occur via other signals */ }

        // After manager insertion, perform the authoritative fat-map rebuild once.
        options?.onProgress?.(100, "RDF loaded");
        // Attempt to discover and synchronously load referenced ontologies for URL loads (startup/rdfUrl)
        try {
          if (typeof (get().discoverReferencedOntologies) === "function") {
            try {
              // Run discovery asynchronously to avoid blocking the UI/startup flow.
              // Previously this used `load: "sync"` which awaited completion and could
              // block the main thread for slow network loads. Switching to async
              // lets discovery run in the background and improves responsiveness.
              await (get().discoverReferencedOntologies as any)({
                load: "async",
                timeoutMs: 10000,
                graphName: "urn:vg:data",
                onProgress: options?.onProgress,
              });
            } catch (e) {
              console.debug("[VG_DEBUG] discoverReferencedOntologies (async) failed", e);
            }
          }
        } catch (e) {
          /* ignore overall discovery failures */
        }
        return;
      }

      // Otherwise treat source as inline RDF content and reuse existing path.
      await get().loadOntologyFromRDF(
        source,
        options?.onProgress,
        true,
        "urn:vg:data",
        options?.filename,
      );
      // (get().rdfManager as any).addNamespace(":", "http://file.local");
      options?.onProgress?.(100, "RDF loaded");
      // After loading inline RDF into the data graph, request subject-level emissions so the canvas
      // mapping pipeline receives the newly inserted quads and can trigger mapping + layout as requested.
      // Request the canvas to force layout on next mapping run for this explicit inline data load.
      if (typeof window !== "undefined" && typeof (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING === "function") {
        (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING();
      }
      try {
        const mgrInstEmit = get().rdfManager;
        if (mgrInstEmit && typeof (mgrInstEmit as any).emitAllSubjects === "function") {
          try { await (mgrInstEmit as any).emitAllSubjects(); } catch (_) { /* ignore */ }
        } else if (typeof rdfManager !== "undefined" && typeof (rdfManager as any).emitAllSubjects === "function") {
          try { await (rdfManager as any).emitAllSubjects(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore overall emit failures */ }
      // Discover referenced ontologies and load them asynchronously for inline loads (do not block)
      try {
        if (typeof (get().discoverReferencedOntologies) === "function") {
          try {
            (get().discoverReferencedOntologies as any)({
              load: "async",
              graphName: "urn:vg:data",
              onProgress: options?.onProgress,
            });
          } catch (e) {
            console.debug("[VG_DEBUG] discoverReferencedOntologies (async) invocation failed", e);
          }
        }
      } catch (e) {
        /* ignore discovery invocation failures */
      }
    } catch (error: any) {
      try {
        fallback(
          "console.error",
          { args: ["Failed to load knowledge graph:", String(error)] },
          { level: "error" },
        );
      } catch (_) {
        /* ignore */
      }
      throw error;
    }
  },

  loadAdditionalOntologies: async (
    ontologyUris: string[],
    onProgress?: (progress: number, message: string) => void,
  ) => {
    logCallGraph?.(
      "loadAdditionalOntologies:start",
      ontologyUris && ontologyUris.length,
    );
    const { loadedOntologies } = get();
    const alreadyLoaded = new Set(loadedOntologies.map((o) => o.url));

    const alreadyLoadedNorm = new Set(
      Array.from(alreadyLoaded).map((u) => normalizeOntologyUri(String(u))),
    );

    const toLoad = ontologyUris.filter((uri) => {
      const norm = normalizeOntologyUri(uri);
      return !alreadyLoadedNorm.has(norm);
    });

    if (toLoad.length === 0) {
      onProgress?.(100, "No new ontologies to load");
      return;
    }

    onProgress?.(95, `Loading ${toLoad.length} additional ontologies...`);

    for (let i = 0; i < toLoad.length; i++) {
      const uri = toLoad[i];
      const wkEntry =
        WELL_KNOWN.ontologies[
          normalizeOntologyUri(uri) as keyof typeof WELL_KNOWN.ontologies
        ];
      const ontologyName = wkEntry ? wkEntry.name : undefined;

      try {
        onProgress?.(
          95 + Math.floor((i / toLoad.length) * 5),
          `Loading ${ontologyName || uri}...`,
        );
        await get().loadOntology(uri, { autoload: true });
      } catch (error: any) {
        try {
          fallback(
            "console.warn",
            {
              args: [
                `Failed to load additional ontology ${uri}:`,
                String(error),
              ],
            },
            { level: "warn" },
          );
        } catch (_) {
          /* ignore */
        }
        continue;
      }
    }

    // Debug: report triple count after additional ontologies batch load
    {
      try {
        const mgr = get().rdfManager;
        if (mgr && typeof (mgr as any).getGraphCounts === "function") {
          const graphCounts = await (mgr as any).getGraphCounts();
          const tripleCount =
            graphCounts && typeof graphCounts === "object"
              ? Object.values(graphCounts).reduce((acc: number, val: any) => {
                  return acc + (typeof val === "number" && Number.isFinite(val) ? val : 0);
                }, 0)
              : -1;
          console.debug("[VG_DEBUG] loadAdditionalOntologies.batchTripleCount", { tripleCount });
        }
      } catch (_) {
        console.debug("[VG_DEBUG] loadAdditionalOntologies.batchTripleCount", { tripleCount: -1 });
      }
    }

    onProgress?.(100, "Additional ontologies loaded");
  },

  clearOntologies: () => {
    const { rdfManager } = get();
    // Clear all graphs if the method exists
    if (rdfManager && typeof (rdfManager as any).clear === 'function') {
      try {
        (rdfManager as any).clear();
      } catch (_) {
        /* ignore clear failures */
      }
    } else if (rdfManager) {
      // Fallback: try to remove specific graphs
      try {
        if (typeof (rdfManager as any).removeGraph === 'function') {
          try { (rdfManager as any).removeGraph('urn:vg:data'); } catch (_) {}
          try { (rdfManager as any).removeGraph('urn:vg:ontologies'); } catch (_) {}
        }
      } catch (_) {
        /* ignore removeGraph failures */
      }
    }
    set({
      loadedOntologies: [],
      validationErrors: [],
      currentGraph: { nodes: [], edges: [] },
    });
  },


  removeLoadedOntology: (url: string) => {
    try {
      const { rdfManager, loadedOntologies } = get();

      const remainingOntologies = (loadedOntologies || []).filter(
        (o) => o.url !== url,
      );
      const removed = (loadedOntologies || []).filter((o) => o.url === url);

      set({
        loadedOntologies: remainingOntologies,
      });

      removed.forEach((o) => {
        try {
          rdfManager.removeGraph(o.url);
        } catch (_) {
          /* ignore */
        }
      });
    } catch (err) {
      try {
        fallback(
          "ontology.removeLoaded.failed",
          { error: String(err) },
          { level: "warn" },
        );
      } catch (_) {
        /* ignore */
      }
    }
  },
  exportGraph: async (format: "turtle" | "json-ld" | "rdf-xml") => {
    // Prefer the store-bound rdfManager, but fall back to the module-level rdfManager
    // exported from utils/rdfManager in case the store was mocked without a proper instance.
    const mgrFromState = get().rdfManager;
    const mgr = mgrFromState || (typeof rdfManager !== "undefined" ? rdfManager : null);
    if (!mgr) {
      throw new Error("No RDF manager available for export");
    }

    switch (format) {
      case "turtle":
        if (typeof (mgr as any).exportToTurtle === "function") return await (mgr as any).exportToTurtle();
        return await (mgr as any).exportToTurtle();
      case "json-ld":
        if (typeof (mgr as any).exportToJsonLD === "function") return await (mgr as any).exportToJsonLD();
        return await (mgr as any).exportToJsonLD();
      case "rdf-xml":
        if (typeof (mgr as any).exportToRdfXml === "function") return await (mgr as any).exportToRdfXml();
        return await (mgr as any).exportToRdfXml();
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  },

  discoverReferencedOntologies: async (options?: {
    graphName?: string;
    load?: false | "async" | "sync";
    timeoutMs?: number;
    concurrency?: number;
    onProgress?: (p: number, message: string) => void;
  }) => {
    const opts = options || {};
    // Respect the user setting — skip discovery entirely if disabled.
    const appCfgDiscover = useAppConfigStore.getState();
    if (appCfgDiscover && appCfgDiscover.config && appCfgDiscover.config.autoDiscoverOntologies === false) {
      return { candidates: [] };
    }
    const requestedGraphName =
      typeof opts.graphName === "string" && opts.graphName.trim() ? opts.graphName : "urn:vg:data";
    const graphName = "urn:vg:data";
    const loadMode = typeof opts.load === "undefined" ? "async" : opts.load;
    const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 15000;
    const concurrency = typeof opts.concurrency === "number" ? opts.concurrency : 6;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : undefined;

    // Provide a lightweight local vgMeasureModule fallback so tests that don't
    // install the optional debug helpers do not fail. When runtime debug timing
    // is enabled (window.__VG_DEBUG_TIMINGS) the returned object will log a
    // duration entry to console; otherwise it is a no-op.
    const vgMeasureModule = ((): any => {
      try {
        // If a global helper is available, prefer it.
        if (typeof (globalThis as any).vgMeasureModule === "function") {
          return (globalThis as any).vgMeasureModule;
        }
      } catch (_) {
        /* ignore */
      }
      return (name: string, meta: any = {}) => {
        const enabled =
          typeof window !== "undefined" && (window as any).__VG_DEBUG_TIMINGS;
        if (!enabled) return { end: (_?: any) => {} };
        const now =
          typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now();
        let finished = false;
        return {
          end: (resultMeta: any = {}) => {
            if (finished) return;
            finished = true;
            try {
              const end =
                typeof performance !== "undefined" && performance.now
                  ? performance.now()
                  : Date.now();
              const entry = {
                name,
                durationMs: Math.max(0, end - now),
                ts: Date.now(),
                meta: { ...(meta || {}), ...(resultMeta || {}) },
              };
              try {
                if (typeof console !== "undefined" && console.debug) {
                  console.debug("[VG_TIMING]", entry);
                }
              } catch (_) {
                /* ignore */
              }
              try {
                if (typeof window !== "undefined" && (window as any).__VG_BLOCKING_LOGS) {
                  const buf = (window as any).__VG_BLOCKING_LOGS;
                  buf.push(entry);
                  if (Array.isArray(buf) && buf.length > 200) buf.shift();
                }
              } catch (_) { /* ignore */ }
            } catch (_) {
              /* ignore */
            }
          },
        };
      };
    })();

    const vgM = vgMeasureModule("discoverReferencedOntologies", { graphName, loadMode, timeoutMs, concurrency });

    console.debug("[VG_DEBUG] discoverReferencedOntologies.invoked", {
      graphName,
      loadMode,
      timeoutMs,
      concurrency,
      requestedGraphName,
    });

    const mgr = get().rdfManager;
    if (!mgr || typeof (mgr as any).fetchQuadsPage !== "function") {
      vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_mgr" });
      throw new Error("discoverReferencedOntologies: rdf manager unavailable for worker fetch");
    }

    // Use imported constants from vocabularies.ts

    const typeQuads = await fetchSerializedQuads(
      mgr,
      graphName,
      { predicate: RDF_TYPE },
      2000,
    );
    const importQuads = await fetchSerializedQuads(
      mgr,
      graphName,
      { predicate: OWL_IMPORTS },
      2000,
    );

    const ontologySubjects = new Set<string>();
    for (const quad of typeQuads) {
      if (!quad) continue;
      const predicate = quad.predicate ? String(quad.predicate) : "";
      if (predicate !== RDF_TYPE) continue;
      const object = quad.object ? String(quad.object) : "";
      if (object === OWL_ONTOLOGY) {
        const subject = quad.subject ? String(quad.subject) : "";
        if (subject) ontologySubjects.add(subject);
      }
    }

    const candidateSet = new Set<string>();
    const candidateSources: Record<string, string[]> = {};
    for (const quad of importQuads) {
      if (!quad) continue;
      const subject = quad.subject ? String(quad.subject) : "";
      if (!subject) continue;
      const predicate = quad.predicate ? String(quad.predicate) : "";
      if (predicate !== OWL_IMPORTS) continue;
      if (!ontologySubjects.has(subject)) continue;
      if (quad.object && typeof quad.object === "string") {
        const obj = String(quad.object);
        candidateSet.add(obj);
        (candidateSources[obj] = candidateSources[obj] || []).push(subject);
      }
    }

    const loadedOntologies = get().loadedOntologies || [];
    const alreadyLoadedNorm = new Set(
      (loadedOntologies || []).map((o: any) => normalizeOntologyUri(String(o.url)).toLowerCase()),
    );

    const blacklistedPrefixes = [
      "http://www.w3.org/2002/07/owl",
      "https://www.w3.org/2002/07/owl",
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "https://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "http://www.w3.org/2000/01/rdf-schema#",
      "https://www.w3.org/2000/01/rdf-schema#",
      "http://www.w3.org/XML/1998/namespace",
      "https://www.w3.org/XML/1998/namespace",
      "http://www.w3.org/2001/XMLSchema#",
      "https://www.w3.org/2001/XMLSchema#",
    ];

    const candidates: string[] = [];
    for (const raw of Array.from(candidateSet)) {
      const norm = normalizeOntologyUri(raw);
      if (!norm) continue;
      const normLower = norm.toLowerCase();
      if (!normLower.startsWith("http://") && !normLower.startsWith("https://")) continue;
      if (alreadyLoadedNorm.has(normLower)) continue;
      if (blacklistedPrefixes.some((prefix) => norm.startsWith(prefix))) continue;
      if (!candidates.includes(norm)) candidates.push(norm);
    }

    console.debug("[VG_DEBUG] discoverReferencedOntologies.candidates", {
      graph: graphName,
      requestedGraphName,
      candidates,
      sources: candidateSources,
    });

    if (candidates.length === 0) {
      vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_candidates", candidateCount: 0 });
      return { candidates };
    }

    if (loadMode === false) {
      vgM && typeof vgM.end === "function" && vgM.end({ reason: "loadMode_false", candidateCount: candidates.length });
      return { candidates };
    }

    // Sequentially load candidates so we can track progress and surface errors.
    const results: { url: string; status: "ok" | "fail"; error?: string }[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      const pct = Math.min(95, Math.round(((i) / Math.max(1, candidates.length)) * 90) + 5);
      onProgress && onProgress(pct, `Loading referenced ontology ${i + 1}/${candidates.length}: ${deriveOntologyName(url)}`);
      const loadRes = await get().loadOntology(url, { autoload: true, discovered: true });
      if (!loadRes || (loadRes as any).success !== true) {
        const errMsg = loadRes && (loadRes as any).error ? String((loadRes as any).error) : `Load failed for ${url}`;
        results.push({ url, status: "fail", error: errMsg });
        // Ensure UI progress finishes on failure so callers don't remain stuck at an intermediate percent
        try {
          if (typeof onProgress === "function") {
            try {
              onProgress(100, `Failed loading referenced ontology: ${deriveOntologyName(url)}`);
            } catch (_) {
              try { onProgress(100, "Discovery failed"); } catch (_) { /* ignore */ }
            }
          }
        } catch (_) {
          /* ignore progress errors */
        }
        // Surface the error to the caller instead of swallowing it.
        vgM && typeof vgM.end === "function" && vgM.end({ reason: "candidate_failed", url, error: errMsg });
        throw new Error(errMsg);
      }
      results.push({ url, status: "ok" });
    }

    // After all candidates processed, emit a single authoritative subject emission for the data graph.
    onProgress && onProgress(95, "Emitting subject updates to canvas...");
    const mgrInst = get().rdfManager;
    if (!mgrInst || typeof (mgrInst as any).emitAllSubjects !== "function") {
      vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_mgr_emit" });
      throw new Error("discoverReferencedOntologies: no rdfManager.emitAllSubjects available");
    }
    await (mgrInst as any).emitAllSubjects("urn:vg:data");
    onProgress && onProgress(100, "Discovery complete");

    vgM && typeof vgM.end === "function" && vgM.end({ reason: "complete", resultsCount: results.length });
    return { candidates, results };
  },

  getRdfManager: () => {
    const { rdfManager } = get();
    return rdfManager;
  },
}));

// Module-level namespace initialization: attempt to register the default namespace
// if not already present. This is best-effort only; if the worker is not initialized
// (common in tests), silently skip this initialization. Tests and application code
// will initialize the worker explicitly as needed.
try {
  // Check if the worker is initialized before attempting namespace operations
  if (rdfManager && typeof (rdfManager as any).isInitialized === 'function') {
    const initialized = (rdfManager as any).isInitialized();
    if (initialized) {
      const existingNamespaces =
        typeof rdfManager.getNamespaces === "function" ? rdfManager.getNamespaces() : {};
      if (
        existingNamespaces === null ||
        typeof existingNamespaces !== "object" ||
        !Object.prototype.hasOwnProperty.call(existingNamespaces, DEFAULT_NAMESPACE_PREFIX)
      ) {
        rdfManager.setNamespaces(
          { [DEFAULT_NAMESPACE_PREFIX]: DEFAULT_NAMESPACE_URI },
          { replace: false },
        );
      }
    }
  }
} catch (_) {
  /* ignore initialization failures - worker may not be ready in test environments */
}
/**
 * Derive a user-friendly ontology name.
 */
function deriveOntologyName(url: string): string {
  {
    const wkOnt = (WELL_KNOWN && (WELL_KNOWN as any).ontologies) || {};
    if (wkOnt[url] && wkOnt[url].name) return wkOnt[url].name;
    for (const [ontUrl, meta] of Object.entries(wkOnt)) {
      try {
        const m = meta as any;
        if (
          m &&
          m.aliases &&
          Array.isArray(m.aliases) &&
          m.aliases.includes(url)
        ) {
          return m.name || String(ontUrl);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  try {
    // Derive a human-friendly name directly from the URL (synchronous).
    // Avoid any async operations here - callers should run discovery when needed.
    let label = String(url || "");
    label = label.replace(/\.(owl|rdf|ttl|jsonld|json)$/i, "");
    label = label
      .replace(/[-_.]+v?\d+(\.\d+)*$/i, "")
      .replace(/\d{4}-\d{2}-\d{2}$/i, "");
    try {
      label = decodeURIComponent(label);
    } catch (_) {
      /* ignore decode failures */
    }
    label = label.replace(/[_\-\+\.]/g, " ");
    label = label.replace(/([a-z])([A-Z])/g, "$1 $2");
    label = label.replace(/\s+/g, " ").trim();
    if (!label) return "Custom Ontology";
    label = label
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return label || "Custom Ontology";
  } catch (_) {
    return "Custom Ontology";
  }
}
