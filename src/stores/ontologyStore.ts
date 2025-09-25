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
import { computeTermDisplay } from "../utils/termUtils";
import { generateEdgeId } from "../components/Canvas/core/edgeHelpers";
import { DataFactory, Quad } from "n3";
import { buildPaletteMap } from "../components/Canvas/core/namespacePalette";
const { namedNode, quad } = DataFactory;

/**
 * Map to track in-flight RDF loads so identical loads return the same Promise.
 * Keyed by the raw RDF content or source identifier.
 */
const inFlightLoads = new Map<string, Promise<any>>();

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
  // 'core'      - core vocabularies (rdf/rdfs/owl)
  source?: "requested" | "fetched" | "discovered" | "core" | string;
}

interface ValidationError {
  nodeId: string;
  message: string;
  severity: "error" | "warning";
}

interface OntologyStore {
  loadedOntologies: LoadedOntology[];
  availableClasses: OntologyClass[];
  availableProperties: ObjectProperty[];
  validationErrors: ValidationError[];
  rdfManager: RDFManager;
  // incremented whenever availableProperties/availableClasses are updated from the RDF store
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

  loadOntology: (url: string) => Promise<void>;
  loadOntologyFromRDF: (
    rdfContent: string,
    onProgress?: (progress: number, message: string) => void,
    preserveGraph?: boolean,
    graphName?: string,
  ) => Promise<void>;
  loadKnowledgeGraph: (
    source: string,
    options?: {
      onProgress?: (progress: number, message: string) => void;
      timeout?: number;
    },
  ) => Promise<void>;
  loadAdditionalOntologies: (
    ontologyUris: string[],
    onProgress?: (progress: number, message: string) => void,
  ) => Promise<void>;
  getCompatibleProperties: (
    sourceClass: string,
    targetClass: string,
  ) => ObjectProperty[];
  clearOntologies: () => void;
  exportGraph: (format: "turtle" | "json-ld" | "rdf-xml") => Promise<string>;
  reconcileQuads: (quads: any[] | undefined) => Promise<void>;
  getRdfManager: () => RDFManager;
  removeLoadedOntology: (url: string) => void;
  // Namespace registry (joined prefix -> namespace -> color) persisted after reconcile
  namespaceRegistry: { prefix: string; namespace: string; color: string }[];
  setNamespaceRegistry: (registry: { prefix: string; namespace: string; color: string }[]) => void;
}

export const useOntologyStore = create<OntologyStore>((set, get) => ({
  loadedOntologies: [],
  availableClasses: [],
  availableProperties: [],
  validationErrors: [],
  rdfManager: rdfManager,
  // incremented whenever availableProperties/availableClasses are updated from the RDF store
  ontologiesVersion: 0,
  // persisted namespace registry (joined prefix, namespace, color) populated after reconcile
  namespaceRegistry: [],
  setNamespaceRegistry: (registry: { prefix: string; namespace: string; color: string }[]) => {
    try {
      set((st: any) => ({
        namespaceRegistry: Array.isArray(registry) ? registry.slice() : [],
      }));
    } catch (_) {
      try { set({ namespaceRegistry: [] }); } catch (_) {}
    }
  },

  // Minimal currentGraph state kept for compatibility with tests and UI seeding.
  currentGraph: { nodes: [], edges: [] },

  // Setter used by tests and editors to seed or update the displayed graph snapshot.
  setCurrentGraph: (nodes: (ParsedNode | DiagramNode)[], edges: (ParsedEdge | DiagramEdge)[]) => {
    try {
      set({ currentGraph: { nodes: Array.isArray(nodes) ? nodes : [], edges: Array.isArray(edges) ? edges : [] } });
    } catch (_) {
      try { set({ currentGraph: { nodes: [], edges: [] } }); } catch (_) {}
    }
  },

  // Public helper to persist node-level updates. Prefers rdfManager.updateNode when available.
  updateNode: async (entityUri: string, updates: any) => {
    try {
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
            adds.push({ subject: String(entityUri), predicate: String(pred), object: String(ap.value) });
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
              try { (mgr as any).addTriple(String(a.subject), String(a.predicate), String(a.object), "urn:vg:data"); } catch (_) {}
            }
          } else {
            // last-resort direct store writes
            try {
              const store = mgr && typeof mgr.getStore === "function" ? mgr.getStore() : null;
              const g = namedNode("urn:vg:data");
              if (store && typeof store.getQuads === "function" && typeof store.addQuad === "function") {
                for (const a of adds) {
                  try {
                    const subjT = namedNode(String(a.subject));
                    const predT = namedNode(String(a.predicate));
                    const objT = DataFactory.literal(String(a.object));
                    const exists = store.getQuads(subjT, predT, objT, g) || [];
                    if (!exists || exists.length === 0) {
                      try { store.addQuad(DataFactory.quad(subjT, predT, objT, g)); } catch (_) {}
                    }
                  } catch (_) { /* ignore per-add */ }
                }
              }
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore fallback failures */ }
    } catch (_) {
      /* swallow errors to keep tests robust */
    }
  },

  loadOntology: async (url: string) => {
    logCallGraph?.("loadOntology:start", url);
    try {
      const { rdfManager: mgr } = get();

      // Normalize URL (reuse existing logic)
      const normRequestedUrl = (function (u: string) {
        try {
          const s = String(u).trim();
          if (s.toLowerCase().startsWith("http://")) {
            return s.replace(/^http:\/\//i, "https://");
          }
          try {
            return new URL(s).toString();
          } catch {
            return s.replace(/\/+$/, "");
          }
        } catch (_) {
          return String(u || "");
        }
      })(url);

      const wkEntry =
        WELL_KNOWN.ontologies[
          normRequestedUrl as keyof typeof WELL_KNOWN.ontologies
        ] || WELL_KNOWN.ontologies[url as keyof typeof WELL_KNOWN.ontologies];

      // If well-known, register a lightweight LoadedOntology record immediately.
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
              namespaces: wkEntry.namespaces || {},
              source: wkEntry && (wkEntry as any).isCore ? "core" : "requested",
              graphName: "urn:vg:ontologies",
            };
            return {
              loadedOntologies: [...(state.loadedOntologies || []), meta],
              ontologiesVersion: (state.ontologiesVersion || 0) + 1,
            };
          });
        } catch (_) {
          /* ignore registration failure */
        }
      }

      // Use rdfManager.loadFromUrl (centralized fetch + detection) when available
      let fetched: { content: string; mimeType: string | null } | null = null;
      try {
        if (mgr && typeof (mgr as any).loadFromUrl === "function") {
          fetched = await (mgr as any).loadFromUrl(normRequestedUrl, { timeoutMs: 15000 });
        } else {
          // fallback to direct fetch with Accept header
          const resp = await fetch(normRequestedUrl, {
            headers: { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
          });
          if (!resp || !resp.ok) {
            warn(
              "ontology.fetch.failed",
              { url: normRequestedUrl, status: resp ? resp.status : "NO_RESPONSE" },
              { caller: true },
            );
            return;
          }
          const mimeType = resp.headers.get("content-type")?.split(";")[0].trim() || null;
          const content = await resp.text();
          fetched = { content, mimeType };
        }
      } catch (e) {
        warn(
          "ontology.fetch.failed",
          { url: normRequestedUrl, error: e && (e as any).message ? (e as any).message : String(e) },
          { caller: true },
        );
        return;
      }

      if (!fetched || !fetched.content) return;

      const { content, mimeType } = fetched;
      const looksLikeHtml =
        /^\s*<!doctype\s+/i.test(content) ||
        /^\s*<html\b/i.test(content) ||
        (mimeType && mimeType.includes("html"));
      if (looksLikeHtml) {
        try { console.debug("[VG] loadOntology: fetched content appears to be HTML — skipping RDF parse for", normRequestedUrl); } catch (_) {}
        return;
      }

      // Load RDF into the ontology graph (authoritative parser in rdfManager)
      const targetGraph = "urn:vg:ontologies";
      try {
        if (mgr && typeof (mgr as any).loadRDFIntoGraph === "function") {
          await (mgr as any).loadRDFIntoGraph(content, targetGraph, mimeType || undefined);
        } else {
          // fallback to module-level rdfManager
          await (rdfManager as any).loadRDFIntoGraph(content, targetGraph, mimeType || undefined);
        }
      } catch (err) {
        warn(
          "ontology.load.parse.failed",
          {
            url: normRequestedUrl,
            error: err && (err as any).message ? (err as any).message : String(err),
          },
          { caller: true },
        );
      }

      return;
    } catch (error: any) {
      try {
        fallback(
          "console.error",
          {
            args: [error && error.message ? error.message : String(error)],
          },
          { level: "error", captureStack: true },
        );
      } catch (_) {
        /* ignore */
      }
      throw error;
    }
    
  },


  getCompatibleProperties: (sourceClass: string, targetClass: string) => {
    const { availableProperties } = get();

    return availableProperties.filter((prop) => {
      const domainMatch =
        prop.domain.length === 0 || prop.domain.includes(sourceClass);
      const rangeMatch =
        prop.range.length === 0 || prop.range.includes(targetClass);
      return domainMatch && rangeMatch;
    });
  },

  loadOntologyFromRDF: async (
    rdfContent: string,
    onProgress?: (progress: number, message: string) => void,
    preserveGraph: boolean = true,
    graphName?: string,
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

        await rdfManager.loadRDFIntoGraph(rdfContent, targetGraph);
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

      const { computeParsedFromStore } = await import(
        "../utils/parsedFromStore"
      );
      const parsed = await computeParsedFromStore(
        rdfManager,
        graphName
          ? graphName
          : preserveGraph
            ? "urn:vg:ontologies"
            : "urn:vg:data",
      );

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

  loadKnowledgeGraph: async (
    source: string,
    options?: {
      onProgress?: (progress: number, message: string) => void;
      timeout?: number;
    },
  ) => {
    logCallGraph?.("loadKnowledgeGraph:start", source);
    const timeout = options?.timeout || 30000;

    try {
      let rdfContent: string;

      if (source.startsWith("http://") || source.startsWith("https://")) {
        options?.onProgress?.(10, "Fetching RDF from URL...");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeout);

        try {
          const candidateUrls = source.startsWith("http://")
            ? [source.replace(/^http:\/\//, "https://"), source]
            : [source];
          let response: Response | null = null;
          let lastFetchError: any = null;
          for (const candidate of candidateUrls) {
            try {
              response = await fetch(candidate, {
                signal: controller.signal,
                headers: {
                  Accept:
                    "text/turtle, application/rdf+xml, application/ld+json, */*",
                },
              });
              break;
            } catch (err) {
              lastFetchError = err;
              try {
                fallback(
                  "console.warn",
                  { args: [`Fetch failed for ${candidate}:`, String(err)] },
                  { level: "warn" },
                );
              } catch (_) {
                /* ignore */
              }
            }
          }

          if (!response || !response.ok) {
            const fetchErr =
              lastFetchError || new Error(`Failed to fetch RDF from ${source}`);
            throw fetchErr;
          }

          const contentLength = response.headers.get("content-length");
          if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
            throw new Error(
              "File too large (>10MB). Please use a smaller file.",
            );
          }

          rdfContent = await response.text();
          options?.onProgress?.(20, "RDF content downloaded");
        } catch (error: any) {
          if (error.name === "AbortError") {
            throw new Error(
              `Request timed out after ${timeout / 1000} seconds. The file might be too large.`,
            );
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        rdfContent = source;
      }

      await get().loadOntologyFromRDF(
        rdfContent,
        options?.onProgress,
        true,
        "urn:vg:data",
      );

      // Note: configured additional ontologies are auto-loaded on application startup.
      // Do not attempt to auto-load additional ontologies here to avoid duplicate loads.
      // Keep callers informed via progress callback.
      options?.onProgress?.(
        100,
        "Configured ontology auto-load handled at application startup (skipping here)",
      );
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

    function normalizeUri(u: string): string {
      try {
        if (
          typeof u === "string" &&
          u.trim().toLowerCase().startsWith("http://")
        ) {
          return u.trim().replace(/^http:\/\//i, "https://");
        }
        return new URL(String(u)).toString();
      } catch {
        return typeof u === "string"
          ? String(u).trim().replace(/\/+$/, "")
          : String(u);
      }
    }

    const appCfg = useAppConfigStore.getState();
    const disabled =
      appCfg &&
      appCfg.config &&
      Array.isArray(appCfg.config.disabledAdditionalOntologies)
        ? appCfg.config.disabledAdditionalOntologies
        : [];
    const disabledNorm = new Set(disabled.map((d) => normalizeUri(d)));
    const alreadyLoadedNorm = new Set(
      Array.from(alreadyLoaded).map((u) => normalizeUri(String(u))),
    );

    const toLoad = ontologyUris.filter((uri) => {
      const norm = normalizeUri(uri);
      return !alreadyLoadedNorm.has(norm) && !disabledNorm.has(norm);
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
          normalizeUri(uri) as keyof typeof WELL_KNOWN.ontologies
        ];
      const ontologyName = wkEntry ? wkEntry.name : undefined;

      try {
        onProgress?.(
          95 + Math.floor((i / toLoad.length) * 5),
          `Loading ${ontologyName || uri}...`,
        );

        if (wkEntry) {
          try {
            // Ensure well-known namespaces are present in the RDF manager.
            ensureNamespacesPresent(get().rdfManager, wkEntry.namespaces || {});
          } catch (_) {
            /* ignore */
          }

          // Delegate to the canonical load path so the ontology is fetched/parsed
          // and registered consistently (no synthetic/mock registration).
          try {
            const norm = normalizeUri(uri);
            // loadOntology will perform canonicalization and proper registration.
            // We intentionally await here to avoid racing further iterations.
            await get().loadOntology(norm);
          } catch (_) {
            /* ignore per-entry load failures */
          }
          continue;
        }

        if (uri.startsWith("http://") || uri.startsWith("https://")) {
          const candidateUrls = uri.startsWith("http://")
            ? [uri.replace(/^http:\/\//, "https://"), uri]
            : [uri];
          let fetched = false;
          let lastFetchError: any = null;

          for (const candidate of candidateUrls) {
            try {
              const response = await fetch(candidate, {
                headers: {
                  Accept:
                    "text/turtle, application/rdf+xml, application/ld+json, */*",
                },
                signal: AbortSignal.timeout(10000),
              });

              if (response && response.ok) {
                const content = await response.text();
                await get().loadOntologyFromRDF(
                  content,
                  undefined,
                  true,
                  "urn:vg:ontologies",
                );
                // Register this fetched URI as an explicit loaded ontology so UI counts reflect autoloaded entries
                try {
                  const norm = normalizeUri(uri);
                  const exists = (get().loadedOntologies || []).some(
                    (o: any) => {
                      try {
                        return String(o.url) === String(norm);
                      } catch {
                        return false;
                      }
                    },
                  );
                  if (!exists) {
                    try {
                      set((st: any) => ({
                        loadedOntologies: [
                          ...(st.loadedOntologies || []),
                          {
                            url: norm,
                            name: deriveOntologyName(norm),
                            classes: [],
                            properties: [],
                            namespaces: {},
                            source: "fetched",
                            graphName: "urn:vg:ontologies",
                          } as LoadedOntology,
                        ],
                      }));
                    } catch (_) {
                      /* ignore registration failure */
                    }
                  }
                } catch (_) {
                  /* ignore */
                }
                fetched = true;
                break;
              } else {
                lastFetchError =
                  lastFetchError ||
                  new Error(
                    `HTTP ${response ? response.status : "NO_RESPONSE"}`,
                  );
              }
            } catch (err) {
              lastFetchError = err;
              try {
                fallback(
                  "console.warn",
                  {
                    args: [
                      `Failed to fetch ontology ${candidate}:`,
                      String(err),
                    ],
                  },
                  { level: "warn" },
                );
              } catch (_) {
                /* ignore */
              }
            }
          }

          if (!fetched) {
            try {
              fallback(
                "console.warn",
                {
                  args: [
                    `Could not fetch ontology from ${uri}:`,
                    String(lastFetchError),
                  ],
                },
                { level: "warn" },
              );
            } catch (_) {
              /* ignore */
            }
            // Per policy: do not register synthetic ontology metadata on fetch failure.
            continue;
          }
        } else {
          // If it's not an http(s) URI, we treat it as inline RDF content and attempt to parse it.
          try {
            await get().loadOntologyFromRDF(
              uri,
              undefined,
              true,
              "urn:vg:ontologies",
            );
          } catch (e) {
            try {
              fallback(
                "console.warn",
                {
                  args: [
                    `Failed to parse non-http ontology content for ${uri}:`,
                    String(e),
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

    onProgress?.(100, "Additional ontologies loaded");
  },

  clearOntologies: () => {
    const { rdfManager } = get();
    rdfManager.clear();
    set({
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
      validationErrors: [],
      currentGraph: { nodes: [], edges: [] },
    });
  },

  removeLoadedOntology: (url: string) => {
    try {
      const appConfigStore = useAppConfigStore.getState();
      const { rdfManager, loadedOntologies } = get();
      try {
        if (
          appConfigStore &&
          typeof appConfigStore.addDisabledOntology === "function"
        ) {
          let norm = url;
          try {
            norm = new URL(String(url)).toString();
          } catch {
            norm = String(url).replace(/\/+$/, "");
          }
          appConfigStore.addDisabledOntology(norm);
        }
      } catch (_) {
        /* ignore */
      }

      const remainingOntologies = (loadedOntologies || []).filter(
        (o) => o.url !== url,
      );
      const removed = (loadedOntologies || []).filter((o) => o.url === url);

      const remainingClasses = (get().availableClasses || []).filter(
        (c) => !removed.some((r) => r.classes.some((rc) => rc.iri === c.iri)),
      );
      const remainingProperties = (get().availableProperties || []).filter(
        (p) =>
          !removed.some((r) => r.properties.some((rp) => rp.iri === p.iri)),
      );

      set({
        loadedOntologies: remainingOntologies,
        availableClasses: remainingClasses,
        availableProperties: remainingProperties,
      });

      removed.forEach((o) => {
        try {
          rdfManager.removeGraph(o.url);
        } catch (_) {
          /* ignore */
        }
        Object.entries(o.namespaces || {}).forEach(([p, ns]) => {
          try {
            rdfManager.removeNamespaceAndQuads(ns);
          } catch (_) {
            /* ignore */
          }
        });
      });

      try {
        if (
          appConfigStore &&
          typeof appConfigStore.removeAdditionalOntology === "function"
        ) {
          try {
            appConfigStore.removeAdditionalOntology(url);
          } catch (_) {
            /* ignore */
          }
          let norm = url;
          try {
            norm = new URL(String(url)).toString();
          } catch {
            norm = String(url).replace(/\/+$/, "");
          }
          try {
            appConfigStore.removeAdditionalOntology(norm);
          } catch (_) {
            /* ignore */
          }
          try {
            if (typeof appConfigStore.addDisabledOntology === "function")
              appConfigStore.addDisabledOntology(norm);
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }
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

  reconcileQuads: async (quads: any[] | undefined): Promise<void> => {
    try {
      // Use the existing incremental reconciliation helper to update the fat map.
      // Wrap in a Promise so callers can await completion deterministically.
      try {
        await Promise.resolve(incrementalReconcileFromQuads(quads, get().rdfManager));
      } catch (e) {
        /* ignore reconciliation failures */
      }
    } catch (_) {
      /* ignore overall */
    }
  },

  getRdfManager: () => {
    const { rdfManager } = get();
    return rdfManager;
  },
}));

/**
 * Extract ontology URIs referenced in RDF content that should be loaded
 */
function incrementalReconcileFromQuads(quads: any[] | undefined, mgr?: any) {
  try {
    if (!mgr || typeof mgr.getStore !== "function") return;
    const store = mgr.getStore();
    if (!store || typeof store.getQuads !== "function") return;

    const expand =
      typeof (mgr as any).expandPrefix === "function"
        ? (s: string) => {
            try {
              return (mgr as any).expandPrefix(s);
            } catch {
              return s;
            }
          }
        : (s: string) => s;

    const RDF_TYPE = expand("rdf:type");
    const RDFS_LABEL = expand("rdfs:label");

    // Full rebuild when no quads provided
    if (!Array.isArray(quads) || quads.length === 0) {
      try {
        const allQuads = store.getQuads(null, null, null, null) || [];
        const subjects = Array.from(
          new Set(
            allQuads
              .map((q: any) => (q && q.subject && q.subject.value) || "")
              .filter(Boolean),
          ),
        );

        const propsMap: Record<string, any> = {};
        const classesMap: Record<string, any> = {};

        subjects.forEach((s) => {
          try {
            const subj = namedNode(String(s));
            const typeQuads =
              store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
            const types = Array.from(
              new Set(
                typeQuads
                  .map(
                    (q: any) =>
                      (q && q.object && (q.object as any).value) || "",
                  )
                  .filter(Boolean),
              ),
            );
            const isProp = types.some((t: string) =>
              /Property/i.test(String(t)),
            );
            const isClass = types.some((t: string) => /Class/i.test(String(t)));

            const labelQ =
              store.getQuads(subj, namedNode(RDFS_LABEL), null, null) || [];
            const label =
              labelQ.length > 0
                ? String((labelQ[0].object as any).value)
                : String(s);
            const nsMatch = String(s || "").match(/^(.*[\/#])/);
            const namespace = nsMatch && nsMatch[1] ? String(nsMatch[1]) : "";

            if (isProp) {
              propsMap[String(s)] = {
                iri: String(s),
                label,
                domain: [],
                range: [],
                namespace,
                source: "store",
              };
            }

            if (isClass) {
              classesMap[String(s)] = {
                iri: String(s),
                label,
                namespace,
                properties: [],
                restrictions: {},
                source: "store",
              };
            }
          } catch (_) {
            /* ignore per-subject errors */
          }
        });

        const mergedProps = Object.values(propsMap) as ObjectProperty[];
        const mergedClasses = Object.values(classesMap) as OntologyClass[];

        useOntologyStore.setState((st: any) => ({
          availableProperties: mergedProps,
          availableClasses: mergedClasses,
          ontologiesVersion: (st.ontologiesVersion || 0) + 1,
        }));
        // Persist a namespace registry derived from the RDF manager so the UI legend and
        // enrichment logic share a single source of truth. This is a best-effort operation.
        try {
          const nsMap = mgr && typeof (mgr as any).getNamespaces === "function" ? (mgr as any).getNamespaces() : {};
          const prefixes = Object.keys(nsMap || {}).filter(Boolean).sort();
          const paletteMap = buildPaletteMap(prefixes || []);
          const registry = (prefixes || []).map((p) => {
            try {
              return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: String((paletteMap as any)[p] || "") };
            } catch (_) {
              return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: "" };
            }
          });
          try { useOntologyStore.setState((s:any) => ({ namespaceRegistry: registry })); } catch (_) { /* ignore */ }
        } catch (_) { /* ignore registry persist failures */ }
      } catch (_) {
        /* ignore rebuild failures */
      }
      return;
    }

    // Incremental: process subjects found in the provided quads
    try {
      const subjects = Array.from(
        new Set(
          (quads || [])
            .map((q: any) => (q && q.subject && q.subject.value) || "")
            .filter(Boolean),
        ),
      );

      const classesMap: Record<string, any> = {};
      const propsMap: Record<string, any> = {};

      subjects.forEach((s) => {
        try {
          const subj = namedNode(String(s));
          const typeQuads =
            store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
          const types = Array.from(
            new Set(
              typeQuads
                .map(
                  (q: any) => (q && q.object && (q.object as any).value) || "",
                )
                .filter(Boolean),
            ),
          );
          const isClass = types.some((t: any) => /Class/i.test(String(t)));
          const isProp = types.some((t: any) => /Property/i.test(String(t)));

          const labelQ =
            store.getQuads(subj, namedNode(RDFS_LABEL), null, null) || [];
          const label =
            labelQ.length > 0
              ? String((labelQ[0].object as any).value)
              : String(s);
          const nsMatch = String(s || "").match(/^(.*[\/#])/);
          const namespace = nsMatch && nsMatch[1] ? String(nsMatch[1]) : "";

          if (isClass) {
            classesMap[String(s)] = {
              iri: String(s),
              label,
              namespace,
              properties: [],
              restrictions: {},
              source: "store",
            };
          }
          if (isProp) {
            propsMap[String(s)] = {
              iri: String(s),
              label,
              domain: [],
              range: [],
              namespace,
              source: "store",
            };
          }
        } catch (_) {
          /* ignore per-subject */
        }
      });

      useOntologyStore.setState((st: any) => {
        const existingClasses = Array.isArray(st.availableClasses)
          ? st.availableClasses
          : [];
        const classByIri: Record<string, any> = {};
        existingClasses.forEach((c: any) => {
          try {
            classByIri[String(c.iri)] = c;
          } catch (_) {}
        });
        Object.values(classesMap).forEach((c: any) => {
          try {
            classByIri[String(c.iri)] = c;
          } catch (_) {}
        });

        const existingProps = Array.isArray(st.availableProperties)
          ? st.availableProperties
          : [];
        const propByIri: Record<string, any> = {};
        existingProps.forEach((p: any) => {
          try {
            propByIri[String(p.iri)] = p;
          } catch (_) {}
        });
        Object.values(propsMap).forEach((p: any) => {
          try {
            propByIri[String(p.iri)] = p;
          } catch (_) {}
        });

        return {
          availableClasses: Object.values(classByIri),
          availableProperties: Object.values(propByIri),
          ontologiesVersion: (st.ontologiesVersion || 0) + 1,
        };
      });
      // After merging available classes/properties, persist a namespace registry snapshot
      // derived from the RDF manager so consumers (legend/enrichment) can use it.
      try {
        const nsMap = mgr && typeof (mgr as any).getNamespaces === "function" ? (mgr as any).getNamespaces() : {};
        const prefixes = Object.keys(nsMap || {}).filter(Boolean).sort();
        const paletteMap = buildPaletteMap(prefixes || []);
        const registry = (prefixes || []).map((p) => {
          try {
            return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: String((paletteMap as any)[p] || "") };
          } catch (_) {
            return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: "" };
          }
        });
        try { useOntologyStore.setState((s:any) => ({ namespaceRegistry: registry })); } catch (_) { /* ignore */ }
      } catch (_) { /* ignore registry persist failures */ }
    } catch (_) {
      /* ignore incremental failures */
    }
  } catch (_) {
    /* ignore */
  }
}

function extractReferencedOntologies(rdfContent: string): string[] {
  const ontologyUris = new Set<string>();

  const namespacePatterns = [
    /@prefix\s+\w+:\s*<([^>]+)>/g,
    /xmlns:\w+="([^"]+)"/g,
    /"@context"[^}]*"([^"]+)"/g,
  ];

  const wellKnownOntologies = Object.keys(WELL_KNOWN.ontologies);

  namespacePatterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(rdfContent)) !== null) {
      const uri = match[1];
      if (wellKnownOntologies.includes(uri)) {
        ontologyUris.add(uri);
      }
    }
  });

  try {
    const prefixToOntUrls = new Map<string, string[]>();
    const wkPrefixes = WELL_KNOWN.prefixes || {};
    const wkOnt = WELL_KNOWN.ontologies || {};

    Object.entries(wkPrefixes).forEach(([prefix, nsUri]) => {
      const urls: string[] = [];
      try {
        if ((wkOnt as any)[nsUri]) urls.push(nsUri);
      } catch (_) {
        /* ignore */
      }

      Object.entries(wkOnt).forEach(([ontUrl, meta]) => {
        try {
          const m = meta as any;
          if (m && m.namespaces && m.namespaces[prefix] === nsUri) {
            if (!urls.includes(ontUrl)) urls.push(ontUrl);
          }
          if (
            m &&
            m.aliases &&
            Array.isArray(m.aliases) &&
            m.aliases.includes(nsUri)
          ) {
            if (!urls.includes(ontUrl)) urls.push(ontUrl);
          }
        } catch (_) {
          /* ignore per-entry errors */
        }
      });

      if (urls.length > 0) prefixToOntUrls.set(prefix, urls);
    });

    for (const [prefix, urls] of prefixToOntUrls.entries()) {
      const safe = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const re = new RegExp(`\\b${safe}:`, "g");
      if (re.test(rdfContent)) {
        urls.forEach((u) => ontologyUris.add(u));
      }
    }
  } catch (_) {
    /* best-effort only */
  }

  return Array.from(ontologyUris);
}

/**
 * Derive a user-friendly ontology name.
 */
function deriveOntologyName(url: string): string {
  try {
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
  } catch (_) {
    /* ignore */
  }

  try {
    let label = "";
    try {
      const u = new URL(String(url));
      const fragment = u.hash ? u.hash.replace(/^#/, "") : "";
      const pathSeg = (u.pathname || "").split("/").filter(Boolean).pop() || "";
      label = fragment || pathSeg || u.hostname || String(url);
    } catch (_) {
      const parts = String(url).split(/[#/]/).filter(Boolean);
      label = parts.length ? parts[parts.length - 1] : String(url);
    }

    label = label.replace(/\.(owl|rdf|ttl|jsonld|json)$/i, "");
    label = label
      .replace(/[-_.]+v?\d+(\.\d+)*$/i, "")
      .replace(/\d{4}-\d{2}-\d{2}$/i, "");
    label = decodeURIComponent(label);
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

/**
 * Ensure the supplied namespaces are present in the RDF manager. Idempotent.
 */
function ensureNamespacesPresent(rdfMgr: any, nsMap?: Record<string, string>) {
  if (!nsMap || typeof nsMap !== "object") return;
  try {
    const existing =
      rdfMgr && typeof rdfMgr.getNamespaces === "function"
        ? rdfMgr.getNamespaces()
        : {};
    Object.entries(nsMap).forEach(([p, ns]) => {
      try {
        if (!existing[p] && !Object.values(existing).includes(ns)) {
          try {
            // Prefer writing a minimal RDF snippet into the store so namespaces are
            // discovered by recomputeNamespacesFromStore rather than by ad-hoc registration.
            try {
              rdfMgr
                .loadRDFIntoGraph(
                  `@prefix ${String(p)}: <${String(ns)}> . ${String(p)}:__vg_dummy a ${String(p)}:__Dummy .`,
                  "urn:vg:ontologies",
                )
                .catch(() => {});
            } catch (_) {
              /* ignore */
            }
          } catch (e) {
            try {
              if (typeof fallback === "function") {
                fallback(
                  "rdf.addNamespace.failed",
                  { prefix: p, namespace: ns, error: String(e) },
                  { level: "warn" },
                );
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
      } catch (_) {
        /* ignore individual entries */
      }
    });
  } catch (e) {
    try {
      if (typeof fallback === "function") {
        fallback("rdf.ensureNamespaces.failed", { error: String(e) });
      }
    } catch (_) {
      /* ignore */
    }
  }
}
