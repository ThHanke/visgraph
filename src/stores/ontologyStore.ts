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
import { shortLocalName, toPrefixed } from "../utils/termUtils";
const { namedNode, quad, blankNode, literal } = DataFactory;

/* NOTE: attachPrefixed removed in favor of computing prefixed values locally
   inside the authoritative fat-map update/reconcile path so the freshly
   computed namespace registry can be passed into toPrefixed. A minimal helper
   remains for compatibility but it only returns the entries as-is; callers in
   this file are updated to compute prefixed using the registry computed at
   update time. */
function attachPrefixed(entries: any[] | undefined): any[] {
  return Array.isArray(entries) ? entries : [];
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
  // 'core'      - core vocabularies (rdf/rdfs/owl)
  source?: "requested" | "fetched" | "discovered" | "core" | string;
  // Optional fields to indicate the result of an attempted load (useful for UI / diagnostics)
  loadStatus?: "ok" | "fail" | "pending";
  loadError?: string;
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

  loadOntology: (url: string, options?: { autoload?: boolean }) => Promise<LoadResult>;
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
  getCompatibleProperties: (
    sourceClass: string,
    targetClass: string,
  ) => ObjectProperty[];
  clearOntologies: () => void;
  exportGraph: (format: "turtle" | "json-ld" | "rdf-xml") => Promise<string>;
  updateFatMap: (quads?: any[]) => Promise<void>;
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
      // Persist the provided namespace registry only. Fat-map consumers should be
      // updated via the authoritative updateFatMap/reconcile path which computes
      // prefixed fields using the registry at update time.
      set((st: any) => ({
        namespaceRegistry: Array.isArray(registry) ? registry.slice() : [],
      }));

    } catch (_) {
      try { set({ namespaceRegistry: [] }); } catch (_) { void 0; }
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
                      try { store.addQuad(DataFactory.quad(subjT, predT, objT, g)); } catch (_) { void 0; }
                    }
                  } catch (_) { void 0; }
                }
              }
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore fallback failures */ }
    }
  },

  loadOntology: async (url: string, options?: { autoload?: boolean }) => {
    logCallGraph?.("loadOntology:start", url);
    const autoload = !!(options && (options as any).autoload);
    try {
      const { rdfManager: mgr } = get();

      // normalize requested URL (http -> https, trim)
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
              source: wkEntry && (wkEntry as any).isCore ? "core" : "requested",
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
              } catch (_) {}
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

      // After a successful fetch/parse, mark any placeholder as succeeded and update any previously-registered lightweight
      // LoadedOntology entries (e.g. well-known placeholders) with the manager's
      // current namespace snapshot so consumers see the actual prefixes discovered
      // during parsing. This operation is idempotent and may be a no-op if no
      // placeholder was registered earlier.
      try {
        set((s: any) => {
          try {
            const list = Array.isArray(s.loadedOntologies) ? (s.loadedOntologies || []).slice() : [];
            const norm = (function (u: string) {
              try { return new URL(String(u)).toString(); } catch { return String(u).trim().replace(/\/+$/, ""); }
            })(normRequestedUrl);
            const mapped = (list || []).map((o: any) => {
              try {
                if (urlsEquivalent(o.url, norm)) {
                  return { ...o, loadStatus: "ok", loadError: undefined };
                }
              } catch (_) {}
              return o;
            });
            return {
              loadedOntologies: mapped,
              ontologiesVersion: (s.ontologiesVersion || 0) + 1,
            };
          } catch (_) {
            return {};
          }
        });
      } catch (_) { /* ignore */ }
          try {
            try {
              // Do not write runtime namespace snapshots into loadedOntologies.
              // loadedOntologies should only track ontology metadata (url, name, aliases, source, graphName).
              // Leave existing entries unchanged here.
              set((state: any) => {
                try {
                  // No-op update to loadedOntologies regarding namespaces; preserve existing entries.
                  return {};
                } catch (_) {
                  return {};
                }
              });
            } catch (_) { /* ignore snapshot persist failures */ }
          } catch (_) { /* ignore */ }

      // After successful load, attempt to discover declared ontology IRI in the ontologies graph
      try {
        const store =
          mgr && typeof (mgr as any).getStore === "function"
            ? (mgr as any).getStore()
            : rdfManager && typeof (rdfManager as any).getStore === "function"
            ? (rdfManager as any).getStore()
            : null;

        if (store && typeof store.getQuads === "function") {
          const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
          const OWL_ONTOLOGY = "http://www.w3.org/2002/07/owl#Ontology";
          const g = namedNode("urn:vg:ontologies");
          const ontQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(OWL_ONTOLOGY), g) || [];
          const subjects = Array.from(new Set((ontQuads || []).map((q: any) => (q && q.subject && (q.subject as any).value) || ""))).filter(Boolean);

          if (subjects.length > 0) {
            const canonical = subjects.find((s: any) => /^https?:\/\//i.test(String(s))) || subjects[0];
            const canonicalStr = canonical ? String(canonical) : "";
            try {
              canonicalNorm = new URL(canonicalStr).toString();
            } catch {
              canonicalNorm = canonicalStr.replace(/\/+$/, "");
            }

            const already = (get().loadedOntologies || []).some((o: any) => {
              try {
                return urlsEquivalent(o.url, canonicalNorm);
              } catch (_) {
                return String(o.url) === String(canonicalNorm);
              }
            });

            if (!already) {
              const aliases: string[] = [];
              try {
                if (normRequestedUrl && !urlsEquivalent(normRequestedUrl, canonicalNorm)) aliases.push(normRequestedUrl);
              } catch (_) { /* ignore */ }

              const namespaces = {};

                try {
                  set((state: any) => {
                    const meta: LoadedOntology = {
                      url: canonicalNorm,
                      name: deriveOntologyName(String(canonicalNorm || "")),
                      classes: [],
                      properties: [],
                      // Do not couple loaded ontology entries to runtime namespace snapshots.
                      namespaces: {},
                      aliases: aliases.length ? aliases : undefined,
                      source: "discovered",
                      graphName: "urn:vg:ontologies",
                      loadStatus: "ok",
                      loadError: undefined,
                    };
                    return {
                      loadedOntologies: [...(state.loadedOntologies || []), meta],
                      ontologiesVersion: (state.ontologiesVersion || 0) + 1,
                    };
                  });
                } catch (_) { /* ignore registration failures */ }
            }
          }
        }
      } catch (_) {
        /* best-effort only */
      }

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

        // Debug: report store triple count after parser load
        try {
          const store = rdfManager && typeof (rdfManager as any).getStore === "function" ? (rdfManager as any).getStore() : null;
          const tripleCount = store && typeof store.getQuads === "function" ? (store.getQuads(null, null, null, null) || []).length : -1;
          console.debug("[VG_DEBUG] rdfManager.loadRDFIntoGraph.tripleCount", { tripleCount });
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
        await (mgrInstance as any).loadRDFFromUrl(source, "urn:vg:data", { timeoutMs: timeout });
        // (mgrInstance as any).addNamespace(":", String(source));
 
        // Intentionally do NOT request a canvas layout here.
        // Layout must be driven by the canvas' own one-shot flag (forceLayoutNextMappingRef)
        // which is set by the caller that initiated a data-graph load (e.g. onLoadFile or startup rdfUrl).
        // Calling the global layout trigger here caused races that prevented the canvas from
        // honouring the original flag-based layout scheduling.
 
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
        // Use the store's updateFatMap (full rebuild) to preserve existing behavior.
        // await get().updateFatMap();
 
        // Ensure the canvas is requested to force layout on next mapping run for explicit data-graph loads.
        if (typeof window !== "undefined" && typeof (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING === "function") {
          (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING();
        }
 
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
      );
      // (get().rdfManager as any).addNamespace(":", "http://file.local");
      options?.onProgress?.(100, "RDF loaded");
      // After loading inline RDF into the data graph, request subject-level emissions so the canvas
      // mapping pipeline receives the newly inserted quads and can trigger mapping + layout as requested.
      try {
        const mgrInstEmit = get().rdfManager;
        if (mgrInstEmit && typeof (mgrInstEmit as any).emitAllSubjects === "function") {
          try { await (mgrInstEmit as any).emitAllSubjects(); } catch (_) { /* ignore */ }
        } else if (typeof rdfManager !== "undefined" && typeof (rdfManager as any).emitAllSubjects === "function") {
          try { await (rdfManager as any).emitAllSubjects(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore overall emit failures */ }
      // Request the canvas to force layout on next mapping run for this explicit inline data load.
      if (typeof window !== "undefined" && typeof (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING === "function") {
        (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING();
      }
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
      const mgr = get().rdfManager;
      const store = mgr && typeof mgr.getStore === "function" ? mgr.getStore() : null;
      const tripleCount = store && typeof store.getQuads === "function" ? (store.getQuads(null, null, null, null) || []).length : -1;
      console.debug("[VG_DEBUG] loadAdditionalOntologies.batchTripleCount", { tripleCount });
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

  // Incremental-only updateFatMap: process supplied quads and upsert into the fat-map.
  updateFatMap: async (quads?: any[]): Promise<void> => {
    // If no quads supplied, perform a full authoritative rebuild (useful for batch loads).
    if (!Array.isArray(quads) || quads.length === 0) {
      try {
        await buildFatMap(get().rdfManager);
      } catch (e) {
        try {
          if (typeof fallback === "function") {
            fallback("rdf.updateFatMap.full_rebuild_failed", { error: String(e) });
          }
        } catch (_) { /* ignore */ }
      }
      return;
    }

    const parsedQuads = quads.slice();

    // Helpers
    const normalizeTermIri = (term: any): string => {
      if (term === null || typeof term === "undefined") return "";
      if (typeof term === "object" && typeof (term as any).value === "string") return String((term as any).value).trim();
      return String(term || "").trim();
    };

    const parsedTypesBySubject: Record<string, Set<any>> = {};
    const parsedLabelBySubject: Record<string, string> = {};

    for (const q of parsedQuads) {
      const s = q && q.subject && (q.subject.value || q.subject);
      const p = q && q.predicate && (q.predicate.value || q.predicate);
      const o = q && q.object ? q.object : undefined;
      if (!s || !p) continue;
      const subj = String(s);
      const pred = String(p);
      const objTerm = typeof o !== "undefined" && o !== null ? o : undefined;

      if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" || /rdf:type$/i.test(pred)) {
        parsedTypesBySubject[subj] = parsedTypesBySubject[subj] || new Set<any>();
        parsedTypesBySubject[subj].add(objTerm);
      }

      if (pred === "http://www.w3.org/2000/01/rdf-schema#label" || /rdfs:label$/i.test(pred)) {
        if (objTerm && typeof (objTerm as any).value === "string") parsedLabelBySubject[subj] = String((objTerm as any).value);
        else if (typeof objTerm === "string") parsedLabelBySubject[subj] = String(objTerm);
      }
    }

    // Subjects are derived only from the supplied quads (strict quads-only policy).
    const subjects = Array.from(new Set(parsedQuads.map((q:any) => (q && q.subject && (q.subject.value || q.subject)) || "").filter(Boolean)));

    const classesMap: Record<string, any> = {};
    const propsMap: Record<string, any> = {};

    for (const s of subjects) {
      const subjStr = String(s);
      const parsedTypes = Array.from(parsedTypesBySubject[subjStr] || []);
      let types: any[] = parsedTypes && parsedTypes.length > 0 ? parsedTypes.slice() : [];

      // Do not fall back to the RDF manager when determining types; rely only on parsed quads.
      if (types.length === 0) {
        types = [];
      }

      const typesNormalized = Array.from(new Set((types || []).map((t) => normalizeTermIri(t)).filter(Boolean)));

      let label = parsedLabelBySubject[subjStr];
      // Do not query the RDF manager for labels; prefer parsed label or default to the short local name.
      if (!label) label = shortLocalName(subjStr);

      const nsMatch = String(subjStr || "").match(/^(.*[\/#])/);
      const namespace = nsMatch && nsMatch[1] ? String(nsMatch[1]) : "";

      const isClass = typesNormalized.some((iri: string) => {
        if (!iri) return false;
        if (iri === "http://www.w3.org/2002/07/owl#Class") return true;
        const norm = iri.replace(/[#\/]+$/, "");
        return /(^|\/|#)Class$/i.test(iri) || /Class$/i.test(norm);
      });

      const isProp = typesNormalized.some((iri: string) => {
        if (!iri) return false;
        if (iri === "http://www.w3.org/2002/07/owl#ObjectProperty" || iri === "http://www.w3.org/2002/07/owl#DatatypeProperty") return true;
        const norm = iri.replace(/[#\/]+$/, "");
        return /Property$/i.test(norm);
      });

      if (isClass) {
        classesMap[subjStr] = {
          iri: subjStr,
          label,
          namespace,
          properties: [],
          restrictions: {},
          source: "parsed",
        };
      }
      if (isProp) {
        propsMap[subjStr] = {
          iri: subjStr,
          label,
          domain: [],
          range: [],
          namespace,
          source: "parsed",
        };
      }
    }

    // Upsert: merge parsed results with existing state without deletions
    const st = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : null;
    const existingClasses = st && Array.isArray(st.availableClasses) ? st.availableClasses : [];
    const classByIri: Record<string, any> = {};
    for (const c of existingClasses) classByIri[String(c.iri)] = c;
    for (const c of Object.values(classesMap)) classByIri[String(c.iri)] = { ...(classByIri[String(c.iri)] || {}), ...(c || {}) };

    const existingProps = st && Array.isArray(st.availableProperties) ? st.availableProperties : [];
    const propByIri: Record<string, any> = {};
    for (const p of existingProps) propByIri[String(p.iri)] = p;
    for (const p of Object.values(propsMap)) propByIri[String(p.iri)] = { ...(propByIri[String(p.iri)] || {}), ...(p || {}) };

    // Compute namespace registry now so we can persist classes/properties and registry
    // in a single atomic state update. This avoids a race where consumers see an
    // updated fat-map but the namespaceRegistry is not yet persisted (causes missing colors).
    try {
      const mgr = get().rdfManager;
      const nsMap = mgr && typeof (mgr as any).getNamespaces === "function" ? (mgr as any).getNamespaces() : {};
      const prefixes = Object.keys(nsMap || []).sort();
      const paletteMap = buildPaletteMap(prefixes || []);
      const registry = (prefixes || []).map((p) => {
        try {
          return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: String((paletteMap as any)[p] || "") };
        } catch (_) {
          return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: "" };
        }
      });

    {
      const propsArr = Object.values(propByIri);
      const classesArr = Object.values(classByIri);

      const computePrefixed = (e: any) => {
        try {
          const iri = String((e && (e.iri || e.key)) || "");
          const pref = iri ? toPrefixed(String(iri), registry as any) : "";
          return { ...(e || {}), prefixed: pref && String(pref) !== String(iri) ? String(pref) : "" };
        } catch (_) {
          return { ...(e || {}), prefixed: "" };
        }
      };

      const propsWithPref = (propsArr || []).map(computePrefixed);
      const classesWithPref = (classesArr || []).map(computePrefixed);

      useOntologyStore.setState((s: any) => ({
        availableClasses: classesWithPref,
        availableProperties: propsWithPref,
        ontologiesVersion: (s.ontologiesVersion || 0) + 1,
        namespaceRegistry: registry,
      }));
    }
    } catch (_) {
      // Fallback to previous behavior if registry computation fails (attach prefixed best-effort)
      try {
        const propsArr = Object.values(propByIri);
        const classesArr = Object.values(classByIri);

        const computePrefixed = (e: any) => {
          try {
            const iri = String((e && (e.iri || e.key)) || "");
            const pref = iri ? toPrefixed(String(iri)) : "";
            return { ...(e || {}), prefixed: pref && String(pref) !== String(iri) ? String(pref) : "" };
          } catch (_) {
            return { ...(e || {}), prefixed: "" };
          }
        };

        const propsWithPref = (propsArr || []).map(computePrefixed);
        const classesWithPref = (classesArr || []).map(computePrefixed);

        useOntologyStore.setState((s: any) => ({
          availableClasses: classesWithPref,
          availableProperties: propsWithPref,
          ontologiesVersion: (s.ontologiesVersion || 0) + 1,
        }));
      } catch (_) {
        useOntologyStore.setState((s: any) => ({
          availableClasses: Object.values(classByIri),
          availableProperties: Object.values(propByIri),
          ontologiesVersion: (s.ontologiesVersion || 0) + 1,
        }));
      }
    }

    // Debug: log a small sample of availableClasses when updateFatMap runs with parsed quads.
    // Keeps output safe for tests by wrapping in try/catch and avoiding heavy object serialization.
    try {
      const _allClasses = Object.values(classByIri);
      const classesSample = (_allClasses || []).slice(0, 10).map((c: any) => ({
        iri: c.iri,
        label: c.label,
        namespace: c.namespace,
      }));
      console.debug("[VG_DEBUG] updateFatMap.availableClasses.sample", {
        total: Array.isArray(_allClasses) ? _allClasses.length : 0,
        sample: classesSample,
      });
    } catch (_) { /* ignore logging failures */ }

      

      
  },

  discoverReferencedOntologies: async (options?: {
    graphName?: string;
    load?: false | "async" | "sync";
    timeoutMs?: number;
    concurrency?: number;
    onProgress?: (p: number, message: string) => void;
  }) => {
    const opts = options || {};
    const graphName = opts.graphName || "urn:vg:data";
    const loadMode = typeof opts.load === "undefined" ? "async" : opts.load;
    const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 15000;
    const concurrency = typeof opts.concurrency === "number" ? opts.concurrency : 6;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : undefined;

    // Lightweight module-scoped timing helper for discovery (gated).
    // Mirrors the canvas helper but kept local to avoid cross-module imports.
    const initGlobalDebugLogs = () => {
      try {
        if (typeof window === "undefined") return;
        if (!(window as any).__VG_BLOCKING_LOGS) {
          (window as any).__VG_BLOCKING_LOGS = [];
          (window as any).__VG_DUMP_BLOCKING_LOGS = () =>
            (window as any).__VG_BLOCKING_LOGS.slice();
          (window as any).__VG_CLEAR_BLOCKING_LOGS = () => {
            (window as any).__VG_BLOCKING_LOGS = [];
          };
        }
      } catch (_) {
        /* ignore */
      }
    };

    const vgDebugEnabledModule = () => {
      try {
        if (typeof window !== "undefined" && (window as any).__VG_DEBUG_TIMINGS) return true;
        const cfg = useAppConfigStore.getState && useAppConfigStore.getState();
        return !!(cfg && (cfg as any).debugAll);
      } catch {
        return false;
      }
    };

    const vgMeasureModule = (name: string, meta: any = {}) => {
      if (!vgDebugEnabledModule()) return { end: (_?: any) => {} };
      initGlobalDebugLogs();
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
            } catch (_) {}
            try {
              if (typeof window !== "undefined" && (window as any).__VG_BLOCKING_LOGS) {
                const buf = (window as any).__VG_BLOCKING_LOGS;
                buf.push(entry);
                if (Array.isArray(buf) && buf.length > 200) buf.shift();
              }
            } catch (_) {}
          } catch (_) {
            // ignore
          }
        },
      };
    };

    // start a module-scoped measurement for discoverReferencedOntologies (no-op when disabled)
    const vgM = vgMeasureModule("discoverReferencedOntologies", { graphName, loadMode, timeoutMs, concurrency });

    // Immediate invocation trace so callers can see the discovery ran
    try {
      console.debug("[VG_DEBUG] discoverReferencedOntologies.invoked", { graphName, loadMode, timeoutMs, concurrency });
      try {
        // Visible notification so the user can see the discovery ran (guarded for non-browser environments)
        if (typeof window !== "undefined") {
          try {
            toast.success(`Discovering referenced ontologies (${graphName})...`);
          } catch (_) {
            /* ignore toast failures */
          }
        }
      } catch (_) {
        // ignore toast failures
      }
    } catch (_) { /* ignore logging failures */ }

    try {
      const mgr = get().rdfManager;
      if (!mgr || typeof (mgr as any).getStore !== "function") {
        try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_mgr" }); } catch (_) {}
        return { candidates: [] as string[] };
      }

      const store = (mgr as any).getStore();
      if (!store || typeof store.getQuads !== "function") {
        try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_store" }); } catch (_) {}
        return { candidates: [] as string[] };
      }

      const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const OWL_ONTOLOGY = "http://www.w3.org/2002/07/owl#Ontology";
      const OWL_IMPORTS = "http://www.w3.org/2002/07/owl#imports";
      const g = namedNode(String(graphName || "urn:vg:data"));

      // Search for ontology/import triples across all graphs so discovery picks up
      // imports regardless of whether they were inserted into urn:vg:data, urn:vg:ontologies, or other graphs.
      const ontQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(OWL_ONTOLOGY), null) || [];
      const importQuads = store.getQuads(null, namedNode(OWL_IMPORTS), null, null) || [];

      const candidateSet = new Set<string>();

      if (opts && (opts as any).includeOntologySubject) {
        for (const q of ontQuads) {
          try {
            const s = q && q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
            if (s) candidateSet.add(s);
          } catch (_) { /* ignore per-quad */ }
        }
      }

      for (const q of importQuads) {
        try {
          const o = q && q.object && (q.object as any).value ? String((q.object as any).value) : "";
          if (o) candidateSet.add(o);
        } catch (_) { /* ignore per-quad */ }
      }

      // Normalization helper (reuse existing semantics from loadAdditionalOntologies)
      function normalizeUri(u: string): string {
        try {
          if (typeof u === "string" && u.trim().toLowerCase().startsWith("http://")) {
            return u.trim().replace(/^http:\/\//i, "https://");
          }
          return new URL(String(u)).toString();
        } catch {
          return typeof u === "string" ? String(u).trim().replace(/\/+$/, "") : String(u);
        }
      }

      const appCfg = useAppConfigStore.getState();
      const disabled =
        appCfg && appCfg.config && Array.isArray(appCfg.config.disabledAdditionalOntologies)
          ? appCfg.config.disabledAdditionalOntologies
          : [];
      const disabledNorm = new Set(disabled.map((d) => normalizeUri(d)));

      const loadedOntologies = get().loadedOntologies || [];
      const alreadyLoadedNorm = new Set((loadedOntologies || []).map((o: any) => normalizeUri(String(o.url))));

      const wellKnownKeys = new Set(Object.keys(WELL_KNOWN.ontologies || {}));
      const blacklistedUris = new Set([
        "http://www.w3.org/2002/07/owl",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/XML/1998/namespace",
        "http://www.w3.org/2001/XMLSchema#",
      ]);

      const candidates: string[] = [];
      for (const raw of Array.from(candidateSet)) {
        try {
          const norm = normalizeUri(raw);
          if (!norm) continue;
          if (!/^https?:\/\//i.test(norm)) continue;
          if (disabledNorm.has(norm)) continue;
          if (alreadyLoadedNorm.has(norm)) continue;
          // exclude blacklisted core URIs
          let skip = false;
          for (const b of Array.from(blacklistedUris)) {
            if (norm.startsWith(b)) {
              skip = true;
              break;
            }
          }
          if (skip) continue;
          // dedupe preserving appearance order
          if (!candidates.includes(norm)) candidates.push(norm);
        } catch (_) { /* ignore per-candidate */ }
      }

      // debug: what we discovered
      try {
        console.debug("[VG_DEBUG] discoverReferencedOntologies.candidates", { graph: graphName, candidates });
      } catch (_) { /* ignore logging failures */ }

      if (candidates.length === 0) {
        try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "no_candidates", candidateCount: 0 }); } catch (_) {}
        return { candidates };
      }

      if (loadMode === false) {
        try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "loadMode_false", candidateCount: candidates.length }); } catch (_) {}
        return { candidates };
      }

      if (loadMode === "async") {
        // Schedule background loads for each candidate (fire-and-forget) so discovery
        // does not block the UI. Use requestIdleCallback where available and stagger
        // starts so the browser has a chance to finish rendering/close modals.
        const scheduleBackgroundLoad = (fn: () => void, delayMs = 100) => {
          try {
            if (typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function") {
              // Use requestIdleCallback to run when the browser is idle (non-blocking).
              (window as any).requestIdleCallback(
                () => {
                  try {
                    fn();
                  } catch (_) {
                    /* ignore per-task errors */
                  }
                },
                { timeout: 1000 },
              );
              return;
            }
          } catch (_) {
            // fallthrough to setTimeout fallback
          }

          try {
            setTimeout(() => {
              try {
                fn();
              } catch (_) {
                /* ignore per-task errors */
              }
            }, delayMs);
          } catch (_) {
            /* ignore scheduling failures */
          }
        };

        try {
          let idx = 0;
          for (const url of candidates) {
            const delay = 150 * idx++;
            scheduleBackgroundLoad(async () => {
              try {
                const loadRes = await get().loadOntology(url, { autoload: true });
                if (loadRes && (loadRes as any).success === true) {
                  try {
                    console.debug("[VG_DEBUG] discoverReferencedOntologies.load.ok (background)", {
                      graph: graphName,
                      url,
                      result: loadRes,
                    });
                  } catch (_) { /* ignore */ }

                  // After a successful autoload, request the RDF manager to emit subject-level notifications
                  // so the canvas mapping pipeline sees the newly inserted triples and updates nodes/edges.
                  try {
                    const mgrInst = get().rdfManager;
                    if (mgrInst && typeof (mgrInst as any).emitAllSubjects === "function") {
                      // fire-and-forget but keep a debug trace on failure
                      (mgrInst as any).emitAllSubjects().catch((e: any) => {
                        try {
                          console.debug("[VG_DEBUG] emitAllSubjects (background) failed", { graph: graphName, url, error: String(e) });
                        } catch (_) { /* ignore */ }
                      });
                    }
                  } catch (e) {
                    try {
                      console.debug("[VG_DEBUG] emitAllSubjects invocation failed", { graph: graphName, url, error: String(e) });
                    } catch (_) { /* ignore */ }
                  }
                } else {
                  const errMsg = loadRes && (loadRes as any).error ? String((loadRes as any).error) : "Unknown load failure";
                  try {
                    console.error("[VG_ERROR] discoverReferencedOntologies.load.fail (background)", {
                      graph: graphName,
                      url,
                      error: errMsg,
                      result: loadRes,
                    });
                  } catch (_) { /* ignore */ }
                }
              } catch (err) {
                try {
                  console.error("[VG_ERROR] discoverReferencedOntologies.load.exception (background)", {
                    graph: graphName,
                    url,
                    error: String(err),
                  });
                } catch (_) { /* ignore */ }
              }
            }, delay);
          }
        } catch (e) {
          try {
            console.error("[VG_ERROR] discoverReferencedOntologies.async.schedule.failed", { graph: graphName, error: String(e) });
          } catch (_) { /* ignore */ }
        }

        try {
          vgM && typeof vgM.end === "function" && vgM.end({ reason: "scheduled", scheduledCount: candidates.length });
        } catch (_) { /* ignore */ }

        return { candidates };
      }

      // loadMode === "sync" - load sequentially (bounded concurrency could be added later)
      const results: { url: string; status: "ok" | "fail"; error?: string }[] = [];
      for (const url of candidates) {
        try {
          onProgress?.(50, `Loading referenced ontology ${url}...`);
          // Use authoritative LoadResult from loadOntology instead of assuming success.
          try {
            const loadRes = await get().loadOntology(url, { autoload: true });
            if (loadRes && (loadRes as any).success === true) {
              // Successful load — push ok. The loader updated store entries already.
              console.debug("[VG_DEBUG] discoverReferencedOntologies.loaded.sync", { graph: graphName, url, result: loadRes });
              results.push({ url, status: "ok" });
            } else {
              const errMsg = loadRes && (loadRes as any).error ? String((loadRes as any).error) : "Unknown load failure";
              console.error("[VG_ERROR] discoverReferencedOntologies.load.fail.sync", { graph: graphName, url, error: errMsg, result: loadRes });
              results.push({ url, status: "fail", error: errMsg });
            }
          } catch (e: any) {
            const msg = e && e.message ? e.message : String(e);
            console.error("[VG_ERROR] discoverReferencedOntologies.load.exception.sync", { graph: graphName, url, error: msg });
            results.push({ url, status: "fail", error: msg });
          }
        } catch (err: any) {
          const msg = err && err.message ? err.message : String(err);
          results.push({ url, status: "fail", error: msg });
        }
      }

      // Report what loaded and what failed
        try {
          // Present explicit success/failure lists with human-friendly ontology names.
          const succeeded = (results || []).filter((r) => r.status === "ok").map((r) => r.url);
          const failedEntries = (results || []).filter((r) => r.status === "fail");

          // If any ontologies were loaded synchronously, re-emit subject-level events
          // so the canvas mapping pipeline picks up ontology-provided terms.
          try {
            if (Array.isArray(succeeded) && succeeded.length > 0) {
              try {
                const mgrInst = get().rdfManager || (typeof rdfManager !== "undefined" ? rdfManager : null);
                if (mgrInst && typeof (mgrInst as any).emitAllSubjects === "function") {
                  await (mgrInst as any).emitAllSubjects();
                }
              } catch (e) {
                try { console.debug("[VG_DEBUG] discoverReferencedOntologies.emitAllSubjects.failed.sync", e); } catch (_) { /* ignore */ }
              }
            }
          } catch (_) { /* ignore overall emit failures */ }
          console.debug("[VG_DEBUG] discoverReferencedOntologies.sync.results", { graph: graphName, results });
          if (typeof window !== "undefined") {
            try {
                if (succeeded.length > 0) {
                const names = succeeded.map((u) => deriveOntologyName(String(u || "")));
                toast.success(`Successfully loaded ${succeeded.length} ontology(ies): ${names.join(", ")}`);
              }
                if (Array.isArray(failedEntries) && failedEntries.length > 0) {
                const failedMsgs = failedEntries.map((f) => {
                  try {
                    const name = deriveOntologyName(String(f.url || ""));
                    const err = f.error ? String(f.error) : "unknown error";
                    return `${name} (${err})`;
                  } catch (_) {
                    return String(f.url || "");
                  }
                });
                toast.error(`Load failures (${failedEntries.length}): ${failedMsgs.join("; ")}`);
              }
            } catch (_) { /* ignore toast failures */ }
          }
        } catch (_) { /* ignore toast/log failures */ }

      try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "sync_complete", resultsCount: results.length }); } catch (_) {}
      return { candidates, results };
    } catch (error) {
      try { vgM && typeof vgM.end === "function" && vgM.end({ reason: "exception", error: String(error) }); } catch (_) {}
      try { return { candidates: [] as string[] }; } catch (_) { return { candidates: [] as string[] }; }
    }
  },
  getRdfManager: () => {
    const { rdfManager } = get();
    return rdfManager;
  },
}));

/**
 * Full rebuild helper: authoritative rebuild using the provided RDF manager (or module-level rdfManager).
 * This function replaces the old incrementalReconcileFromQuads full-rebuild path.
 */
async function buildFatMap(rdfMgr?: any): Promise<void> {
  const mgr = rdfMgr || (typeof rdfManager !== "undefined" ? rdfManager : undefined);
  if (!mgr || typeof mgr.getStore !== "function") return;

  const store = mgr.getStore();
  // Collect all quads across the store and include the ontology named graph explicitly.
  const allQuads = (store.getQuads(null, null, null, null) || []).slice();
  const ontQuads = (store.getQuads(null, null, null, namedNode("urn:vg:ontologies")) || []);
  if (Array.isArray(ontQuads) && ontQuads.length > 0) {
    allQuads.push(...ontQuads);
  }

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

  const subjects = Array.from(
    new Set(
      (allQuads || []).map((q: any) => (q && q.subject && (q.subject.value || q.subject)) || "").filter(Boolean),
    ),
  );

  const propsMap: Record<string, any> = {};
  const classesMap: Record<string, any> = {};

  for (const s of subjects) {
    const subj = namedNode(String(s));
    const typeQuads = store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
    const types = Array.from(new Set(typeQuads.map((q: any) => (q && q.object && (q.object as any).value) || "").filter(Boolean)));

    const isProp = types.some((t: string) => /Property/i.test(String(t)));
    const isClass = types.some((t: string) => /Class/i.test(String(t)));

    const labelQ = store.getQuads(subj, namedNode(RDFS_LABEL), null, null) || [];
    const label = labelQ.length > 0 ? String((labelQ[0].object as any).value) : "";
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
  }

  const mergedProps = Object.values(propsMap) as ObjectProperty[];
  const mergedClasses = Object.values(classesMap) as OntologyClass[];

  // Compute and persist namespace registry in the same atomic update as the fat-map so consumers
  // that rely on both availableClasses/availableProperties and namespaceRegistry see a consistent state.
    try {
      const nsMap = mgr && typeof (mgr as any).getNamespaces === "function" ? (mgr as any).getNamespaces() : {};
      const prefixes = Object.keys(nsMap || []).sort();
      const paletteMap = buildPaletteMap(prefixes || []);
      const registry = (prefixes || []).map((p) => {
        try {
          return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: String((paletteMap as any)[p] || "") };
        } catch (_) {
          return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: "" };
        }
      });

      // Compute prefixed forms using the freshly computed registry before persisting so
      // consumers see consistent prefixed values immediately.
      const computePrefixed = (e: any) => {
        try {
          const iri = String((e && (e.iri || e.key)) || "");
          const pref = iri ? toPrefixed(String(iri), registry as any) : "";
          return { ...(e || {}), prefixed: pref && String(pref) !== String(iri) ? String(pref) : "" };
        } catch (_) {
          return { ...(e || {}), prefixed: "" };
        }
      };

      const mergedPropsWithPref = (Array.isArray(mergedProps) ? mergedProps : []).map(computePrefixed);
      const mergedClassesWithPref = (Array.isArray(mergedClasses) ? mergedClasses : []).map(computePrefixed);

    useOntologyStore.setState((st: any) => ({
      availableProperties: mergedPropsWithPref,
      availableClasses: mergedClassesWithPref,
      ontologiesVersion: (st.ontologiesVersion || 0) + 1,
      namespaceRegistry: registry,
    }));
    } catch (_) {
      try {
        const mergedPropsWithPref = attachPrefixed(Array.isArray(mergedProps) ? mergedProps : []);
        const mergedClassesWithPref = attachPrefixed(Array.isArray(mergedClasses) ? mergedClasses : []);
        useOntologyStore.setState((st: any) => ({
          availableProperties: mergedPropsWithPref,
          availableClasses: mergedClassesWithPref,
          ontologiesVersion: (st.ontologiesVersion || 0) + 1,
        }));
      } catch (_) {
        useOntologyStore.setState((st: any) => ({
          availableProperties: mergedProps,
          availableClasses: mergedClasses,
          ontologiesVersion: (st.ontologiesVersion || 0) + 1,
        }));
      }
    }

      

  
}

/**
 * Extract ontology URIs referenced in RDF content that should be loaded
 */
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

  {
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
  }

  return Array.from(ontologyUris);
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
