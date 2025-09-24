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
  currentGraph: {
    nodes: (ParsedNode | DiagramNode)[];
    edges: (ParsedEdge | DiagramEdge)[];
  };
  rdfManager: RDFManager;
  // incremented whenever availableProperties/availableClasses are updated from the RDF store
  ontologiesVersion: number;

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
  validateGraph: (
    nodes: ParsedNode[],
    edges: ParsedEdge[],
  ) => ValidationError[];
  getCompatibleProperties: (
    sourceClass: string,
    targetClass: string,
  ) => ObjectProperty[];
  clearOntologies: () => void;
  setCurrentGraph: (
    nodes: (ParsedNode | DiagramNode)[],
    edges: (ParsedEdge | DiagramEdge)[],
  ) => void;
  exportGraph: (format: "turtle" | "json-ld" | "rdf-xml") => Promise<string>;
  reconcileQuads: (quads: any[] | undefined) => void;
  getRdfManager: () => RDFManager;
  removeLoadedOntology: (url: string) => void;
}

export const useOntologyStore = create<OntologyStore>((set, get) => ({
  loadedOntologies: [],
  availableClasses: [],
  availableProperties: [],
  validationErrors: [],
  currentGraph: { nodes: [], edges: [] },
  rdfManager: rdfManager,
  // incremented whenever availableProperties/availableClasses are updated from the RDF store
  ontologiesVersion: 0,

  loadOntology: async (url: string) => {
    logCallGraph?.("loadOntology:start", url);
    try {
      const wellKnownOntologies = WELL_KNOWN.ontologies;

      const { rdfManager } = get();
      const preserveGraph = true;

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

      // removed early registration for well-known entries so we fall through
      // to the centralized fetch & parse logic below which will perform the
      // actual fetch/parse and register only once triples are successfully added.
      // This ensures loadedOntologies reflects actual store contents.

      // If this URL corresponds to a well-known ontology entry, ensure we have
      // a lightweight loadedOntologies record immediately. This avoids cases
      // where parsing or namespace extraction paths later do not result in a
      // registered entry (tests and some runtime paths expect the known
      // ontology to appear in loadedOntologies right after loadOntology()).
      if (wkEntry) {
        try {
          const { loadedOntologies: curLoaded, rdfManager: mgr } = get();
          const alreadyPresent = (curLoaded || []).some((o: any) =>
            urlsEquivalent(o.url, normRequestedUrl),
          );
          if (!alreadyPresent) {
            try {
              // Prefer explicit namespaces from the well-known entry; fall back to the manager's namespaces.
              const namespaces =
                wkEntry.namespaces && Object.keys(wkEntry.namespaces).length > 0
                  ? wkEntry.namespaces
                  : mgr && typeof mgr.getNamespaces === "function"
                    ? mgr.getNamespaces()
                    : {};
              ensureNamespacesPresent(mgr, namespaces);

              const meta: LoadedOntology = {
                url: normRequestedUrl,
                name:
                  wkEntry && wkEntry.name
                    ? wkEntry.name
                    : deriveOntologyName(String(normRequestedUrl || url)),
                classes: [],
                properties: [],
                namespaces: namespaces || {},
                source:
                  wkEntry && (wkEntry as any).isCore ? "core" : "requested",
                graphName: "urn:vg:ontologies",
              };
              set((state) => ({
                loadedOntologies: [...(state.loadedOntologies || []), meta],
                ontologiesVersion: (state.ontologiesVersion || 0) + 1,
              }));
            } catch (_) {
              /* ignore */
            }
          }
        } catch (_) {
          /* ignore */
        }
      }

      // Centralized fetch & mime detection via RDFManager helper
      try {
        const { rdfManager } = get();

        // Normalize a URL to create a stable key used for in-flight deduplication.
        const normalizeForKey = (u: any) => {
          try {
            const s = String(u || "").trim();
            if (!s) return "";
            if (s.toLowerCase().startsWith("http://")) {
              return s.replace(/^http:\/\//i, "https://").replace(/\/+$/, "");
            }
            try {
              return new URL(s).toString().replace(/\/+$/, "");
            } catch {
              return s.replace(/\/+$/, "");
            }
          } catch {
            return String(u || "");
          }
        };

        const loadKey = normalizeForKey(url);

        // Share identical concurrent loads via inFlightLoads so we don't fetch/parse the same ontology multiple times.
        let parsed: any;
        const existing = inFlightLoads.get(loadKey) as Promise<any> | undefined;
        if (existing) {
          try {
            parsed = await existing;
          } catch (e) {
            // If the shared promise failed, remove it and continue to attempt a fresh load below.
            inFlightLoads.delete(loadKey);
            throw e;
          }
        } else {
          const promise = (async () => {
            try {
              const { content } = await rdfManager.loadFromUrl(url, {
                timeoutMs: 15000,
                onProgress: (p: number, m: string) => {
                  /* no-op or forward */
                },
              });
              // Persist the raw ontology RDF into the shared ontologies graph so its triples are clearly marked as ontology provenance.
              try {
                await rdfManager.loadRDFIntoGraph(content, "urn:vg:ontologies");
              } catch (_) {
                /* ignore persist failures - parsing will proceed regardless */
              }
              const { computeParsedFromStore } = await import(
                "../utils/parsedFromStore"
              );
              const parsedLocal = await computeParsedFromStore(
                rdfManager,
                "urn:vg:ontologies",
              );
              return parsedLocal;
            } catch (e) {
              throw e;
            }
          })();

          inFlightLoads.set(loadKey, promise);
          try {
            parsed = await promise;
          } finally {
            // Ensure we remove the in-flight entry so future loads can retry if needed.
            inFlightLoads.delete(loadKey);
          }
        }
        // Filter out synthetic helper prefixes/entries (e.g. those created by ensureNamespacesPresent which
        // emit minimal dummy triples like PREFIX:__vg_dummy). These should not create standalone loadedOntology entries.
        const filteredNamespaces =
          parsed && parsed.namespaces
            ? Object.fromEntries(
                Object.entries(parsed.namespaces).filter(([p, ns]) => {
                  try {
                    const sp = String(p || "");
                    const sn = String(ns || "");
                    return (
                      !sp.includes("__vg_dummy") && !sn.includes("__vg_dummy")
                    );
                  } catch {
                    return true;
                  }
                }),
              )
            : {};

        // Ensure any namespaces discovered during parsing are applied into the RDF manager
        // immediately so subsequent logic that uses computeTermDisplay or expandPrefix
        // sees the newly-registered prefixes. This is idempotent and safe to call.
        try {
          if (
            filteredNamespaces &&
            Object.keys(filteredNamespaces).length > 0
          ) {
            try {
              // filteredNamespaces may come from parsing and have unknown-value types;
              // coerce to the expected Record<string,string> when calling the RDF manager.
              try {
                rdfManager.applyParsedNamespaces(
                  filteredNamespaces as Record<string, string>,
                );
              } catch (_) {
                // fallback: stringify values
                const stringified: Record<string, string> = {};
                Object.entries(filteredNamespaces || {}).forEach(([k, v]) => {
                  try {
                    stringified[k] = String(v);
                  } catch (_) {
                    /* ignore */
                  }
                });
                try {
                  rdfManager.applyParsedNamespaces(stringified);
                } catch (_) {
                  /* ignore */
                }
              }
            } catch (_) {
              /* ignore namespace application failures */
            }
          }
        } catch (_) {
          /* ignore overall */
        }

        // To avoid duplicate rdf:type triples appearing across graphs (the raw
        // ontology persisted into the ontologies graph vs. the parsed nodes being
        // re-applied into the default graph), proactively remove rdf:type triples
        // for the parsed subjects from the ontologies graph. This keeps the store
        // free of duplicate type triples while preserving ontology provenance.
        try {
          const store = rdfManager.getStore();
          const rdfTypeIri =
            typeof rdfManager.expandPrefix === "function"
              ? rdfManager.expandPrefix("rdf:type")
              : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
          const g = namedNode("urn:vg:ontologies");
          (parsed.nodes || []).forEach((n: any) => {
            try {
              if (!n || !n.iri) return;
              const existing =
                store.getQuads(
                  namedNode(n.iri),
                  namedNode(rdfTypeIri),
                  null,
                  g,
                ) || [];
              existing.forEach((q: Quad) => {
                try {
                  store.removeQuad(q);
                } catch (_) {
                  /* ignore per-quad removal failures */
                }
              });
            } catch (_) {
              /* ignore per-node errors */
            }
          });
        } catch (_) {
          /* best-effort only */
        }

        try {
          // Determine a canonical URL for this parsed RDF by matching parsed namespaces
          // against our WELL_KNOWN ontology namespace mappings. Preference order:
          // 1) If the requested URL is a known WELL_KNOWN entry (wkEntry), prefer that.
          // 2) If any parsed namespace URI maps to a canonical well-known ontology URL,
          //    prefer that canonical URL.
          // 3) Otherwise fall back to the original requested URL.
          const parsedNamespaces = parsed.namespaces || {};
          const canonicalByNs: Record<string, string> = {};

          Object.entries(WELL_KNOWN.ontologies || {}).forEach(
            ([ontUrl, meta]: any) => {
              if (meta && meta.namespaces) {
                Object.values(meta.namespaces).forEach((nsUri: any) => {
                  try {
                    canonicalByNs[String(nsUri)] = ontUrl;
                  } catch (_) {
                    /* ignore */
                  }
                });
              }
            },
          );

          // Build chosen canonical URL
          let canonicalForThis = url;
          try {
            for (const nsUri of Object.values(parsedNamespaces || {})) {
              const cand = canonicalByNs[String(nsUri)];
              if (cand) {
                canonicalForThis = cand;
                break;
              }
            }
          } catch (_) {
            /* ignore */
          }

          // If the requested URL is explicitly a well-known entry, prefer it.
          if (wkEntry) canonicalForThis = url;

          // Register a single loadedOntology entry (deduplicated) using canonicalForThis.
          // Use scheme-agnostic comparison (urlsEquivalent) to detect existing variants
          // and add textual variants as aliases instead of creating duplicate entries.
          try {
            const existingIndex = (get().loadedOntologies || []).findIndex(
              (o: any) => urlsEquivalent(o.url, canonicalForThis),
            );

            if (existingIndex === -1) {
              try {
                const meta: LoadedOntology = {
                  url: canonicalForThis,
                  name:
                    wkEntry && wkEntry.name
                      ? wkEntry.name
                      : deriveOntologyName(String(canonicalForThis)),
                  classes: [],
                  properties: [],
                  namespaces:
                    parsed.namespaces || (wkEntry && wkEntry.namespaces) || {},
                };
                set((state) => ({
                  loadedOntologies: [...state.loadedOntologies, meta],
                }));
              } catch (_) {
                /* ignore registration failure */
              }
            } else {
              // Merge parsed namespaces into the existing entry and record this canonical URL as an alias
              try {
                set((state: any) => {
                  const copy = (state.loadedOntologies || []).slice();
                  const existing = { ...(copy[existingIndex] || {}) };
                  existing.namespaces = {
                    ...(existing.namespaces || {}),
                    ...(parsed.namespaces || {}),
                  };
                  existing.classes = Array.from(
                    new Set([...(existing.classes || []), ...ontologyClasses]),
                  );
                  existing.properties = Array.from(
                    new Set([
                      ...(existing.properties || []),
                      ...ontologyProperties,
                    ]),
                  );
                  if (String(existing.url) !== String(canonicalForThis)) {
                    existing.aliases = Array.isArray(existing.aliases)
                      ? existing.aliases
                      : [];
                    if (!existing.aliases.includes(canonicalForThis)) {
                      existing.aliases.push(canonicalForThis);
                    }
                  }
                  copy[existingIndex] = existing;
                  return { loadedOntologies: copy };
                });
              } catch (_) {
                /* ignore merge failure */
              }
            }
          } catch (e) {
            try {
              fallback(
                "wellknown.match.failed",
                { error: String(e) },
                { level: "warn" },
              );
            } catch (_) {
              /* ignore */
            }
          }
        } catch (e) {
          try {
            fallback(
              "wellknown.match.failed",
              { error: String(e) },
              { level: "warn" },
            );
          } catch (_) {
            /* ignore */
          }
        }

        const ontologyClasses: OntologyClass[] = [];
        const ontologyProperties: ObjectProperty[] = [];

        const classGroups = new Map<string, any[]>();
        parsed.nodes.forEach((node) => {
          const updates: any = {};
          const allTypes =
            (node as any).rdfTypes && (node as any).rdfTypes.length > 0
              ? (node as any).rdfTypes.slice()
              : (node as any).rdfType
                ? [(node as any).rdfType]
                : [];
          const meaningful = allTypes.filter(
            (t: string) => t && !String(t).includes("NamedIndividual"),
          );
          if (meaningful.length > 0) {
            updates.rdfTypes = meaningful;
          } else if (allTypes.length > 0) {
            updates.rdfTypes = allTypes;
          } else if (node.classType && node.namespace) {
            updates.rdfTypes = [`${node.namespace}:${node.classType}`];
          }

          if (node.literalProperties && node.literalProperties.length > 0) {
            updates.annotationProperties = node.literalProperties.map(
              (prop) => ({
                propertyUri: prop.key,
                value: prop.value,
                type: prop.type || "xsd:string",
              }),
            );
          } else if (
            (node as any).annotationProperties &&
            (node as any).annotationProperties.length > 0
          ) {
            updates.annotationProperties = (
              node as any
            ).annotationProperties.map((ap: any) => ({
              propertyUri: ap.propertyUri || ap.property || ap.key,
              value: ap.value,
              type: ap.type || "xsd:string",
            }));
          }

          const isIndividual = (node as any).entityType === "individual";
          const hasLiterals =
            node.literalProperties && node.literalProperties.length > 0;
          if (
            (isIndividual || hasLiterals) &&
            Object.keys(updates).length > 0
          ) {
            try {
              const subj = String(node.iri || node.id || "");
              if (subj) {
                // Persist rdfTypes (non-destructive: add missing types)
                if (updates.rdfTypes && Array.isArray(updates.rdfTypes)) {
                  try {
                    const rdfTypePred =
                      typeof rdfManager.expandPrefix === "function"
                        ? rdfManager.expandPrefix("rdf:type")
                        : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
                    for (const t of updates.rdfTypes) {
                      try {
                        const typeVal = String(t || "");
                        const expanded =
                          typeof rdfManager.expandPrefix === "function"
                            ? rdfManager.expandPrefix(typeVal)
                            : typeVal;
                        if (expanded) {
                          try {
                            rdfManager.addTriple(
                              subj,
                              rdfTypePred,
                              expanded,
                              "urn:vg:ontologies",
                            );
                          } catch (_) {
                            /* ignore per-type add failures */
                          }
                        }
                      } catch (_) {
                        /* ignore per-type */
                      }
                    }
                  } catch (_) {
                    /* ignore rdfTypes persistence */
                  }
                }

                // Persist annotation/literal properties idempotently into the ontology graph
                const ann = updates.annotationProperties;
                if (ann && Array.isArray(ann) && ann.length > 0) {
                  try {
                    const adds: any[] = [];
                    for (const ap of ann) {
                      try {
                        const predRaw =
                          (ap && (ap.propertyUri || ap.property || ap.key)) ||
                          "";
                        const predFull =
                          typeof rdfManager.expandPrefix === "function"
                            ? rdfManager.expandPrefix(String(predRaw))
                            : String(predRaw);
                        if (!predFull) continue;
                        adds.push({
                          subject: subj,
                          predicate: predFull,
                          object: String(ap.value),
                        });
                      } catch (_) {
                        /* ignore per-ann */
                      }
                    }
                    // Apply add operations directly (idempotent)
                    for (const a of adds) {
                      try {
                        rdfManager.addTriple(
                          a.subject,
                          a.predicate,
                          a.object,
                          "urn:vg:ontologies",
                        );
                      } catch (_) {}
                    }
                  } catch (_) {
                    /* ignore annotation persistence */
                  }
                }
              }
            } catch (_) {
              /* ignore overall persistence errors */
            }
          }

          const classKey = `${node.namespace}:${node.classType}`;
          if (!classGroups.has(classKey)) classGroups.set(classKey, []);
          classGroups.get(classKey)!.push(node);
        });

        classGroups.forEach((nodes, classKey) => {
          const firstNode = nodes[0];
          const properties = Array.from(
            new Set(
              nodes.flatMap((node: any) =>
                (node.literalProperties || []).map((p: any) => p.key),
              ),
            ),
          );
          ontologyClasses.push({
            iri: classKey,
            label: firstNode.classType,
            namespace: firstNode.namespace,
            properties,
            restrictions: {},
          });
        });

        const propertyGroups = new Map<string, any[]>();
        parsed.edges.forEach((edge) => {
          if (!propertyGroups.has(edge.propertyType))
            propertyGroups.set(edge.propertyType, []);
          propertyGroups.get(edge.propertyType)!.push(edge);
        });

        propertyGroups.forEach((edges, propertyType) => {
          const domains = Array.from(
            new Set(
              edges
                .map((edge: any) => {
                  const s = parsed.nodes.find((n: any) => n.id === edge.source);
                  return s ? `${s.namespace}:${s.classType}` : "";
                })
                .filter(Boolean),
            ),
          );

          const ranges = Array.from(
            new Set(
              edges
                .map((edge: any) => {
                  const t = parsed.nodes.find((n: any) => n.id === edge.target);
                  return t ? `${t.namespace}:${t.classType}` : "";
                })
                .filter(Boolean),
            ),
          );

          const firstEdge = edges[0];
          ontologyProperties.push({
            iri: propertyType,
            label: firstEdge.label,
            domain: domains,
            range: ranges,
            namespace: firstEdge.namespace,
          });
        });

        // Determine a canonical registration URL for the ontology:
        // prefer a well-known canonical mapping discovered via parsed namespaces,
        // otherwise fall back to the normalized requested URL.
        let canonicalUrl = url;
        try {
          const parsedNamespaces = parsed.namespaces || {};
          const canonicalByNs: Record<string, string> = {};

          Object.entries(WELL_KNOWN.ontologies || {}).forEach(
            ([ontUrl, meta]: any) => {
              if (meta && meta.namespaces) {
                Object.values(meta.namespaces).forEach((nsUri: any) => {
                  try {
                    canonicalByNs[String(nsUri)] = ontUrl;
                  } catch (_) {
                    /* ignore */
                  }
                });
              }
            },
          );

          // If any parsed namespace URI maps to a canonical well-known ontology, prefer that.
          for (const nsUri of Object.values(parsedNamespaces || {})) {
            const cand = canonicalByNs[String(nsUri)];
            if (cand) {
              canonicalUrl = cand;
              break;
            }
          }
        } catch (_) {
          // fall back to original url on any error
          canonicalUrl = url;
        }

        const loadedOntology: LoadedOntology = {
          url: canonicalUrl,
          name: deriveOntologyName(canonicalUrl),
          classes: ontologyClasses,
          properties: ontologyProperties,
          namespaces:
            Object.keys(filteredNamespaces || {}).length > 0
              ? filteredNamespaces
              : parsed.namespaces || {},
          source: wkEntry ? "requested" : "requested",
          graphName: "urn:vg:ontologies",
        };

        // Merge into state with deduplication by canonical URL (scheme-agnostic).
        // Skip registering core RDF vocabularies as standalone ontologies when loading regular ontologies.
        set((state: any) => {
          const coreOntologies = new Set([
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            "http://www.w3.org/2000/01/rdf-schema#",
            "http://www.w3.org/2002/07/owl#",
            "http://www.w3.org/2001/XMLSchema#",
          ]);

          // If the loaded ontology is a core vocab, do not register it as a separate loadedOntology here.
          if (coreOntologies.has(String(loadedOntology.url))) {
            // still merge classes/properties into available lists below, but avoid showing as a loaded ontology
            const mergedClasses = [
              ...state.availableClasses,
              ...ontologyClasses,
            ];
            const mergedProps = [
              ...state.availableProperties,
              ...ontologyProperties,
            ];

            const classMap: Record<string, any> = {};
            mergedClasses.forEach((c: any) => {
              try {
                classMap[String(c.iri)] = c;
              } catch (_) {}
            });
            const propMap: Record<string, any> = {};
            mergedProps.forEach((p: any) => {
              try {
                propMap[String(p.iri)] = p;
              } catch (_) {}
            });

            return {
              availableClasses: Object.values(classMap),
              availableProperties: Object.values(propMap),
              ontologiesVersion: (state.ontologiesVersion || 0) + 1,
            };
          }

          const existingIndex = (state.loadedOntologies || []).findIndex(
            (o: any) => urlsEquivalent(o.url, loadedOntology.url),
          );

          let newLoaded = (state.loadedOntologies || []).slice();

          if (existingIndex !== -1) {
            try {
              const existing = { ...(newLoaded[existingIndex] || {}) };
              existing.name = existing.name || loadedOntology.name;
              existing.namespaces = {
                ...(existing.namespaces || {}),
                ...(loadedOntology.namespaces || {}),
              };
              existing.classes = Array.from(
                new Set([
                  ...(existing.classes || []),
                  ...(loadedOntology.classes || []),
                ]),
              );
              existing.properties = Array.from(
                new Set([
                  ...(existing.properties || []),
                  ...(loadedOntology.properties || []),
                ]),
              );
              // record alias if textual URLs differ
              try {
                if (String(existing.url) !== String(loadedOntology.url)) {
                  existing.aliases = Array.isArray(existing.aliases)
                    ? existing.aliases
                    : [];
                  if (!existing.aliases.includes(loadedOntology.url))
                    existing.aliases.push(loadedOntology.url);
                }
              } catch (_) {}
              newLoaded[existingIndex] = existing;
            } catch (_) {
              // fallback to append if merge fails
              newLoaded = [...(state.loadedOntologies || []), loadedOntology];
            }
          } else {
            newLoaded = [...(state.loadedOntologies || []), loadedOntology];
          }

          const mergedClasses = [...state.availableClasses, ...ontologyClasses];
          const mergedProps = [
            ...state.availableProperties,
            ...ontologyProperties,
          ];

          // Deduplicate available lists by iri
          const classMap: Record<string, any> = {};
          mergedClasses.forEach((c: any) => {
            try {
              classMap[String(c.iri)] = c;
            } catch (_) {}
          });
          const propMap: Record<string, any> = {};
          mergedProps.forEach((p: any) => {
            try {
              propMap[String(p.iri)] = p;
            } catch (_) {}
          });

          return {
            loadedOntologies: newLoaded,
            availableClasses: Object.values(classMap),
            availableProperties: Object.values(propMap),
            ontologiesVersion: (state.ontologiesVersion || 0) + 1,
          };
        });

        // Debug snapshot immediately after merging loadedOntologies into state.
        try {
          try {
            const snapshot = (get().loadedOntologies || []).map((o: any) => ({
              url: o.url,
              name: o.name,
            }));
            console.debug("[VG_DEBUG] loadedOntologies.afterMerge:", snapshot);
          } catch (_) {
            /* ignore debug failures */
          }
        } catch (_) {
          /* ignore outer debug failures */
        }

        try {
          const appCfg = useAppConfigStore.getState();
          if (appCfg && typeof appCfg.addRecentOntology === "function") {
            let norm = url;
            try {
              norm = new URL(String(url)).toString();
            } catch {
              norm = String(url).replace(/\/+$/, "");
            }
            appCfg.addRecentOntology(norm);
          }
        } catch (_) {
          /* ignore */
        }

        // Merge parsed graph into currentGraph (preserveGraph behavior)
        try {
          // Filter out nodes that belong to reserved RDF/OWL namespaces so they are not
          // added into the UI currentGraph (prevents many core vocabulary nodes from
          // creating canvas nodes). The RDF store still contains these triples for
          // indexing/search; we only remove them from the UI merge step.
          const _blacklistedPrefixes = new Set([
            "owl",
            "rdf",
            "rdfs",
            "xml",
            "xsd",
          ]);
          const _blacklistedUris = [
            "http://www.w3.org/2002/07/owl",
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            "http://www.w3.org/2000/01/rdf-schema#",
            "http://www.w3.org/XML/1998/namespace",
            "http://www.w3.org/2001/XMLSchema#",
          ];
          function isBlacklistedIri(val?: string | null): boolean {
            if (!val) return false;
            try {
              const s = String(val).trim();
              if (!s) return false;
              if (s.includes(":") && !/^https?:\/\//i.test(s)) {
                const prefix = s.split(":", 1)[0];
                if (_blacklistedPrefixes.has(prefix)) return true;
              }
              for (const u of _blacklistedUris) {
                if (s.startsWith(u)) return true;
              }
            } catch (_) {
              return false;
            }
            return false;
          }

          const nodes = (parsed.nodes || [])
            .map((n: any) => {
              const isIriOrBNode = (s?: string) =>
                !!s && (/^https?:\/\//i.test(s) || s.startsWith("_:"));
              const rawId = n && n.id ? String(n.id) : "";
              const rawIri = n && n.iri ? String(n.iri) : "";
              const nodeId = isIriOrBNode(rawId)
                ? rawId
                : isIriOrBNode(rawIri)
                  ? rawIri
                  : null;

              if (!nodeId) {
                try {
                  if (
                    typeof console !== "undefined" &&
                    typeof console.debug === "function"
                  ) {
                    console.debug(
                      "[VG_WARN] ontologyStore.skippingParsedNode missing IRI id",
                      {
                        preview: {
                          id: rawId || undefined,
                          iri: rawIri || undefined,
                        },
                      },
                    );
                  }
                } catch (_) {
                  /* ignore */
                }
                return null;
              }

              const allTypes =
                (n as any).rdfTypes && (n as any).rdfTypes.length > 0
                  ? (n as any).rdfTypes.slice()
                  : (n as any).rdfType
                    ? [(n as any).rdfType]
                    : [];
              const meaningful = allTypes.filter(
                (t: string) => t && !String(t).includes("NamedIndividual"),
              );
              const chosen =
                meaningful.length > 0
                  ? meaningful[0]
                  : allTypes.length > 0
                    ? allTypes[0]
                    : undefined;

              let computedClassType = n.classType;
              let computedNamespace = n.namespace;

              try {
                if (chosen) {
                  const chosenStr = String(chosen);
                  if (chosenStr.includes(":")) {
                    const idx = chosenStr.indexOf(":");
                    computedNamespace = chosenStr.substring(0, idx);
                    computedClassType = chosenStr.substring(idx + 1);
                  } else if (/^https?:\/\//i.test(chosenStr)) {
                    try {
                      const mgr = get().rdfManager;
                      const nsMap =
                        mgr && typeof mgr.getNamespaces === "function"
                          ? mgr.getNamespaces()
                          : {};
                      let matched = false;
                      for (const [p, uri] of Object.entries(nsMap || {})) {
                        if (uri && chosenStr.startsWith(uri)) {
                          computedNamespace = p === ":" ? "" : p;
                          computedClassType = chosenStr.substring(uri.length);
                          matched = true;
                          break;
                        }
                      }
                      if (!matched) {
                        const parts = chosenStr.split(/[#/]/).filter(Boolean);
                        computedClassType = parts.length
                          ? parts[parts.length - 1]
                          : chosenStr;
                      }
                    } catch {
                      const parts = chosenStr.split(/[#/]/).filter(Boolean);
                      computedClassType = parts.length
                        ? parts[parts.length - 1]
                        : chosenStr;
                    }
                  } else {
                    const parts = chosenStr.split(/[#/]/).filter(Boolean);
                    computedClassType = parts.length
                      ? parts[parts.length - 1]
                      : chosenStr;
                  }
                }
              } catch {
                // ignore
              }

              return {
                id: nodeId,
                iri: n.iri || n.id || "",
                data: {
                  individualName:
                    n.individualName ||
                    (n.iri ? n.iri.split("/").pop() : nodeId),
                  classType: computedClassType,
                  namespace: computedNamespace,
                  iri: n.iri || n.id || "",
                  literalProperties: n.literalProperties || [],
                  annotationProperties: n.annotationProperties || [],
                },
              };
            })
            .filter(Boolean);

          const edges = (parsed.edges || []).map((e: any) => {
            // Normalize edge endpoints so downstream merge/mapping always see string IRIs or blank nodes.
            const rawSource =
              e.source ||
              (e.data &&
                (e.data.source ||
                  e.data.from ||
                  e.data.subj ||
                  e.data.subject)) ||
              e.subj ||
              e.subject ||
              e.s ||
              "";
            const rawTarget =
              e.target ||
              (e.data &&
                (e.data.target || e.data.to || e.data.obj || e.data.object)) ||
              e.obj ||
              e.object ||
              e.o ||
              "";
            return {
              id:
                e.id ||
                generateEdgeId(
                  String(rawSource),
                  String(rawTarget),
                  String(e.propertyType || e.propertyUri || ""),
                ),
              source: String(rawSource || ""),
              target: String(rawTarget || ""),
              data: e,
            };
          });

          // Merge into existing graph preserving previous nodes/edges
          const existing = get().currentGraph;
          const mergedNodes: any[] = [...existing.nodes];
          const existingUris = new Set<string>();
          existing.nodes.forEach((m: any) => {
            const mid =
              (m &&
                m.data &&
                ((m.data.iri as string) ||
                  (m.data.iri as string) ||
                  (m.data.individualName as string) ||
                  (m.data.id as string))) ||
              m.iri ||
              m.id;
            if (mid) existingUris.add(String(mid));
          });

          (parsed.nodes || []).forEach((n: any) => {
            const nIds = [
              n.iri,
              n.id,
              n.data && n.data.iri,
              n.data && n.data.iri,
              n.data && n.data.individualName,
              n.data && n.data.id,
            ];
            const exists = nIds.some(
              (id) => id && existingUris.has(String(id)),
            );
            if (!exists) {
              // Enforce strict IRI / blank-node ids for merged nodes.
              const isIriOrBNode = (s?: string) =>
                !!s && (/^https?:\/\//i.test(s) || s.startsWith("_:"));
              const rawId = n && n.id ? String(n.id) : "";
              const rawIri = n && n.iri ? String(n.iri) : "";
              const nodeId = isIriOrBNode(rawId)
                ? rawId
                : isIriOrBNode(rawIri)
                  ? rawIri
                  : null;

              if (!nodeId) {
                try {
                  if (
                    typeof console !== "undefined" &&
                    typeof console.debug === "function"
                  ) {
                    console.debug(
                      "[VG_WARN] ontologyStore.skippingParsedNode on merge missing IRI id",
                      {
                        preview: {
                          id: rawId || undefined,
                          iri: rawIri || undefined,
                        },
                      },
                    );
                  }
                } catch (_) {
                  /* ignore */
                }
                return;
              }

              const nodeObj = {
                id: nodeId,
                iri: n.iri || n.id || "",
                data: {
                  individualName:
                    n.individualName ||
                    (n.iri ? n.iri.split("/").pop() : nodeId),
                  classType: n.classType,
                  namespace: n.namespace,
                  iri: n.iri || n.id || "",
                  literalProperties: n.literalProperties || [],
                  annotationProperties: n.annotationProperties || [],
                },
              };
              mergedNodes.push(nodeObj);
              nIds.forEach((id) => {
                if (id) existingUris.add(String(id));
              });
            }
          });

          const mergedEdges: any[] = [...existing.edges];
          (parsed.edges || []).forEach((e: any) => {
            // Normalize edge id and endpoints robustly: some producers use different field names.
            const rawSource =
              e.source ||
              (e.data &&
                (e.data.source ||
                  e.data.from ||
                  e.data.subj ||
                  e.data.subject)) ||
              e.subj ||
              e.subject ||
              e.s ||
              "";
            const rawTarget =
              e.target ||
              (e.data &&
                (e.data.target || e.data.to || e.data.obj || e.data.object)) ||
              e.obj ||
              e.object ||
              e.o ||
              "";
            const edgeId =
              e.id ||
              generateEdgeId(
                String(rawSource),
                String(rawTarget),
                String(e.propertyType || e.propertyUri || ""),
              );
            if (!mergedEdges.find((me: any) => me.id === edgeId)) {
              mergedEdges.push({
                id: edgeId,
                source: String(rawSource || ""),
                target: String(rawTarget || ""),
                data: e,
              });
            }
          });

          // Ensure edges loaded from RDF receive computed display labels now that the RDF manager
          // has been updated. We compute labels conservatively using computeTermDisplay when an RDF
          // manager is available; otherwise labels remain empty (strict policy).
          try {
            const mgrLocal = get().rdfManager;
            const labeledEdges = (mergedEdges || []).map((e: any) => {
              try {
                const pred =
                  (e &&
                    e.data &&
                    (e.data.propertyUri || e.data.propertyType)) ||
                  "";
                let label = "";
                if (mgrLocal && pred) {
                  try {
                    const td = computeTermDisplay(
                      String(pred),
                      mgrLocal as any,
                    );
                    label = String(td.prefixed || td.short || "");
                  } catch (_) {
                    label = "";
                  }
                } else if (e && e.data && e.data.label) {
                  // preserve any explicit label present in parsed edge payload
                  label = String(e.data.label);
                } else {
                  label = "";
                }
                return { ...e, data: { ...(e.data || {}), label } };
              } catch (_) {
                return e;
              }
            });
            // Merge into existing currentGraph (preserve nodes/edges not present in this parsed batch)
            try {
              const existing = get().currentGraph || { nodes: [], edges: [] };
              const byId = new Map<string, any>();
              try {
                (existing.nodes || []).forEach((n: any) => {
                  try {
                    byId.set(String(n.id), n);
                  } catch (_) {
                    /* ignore */
                  }
                });
              } catch (_) {
                /* ignore */
              }

              try {
                (mergedNodes || []).forEach((n: any) => {
                  try {
                    const id = String(n.id);
                    const prev = byId.get(id);
                    if (prev) {
                      const mergedNode = {
                        ...prev,
                        ...n,
                        position: prev.position || n.position || { x: 0, y: 0 },
                        data: {
                          ...(n && (n as any).data ? (n as any).data : {}),
                          ...((prev as any).data ? (prev as any).data : {}),
                        },
                      };
                      try {
                        if ((prev as any).__rf)
                          (mergedNode as any).__rf = (prev as any).__rf;
                      } catch (_) {}
                      try {
                        if ((prev as any).selected)
                          (mergedNode as any).selected = true;
                      } catch (_) {}
                      byId.set(id, mergedNode);
                    } else {
                      const nodeToSet =
                        n && (n as any).position
                          ? n
                          : { ...n, position: n.position || { x: 0, y: 0 } };
                      byId.set(id, nodeToSet);
                    }
                  } catch (_) {
                    /* ignore per-node */
                  }
                });
              } catch (_) {
                /* ignore per-mergedNodes */
              }

              const finalNodes = Array.from(byId.values()).filter(Boolean);
              const labeledEdgesFinal = Array.isArray(labeledEdges)
                ? labeledEdges.slice()
                : labeledEdges || [];
              set({
                currentGraph: { nodes: finalNodes, edges: labeledEdgesFinal },
              });
            } catch (err) {
              // Fallback to original behaviour on any merge failure
              set({
                currentGraph: { nodes: mergedNodes, edges: labeledEdges },
              });
            }
            if (typeof window !== "undefined")
              try {
                try {
                  console.debug(
                    "[VG] ontologyStore: set __VG_REQUEST_LAYOUT_ON_NEXT_MAP (labeledEdges)",
                  );
                } catch (_) {}
                (window as any).__VG_REQUEST_LAYOUT_ON_NEXT_MAP = true;
                (window as any).__VG_REQUEST_FIT_ON_NEXT_MAP = true;
              } catch (_) {
                /* ignore */
              }
          } catch (_) {
            // fallback to original merged set if anything goes wrong
            // Merge into existing currentGraph rather than replacing it outright
            try {
              const existing = get().currentGraph || { nodes: [], edges: [] };
              const nodeById = new Map<string, any>();
              try {
                (existing.nodes || []).forEach((n: any) => {
                  try {
                    nodeById.set(String(n.id), n);
                  } catch (_) {
                    /* ignore */
                  }
                });
              } catch (_) {
                /* ignore */
              }

              try {
                (mergedNodes || []).forEach((n: any) => {
                  try {
                    const id = String(n.id);
                    const prev = nodeById.get(id);
                    if (prev) {
                      const mergedNode = {
                        ...prev,
                        ...n,
                        position: prev.position || n.position || { x: 0, y: 0 },
                        data: {
                          ...(n && (n as any).data ? (n as any).data : {}),
                          ...((prev as any).data ? (prev as any).data : {}),
                        },
                      };
                      try {
                        if ((prev as any).__rf)
                          (mergedNode as any).__rf = (prev as any).__rf;
                      } catch (_) {}
                      try {
                        if ((prev as any).selected)
                          (mergedNode as any).selected = true;
                      } catch (_) {}
                      nodeById.set(id, mergedNode);
                    } else {
                      nodeById.set(
                        id,
                        n && (n as any).position
                          ? n
                          : { ...n, position: n.position || { x: 0, y: 0 } },
                      );
                    }
                  } catch (_) {
                    /* ignore per-node */
                  }
                });
              } catch (_) {
                /* ignore mergedNodes processing */
              }

              const finalNodes = Array.from(nodeById.values()).filter(Boolean);

              const edgeById = new Map<string, any>();
              try {
                (existing.edges || []).forEach((e: any) => {
                  try {
                    edgeById.set(String(e.id), e);
                  } catch (_) {
                    /* ignore */
                  }
                });
              } catch (_) {
                /* ignore */
              }

              try {
                (mergedEdges || []).forEach((e: any) => {
                  try {
                    const id = String(e.id);
                    edgeById.set(id, e);
                  } catch (_) {
                    /* ignore per-edge */
                  }
                });
              } catch (_) {
                /* ignore mergedEdges processing */
              }

              const finalEdges = Array.from(edgeById.values()).filter(Boolean);

              set({ currentGraph: { nodes: finalNodes, edges: finalEdges } });
            } catch (err) {
              // fallback to replace on error
              // Deterministic merge that removes runtime flags and heuristics.
              // Policy: parsed/merged nodes/edges win for fields they provide (parsed wins).
              // Do NOT copy runtime-only fields like __rf, selected, position.
              try {
                const existing = get().currentGraph || { nodes: [], edges: [] };
                const existingNodeMap = new Map<string, any>();
                (existing.nodes || []).forEach((n: any) => {
                  try {
                    existingNodeMap.set(String(n.id), n);
                  } catch (_) {}
                });

                const finalNodes: any[] = [];
                // Add/overwrite with mergedNodes (parsed wins)
                for (const n of mergedNodes || []) {
                  try {
                    const id = String(n.id || "");
                    if (!id) continue;
                    const existingNode = existingNodeMap.get(id);
                    const mergedData = {
                      ...((existingNode && existingNode.data) || {}),
                      ...(n && n.data ? n.data : {}),
                    };
                    finalNodes.push({
                      id,
                      iri:
                        (n && n.iri) ||
                        (existingNode && existingNode.iri) ||
                        "",
                      data: mergedData,
                    });
                    existingNodeMap.delete(id);
                  } catch (_) {
                    /* ignore per-node */
                  }
                }

                // Append any remaining existing nodes that were not in mergedNodes (strip runtime fields)
                for (const rem of Array.from(existingNodeMap.values())) {
                  try {
                    const id = String(rem.id || "");
                    if (!id) continue;
                    finalNodes.push({
                      id,
                      iri: rem.iri || "",
                      data: rem.data || {},
                    });
                  } catch (_) {
                    /* ignore */
                  }
                }

                // Edges: dedupe by id; parsed/merged edges win for fields they provide
                const existingEdgeMap = new Map<string, any>();
                (existing.edges || []).forEach((e: any) => {
                  try {
                    existingEdgeMap.set(String(e.id), e);
                  } catch (_) {}
                });

                const finalEdgeMap = new Map<string, any>();
                // Apply mergedEdges first (parsed wins)
                for (const e of mergedEdges || []) {
                  try {
                    const id = String(e.id || "");
                    if (!id) continue;
                    finalEdgeMap.set(id, {
                      id,
                      source: String(e.source || ""),
                      target: String(e.target || ""),
                      data: (e && e.data) || {},
                    });
                    existingEdgeMap.delete(id);
                  } catch (_) {
                    /* ignore per-edge */
                  }
                }
                // Append remaining existing edges (strip runtime-only)
                for (const e of Array.from(existingEdgeMap.values())) {
                  try {
                    const id = String(e.id || "");
                    if (!id) continue;
                    if (!finalEdgeMap.has(id)) {
                      finalEdgeMap.set(id, {
                        id,
                        source: String(e.source || ""),
                        target: String(e.target || ""),
                        data: e.data || {},
                      });
                    }
                  } catch (_) {
                    /* ignore */
                  }
                }

                const finalEdges = Array.from(finalEdgeMap.values());

                set({ currentGraph: { nodes: finalNodes, edges: finalEdges } });
              } catch (err) {
                // Fallback to replace on error
                set({
                  currentGraph: { nodes: mergedNodes, edges: mergedEdges },
                });
              }
            }
          }
        } catch (mergeErr) {
          try {
            fallback(
              "graph.merge.failed",
              { error: String(mergeErr) },
              { level: "warn" },
            );
          } catch (_) {
            /* ignore */
          }
        }

        return;
      } catch (fetchOrParseError) {
        warn(
          "ontology.fetch.parse.failed",
          {
            url,
            error:
              fetchOrParseError && (fetchOrParseError as any).message
                ? (fetchOrParseError as any).message
                : String(fetchOrParseError),
          },
          { caller: true },
        );
        return;
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
        console.error("Failed to load ontology:", error);
      })();
      throw error;
    }
  },

  validateGraph: (nodes: any[], edges: any[]) => {
    const errors: ValidationError[] = [];
    const { availableClasses, availableProperties } = get();

    nodes.forEach((node) => {
      const nodeData = node.data || node;
      const nodeClass = availableClasses.find(
        (cls) =>
          cls.label === nodeData.classType &&
          cls.namespace === nodeData.namespace,
      );

      if (!nodeClass) {
        errors.push({
          nodeId: node.id,
          message: `Class ${nodeData.namespace || "unknown"}:${nodeData.classType || "unknown"} not found in loaded ontologies`,
          severity: "error",
        });
      }
    });

    edges.forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);

      if (sourceNode && targetNode && edge.data) {
        const property = availableProperties.find(
          (prop) => prop.iri === edge.data.propertyType,
        );

        if (property) {
          const sourceClassUri = `${sourceNode.data.namespace}:${sourceNode.data.classType}`;
          const targetClassUri = `${targetNode.data.namespace}:${targetNode.data.classType}`;

          if (
            property.domain.length > 0 &&
            !property.domain.includes(sourceClassUri)
          ) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} domain restriction violated`,
              severity: "error",
            });
          }

          if (
            property.range.length > 0 &&
            !property.range.includes(targetClassUri)
          ) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} range restriction violated`,
              severity: "error",
            });
          }
        }
      }
    });

    set({ validationErrors: errors });
    return errors;
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

      try {
        const { rdfManager } = get();
        rdfManager.applyParsedNodes(parsed.nodes || [], {
          preserveExistingLiterals: true,
        });

        try {
          const store = rdfManager.getStore();
          (parsed.edges || []).forEach((e: any) => {
            try {
              const s = (parsed.nodes || []).find(
                (n: any) => n.id === e.source,
              );
              const t = (parsed.nodes || []).find(
                (n: any) => n.id === e.target,
              );
              if (!s || !t || !s.iri || !t.iri) return;
              const subj = s.iri;
              const obj = t.iri;
              const pred = e.propertyUri || e.propertyType;
              const existing = store.getQuads(
                namedNode(subj),
                namedNode(pred),
                namedNode(obj),
                null,
              );
              if (!existing || existing.length === 0) {
                try {
                  store.addQuad(
                    quad(namedNode(subj), namedNode(pred), namedNode(obj)),
                  );
                } catch (addErr) {
                  /* ignore */
                }
              }
            } catch (_) {
              /* ignore */
            }
          });
        } catch (_) {
          /* ignore */
        }

        // Note: rdfTypes are already applied by rdfManager.applyParsedNodes earlier.
        // The extra per-node update previously performed here caused duplicate rdf:type
        // triples in some parsing paths (parser + updateNode both adding the same triple).
        // Avoid re-applying rdfTypes here to prevent duplicate triples.
        // (parsed.nodes || []).forEach((node: any) => {
        //   try {
        //     const allTypes =
        //       (node as any).rdfTypes && (node as any).rdfTypes.length > 0
        //         ? (node as any).rdfTypes.slice()
        //         : (node as any).rdfType
        //           ? [(node as any).rdfType]
        //           : [];
        //     if (allTypes && allTypes.length > 0) {
        //       try {
        //         (get().updateNode as any)(node.iri, { rdfTypes: allTypes });
        //       } catch (_) {
        //         /* ignore */
        //       }
        //     }
        //   } catch (_) {
        //     /* ignore */
        //   }
        // });
      } catch (reapplyErr) {
        /* ignore */
      }

      try {
        const nodesForDiagram = (parsed.nodes || [])
          .map((n: any) => {
            const isIriOrBNode = (s?: string) =>
              !!s && (/^https?:\/\//i.test(s) || s.startsWith("_:"));
            const rawId = n && n.id ? String(n.id) : "";
            const rawIri = n && n.iri ? String(n.iri) : "";
            const nodeId = isIriOrBNode(rawId)
              ? rawId
              : isIriOrBNode(rawIri)
                ? rawIri
                : null;

            if (!nodeId) {
              try {
                if (
                  typeof console !== "undefined" &&
                  typeof console.debug === "function"
                ) {
                  console.debug(
                    "[VG_WARN] ontologyStore.skippingParsedNode missing IRI id (nodesForDiagram)",
                    {
                      preview: {
                        id: rawId || undefined,
                        iri: rawIri || undefined,
                      },
                    },
                  );
                }
              } catch (_) {
                /* ignore */
              }
              return null;
            }

            const allTypes =
              (n as any).rdfTypes && (n as any).rdfTypes.length > 0
                ? (n as any).rdfTypes.slice()
                : (n as any).rdfType
                  ? [(n as any).rdfType]
                  : [];
            const meaningful = allTypes.filter(
              (t: string) => t && !String(t).includes("NamedIndividual"),
            );
            const chosen =
              meaningful.length > 0
                ? meaningful[0]
                : allTypes.length > 0
                  ? allTypes[0]
                  : undefined;

            let computedClassType = n.classType;
            let computedNamespace = n.namespace;

            try {
              if (chosen) {
                const chosenStr = String(chosen);
                if (chosenStr.includes(":")) {
                  const idx = chosenStr.indexOf(":");
                  computedNamespace = chosenStr.substring(0, idx);
                  computedClassType = chosenStr.substring(idx + 1);
                } else if (/^https?:\/\//i.test(chosenStr)) {
                  try {
                    const mgr = get().rdfManager;
                    const nsMap =
                      mgr && typeof mgr.getNamespaces === "function"
                        ? mgr.getNamespaces()
                        : {};
                    let matched = false;
                    for (const [p, uri] of Object.entries(nsMap || {})) {
                      if (uri && chosenStr.startsWith(uri)) {
                        computedNamespace = p === ":" ? "" : p;
                        computedClassType = chosenStr.substring(uri.length);
                        matched = true;
                        break;
                      }
                    }
                    if (!matched) {
                      const parts = chosenStr.split(/[#/]/).filter(Boolean);
                      computedClassType = parts.length
                        ? parts[parts.length - 1]
                        : chosenStr;
                    }
                  } catch {
                    const parts = chosenStr.split(/[#/]/).filter(Boolean);
                    computedClassType = parts.length
                      ? parts[parts.length - 1]
                      : chosenStr;
                  }
                } else {
                  const parts = chosenStr.split(/[#/]/).filter(Boolean);
                  computedClassType = parts.length
                    ? parts[parts.length - 1]
                    : chosenStr;
                }
              }
            } catch {
              // ignore
            }

            return {
              id: nodeId,
              iri: n.iri || n.id || "",
              data: {
                individualName:
                  n.individualName || (n.iri ? n.iri.split("/").pop() : nodeId),
                classType: computedClassType,
                namespace: computedNamespace,
                iri: n.iri || n.id || "",
                literalProperties: n.literalProperties || [],
                annotationProperties: n.annotationProperties || [],
              },
            };
          })
          .filter(Boolean);

        const edgesForDiagram = (parsed.edges || []).map((e: any) => {
          const pred = e.propertyUri || e.propertyType || "";
          let label = "";
          try {
            const mgrLocal = get().rdfManager;
            if (mgrLocal && pred) {
              try {
                const td = computeTermDisplay(String(pred), mgrLocal as any);
                label = String(td.prefixed || td.short || "");
              } catch (_) {
                label = "";
              }
            } else {
              label = "";
            }
          } catch (_) {
            label = "";
          }
          return {
            id:
              e.id ||
              generateEdgeId(
                String(e.source),
                String(e.target),
                String(e.propertyType || e.propertyUri || ""),
              ),
            source: e.source,
            target: e.target,
            data: { ...(e || {}), label },
          };
        });

        const existing = get().currentGraph;
        const mergedNodes: any[] = [...existing.nodes];
        const existingUris = new Set<string>();
        existing.nodes.forEach((m: any) => {
          const mid =
            (m &&
              m.data &&
              ((m.data.iri as string) ||
                (m.data.iri as string) ||
                (m.data.individualName as string) ||
                (m.data.id as string))) ||
            m.iri ||
            m.id;
          if (mid) existingUris.add(String(mid));
        });

        (parsed.nodes || []).forEach((n: any) => {
          const nIds = [
            n.iri,
            n.id,
            n.data && n.data.iri,
            n.data && n.data.iri,
            n.data && n.data.individualName,
            n.data && n.data.id,
          ];
          const exists = nIds.some((id) => id && existingUris.has(String(id)));
          if (!exists) {
            const isIriOrBNode = (s?: string) =>
              !!s && (/^https?:\/\//i.test(s) || s.startsWith("_:"));
            const rawId = n && n.id ? String(n.id) : "";
            const rawIri = n && n.iri ? String(n.iri) : "";
            const nodeId = isIriOrBNode(rawId)
              ? rawId
              : isIriOrBNode(rawIri)
                ? rawIri
                : null;

            if (!nodeId) {
              try {
                if (
                  typeof console !== "undefined" &&
                  typeof console.debug === "function"
                ) {
                  console.debug(
                    "[VG_WARN] ontologyStore.skippingParsedNode on merge missing IRI id",
                    {
                      preview: {
                        id: rawId || undefined,
                        iri: rawIri || undefined,
                      },
                    },
                  );
                }
              } catch (_) {
                /* ignore */
              }
              return;
            }

            const nodeObj = {
              id: nodeId,
              iri: n.iri || n.id || "",
              data: {
                individualName:
                  n.individualName || (n.iri ? n.iri.split("/").pop() : nodeId),
                classType: n.classType,
                namespace: n.namespace,
                iri: n.iri || n.id || "",
                literalProperties: n.literalProperties || [],
                annotationProperties: n.annotationProperties || [],
              },
            };
            mergedNodes.push(nodeObj);
            nIds.forEach((id) => {
              if (id) existingUris.add(String(id));
            });
          }
        });

        const mergedEdges: any[] = [...existing.edges];
        (parsed.edges || []).forEach((e: any) => {
          // Normalize edge id and endpoints robustly: some producers use different field names.
          const rawSource =
            e.source ||
            (e.data &&
              (e.data.source ||
                e.data.from ||
                e.data.subj ||
                e.data.subject)) ||
            e.subj ||
            e.subject ||
            e.s ||
            "";
          const rawTarget =
            e.target ||
            (e.data &&
              (e.data.target || e.data.to || e.data.obj || e.data.object)) ||
            e.obj ||
            e.object ||
            e.o ||
            "";
          const edgeId =
            e.id ||
            generateEdgeId(
              String(rawSource),
              String(rawTarget),
              String(e.propertyType || e.propertyUri || ""),
            );
          if (!mergedEdges.find((me: any) => me.id === edgeId)) {
            mergedEdges.push({
              id: edgeId,
              source: String(rawSource || ""),
              target: String(rawTarget || ""),
              data: e,
            });
          }
        });

        set({ currentGraph: { nodes: mergedNodes, edges: mergedEdges } });
        if (typeof window !== "undefined")
          try {
            try {
              console.debug(
                "[VG] ontologyStore: set __VG_REQUEST_LAYOUT_ON_NEXT_MAP (mergedEdges)",
              );
            } catch (_) {}
            (window as any).__VG_REQUEST_LAYOUT_ON_NEXT_MAP = true;
            (window as any).__VG_REQUEST_FIT_ON_NEXT_MAP = true;
          } catch (_) {
            /* ignore */
          }
      } catch (_) {
        /* ignore */
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

  setCurrentGraph: (
    nodes: (ParsedNode | DiagramNode)[],
    edges: (ParsedEdge | DiagramEdge)[],
  ) => {
    try {
      // Lightweight diagnostic to help trace UI updates that originate from different code paths.
      try {
        const sampleEdges = Array.isArray(edges)
          ? (edges as any[]).slice(0, 6).map((e: any) => ({
              id: e.id,
              source: e.source,
              target: e.target,
            }))
          : [];
        console.debug("[VG_DEBUG] ontologyStore.setCurrentGraph", {
          nodesCount: Array.isArray(nodes) ? nodes.length : 0,
          edgesCount: Array.isArray(edges) ? edges.length : 0,
          sampleEdges,
        });
      } catch (_) {
        /* ignore logging failures */
      }

      try {
        if (typeof window !== "undefined") {
          try {
          } catch (_) {
            /* ignore cross-origin / readonly failures */
          }
        }
      } catch (_) {
        /* ignore */
      }
      set({ currentGraph: { nodes, edges } });
      try {
        if (typeof window !== "undefined") {
          try {
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }
    } catch (e) {
      try {
        fallback(
          "ontology.setCurrentGraph.failed",
          { error: String(e) },
          { level: "warn" },
        );
      } catch (_) {
        /* ignore */
      }
      try {
        if (typeof window !== "undefined") {
          try {
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }
      set({ currentGraph: { nodes, edges } });
    }
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
    const { rdfManager } = get();
    switch (format) {
      case "turtle":
        return await rdfManager.exportToTurtle();
      case "json-ld":
        return await rdfManager.exportToJsonLD();
      case "rdf-xml":
        return await rdfManager.exportToRdfXml();
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  },

  reconcileQuads: (quads: any[] | undefined) => {
    try {
      // Use the existing incremental reconciliation helper to update the fat map.
      // This keeps ontology processing centralized in the ontology store.
      try {
        incrementalReconcileFromQuads(quads, get().rdfManager);
      } catch (_) {
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
