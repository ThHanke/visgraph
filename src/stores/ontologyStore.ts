/**
 * @fileoverview Ontology Store
 * Manages loaded ontologies, knowledge graphs, and validation for the application.
 * Provides centralized state management for RDF/OWL data and graph operations.
 */

/* eslint-disable */

import { create } from 'zustand';
import { RDFManager, rdfManager } from '../utils/rdfManager';
import { useAppConfigStore } from './appConfigStore';
import { debug, info, warn, error, fallback } from '../utils/startupDebug';
import type { ParsedGraph } from '../utils/rdfParser';
import { DataFactory } from 'n3';
const { namedNode, quad } = DataFactory;
import { WELL_KNOWN } from '../utils/wellKnownOntologies';

/**
 * Map to track in-flight RDF loads so identical loads return the same Promise.
 * Keyed by the raw RDF content or source identifier.
 */
const inFlightLoads = new Map<string, Promise<void>>();

// Register global well-known prefixes idempotently so other modules can rely on them.
// This avoids inventing synthetic TTL and ensures prefixes such as owl/rdfs/skos/dcterms
// are available for parsing, short-names and exports.
try {
  Object.entries(WELL_KNOWN.prefixes || {}).forEach(([p, uri]) => {
    try { rdfManager.addNamespace(p, uri); } catch (_) { /* ignore individual failures */ }
  });
} catch (_) { /* ignore registration failures */ }

// Opt-in debug logging for call-graph / instrumentation.
// Enable via environment variable VG_CALL_GRAPH_LOGGING=true or via the app config
// store property `callGraphLogging` (useful for tests).
function shouldLogCallGraph(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.VG_CALL_GRAPH_LOGGING === 'true') return true;
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

  try {
    const cfg = useAppConfigStore.getState();
    if (cfg && (cfg as any).callGraphLogging) return true;
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

  return false;
}

function logCallGraph(...args: any[]) {
  if (shouldLogCallGraph()) {
    // Keep logs lightweight and consistent
    ((...__vg_args)=>{try{debug('console.debug',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.debug(...__vg_args);})('[vg-call-graph]', ...args);
  }
}

/**
 * Lightweight types used across this store to avoid pervasive `any`.
 * These model the parsed RDF output and the shapes used by the UI.
 */
type LiteralProperty = { key: string; value: string; type?: string };
type AnnotationPropertyShape = { property?: string; key?: string; value?: string; type?: string; propertyUri?: string };

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
  annotationProperties?: (AnnotationPropertyShape | { propertyUri: string; value: string; type?: string })[];
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

function getNodeData(node: ParsedNode | DiagramNode): any {
  return (node as any).data || node;
}

interface OntologyClass {
  uri: string;
  label: string;
  namespace: string;
  properties: string[];
  restrictions: Record<string, any>;
}

interface ObjectProperty {
  uri: string;
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
}

interface ValidationError {
  nodeId: string;
  message: string;
  severity: 'error' | 'warning';
}

interface OntologyStore {
  loadedOntologies: LoadedOntology[];
  availableClasses: OntologyClass[];
  availableProperties: ObjectProperty[];
  validationErrors: ValidationError[];
  currentGraph: { nodes: (ParsedNode | DiagramNode)[]; edges: (ParsedEdge | DiagramEdge)[] };
  rdfManager: RDFManager;

  loadOntology: (url: string) => Promise<void>;
  loadOntologyFromRDF: (rdfContent: string, onProgress?: (progress: number, message: string) => void, preserveGraph?: boolean, graphName?: string) => Promise<void>;
  loadKnowledgeGraph: (source: string, options?: { onProgress?: (progress: number, message: string) => void; timeout?: number }) => Promise<void>;
  loadAdditionalOntologies: (ontologyUris: string[], onProgress?: (progress: number, message: string) => void) => Promise<void>;
  validateGraph: (nodes: ParsedNode[], edges: ParsedEdge[]) => ValidationError[];
  getCompatibleProperties: (sourceClass: string, targetClass: string) => ObjectProperty[];
  clearOntologies: () => void;
  setCurrentGraph: (nodes: (ParsedNode | DiagramNode)[], edges: (ParsedEdge | DiagramEdge)[]) => void;
  updateNode: (entityUri: string, updates: Record<string, unknown>) => void;
  exportGraph: (format: 'turtle' | 'json-ld' | 'rdf-xml') => Promise<string>;
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

  loadOntology: async (url: string) => {
    logCallGraph?.('loadOntology:start', url);
    try {
      const wellKnownOntologies = WELL_KNOWN.ontologies;

      const { rdfManager } = get();
      const preserveGraph = true;

      const wkEntry = WELL_KNOWN.ontologies[url as keyof typeof WELL_KNOWN.ontologies];
      if (wkEntry) {
        // For well-known ontology URLs we avoid inventing mock classes/properties.
        // Instead ensure the relevant namespace prefixes are registered in the RDF manager
        // so UI shortnames and exports work consistently even if we don't fetch real ontology triples.
        try {
          const nsMap = wkEntry && wkEntry.namespaces ? wkEntry.namespaces : {};
          // Ensure common ontology prefixes are present (idempotent)
          ensureNamespacesPresent(rdfManager, {
            rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
            owl: 'http://www.w3.org/2002/07/owl#',
            skos: 'http://www.w3.org/2004/02/skos/core#',
            dcterms: 'http://purl.org/dc/terms/',
            ...nsMap
          });
        } catch (e) {
          try { fallback('rdf.addNamespace.failed', { error: String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }

        const loadedOntology: LoadedOntology = {
          url,
          name: wkEntry.name || getOntologyName(url),
          classes: [],
          properties: [],
          namespaces: rdfManager.getNamespaces()
        };

        set((state) => ({
          loadedOntologies: [...state.loadedOntologies, loadedOntology],
          availableClasses: [...state.availableClasses],
          availableProperties: [...state.availableProperties]
        }));

        // Persist a "recent ontology" entry so the UI can surface recently loaded ontologies.
        try {
          const appCfg = useAppConfigStore.getState();
          if (appCfg && typeof appCfg.addRecentOntology === 'function') {
            let norm = url;
            try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
            appCfg.addRecentOntology(norm);
          }
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

        return;
      }

      // Centralized fetch & mime detection via RDFManager helper
      try {
        const { rdfManager } = get();
        const { content, mimeType } = await rdfManager.loadFromUrl(url, { timeoutMs: 15000, onProgress: (p: number, m: string) => {/* no-op or forward */} });
        const { parseRDFFile } = await import('../utils/rdfParser');
        const parsed = await parseRDFFile(content);

        // Match parsed namespaces to canonical well-known ontologies (idempotent metadata only).
        try {
          const parsedNamespaces = parsed.namespaces || {};
          const canonicalByNs: Record<string, string> = {};

          // Build reverse lookup from known ontology namespace URIs -> canonical ontology URL
          Object.entries(WELL_KNOWN.ontologies || {}).forEach(([ontUrl, meta]: any) => {
            if (meta && meta.namespaces) {
              Object.values(meta.namespaces).forEach((nsUri: any) => {
                try { canonicalByNs[String(nsUri)] = ontUrl; } catch (_) { /* ignore */ }
              });
            }
          });

          // Also consider WELL_KNOWN.prefixes where an ontology URL might match a prefix URI
          Object.values(WELL_KNOWN.prefixes || {}).forEach((nsUri: any) => {
            try {
              if (WELL_KNOWN.ontologies[String(nsUri)]) canonicalByNs[String(nsUri)] = String(nsUri);
            } catch (_) { /* ignore */ }
          });

          // For each parsed namespace, if it maps back to a canonical ontology URL,
          // add a LoadedOntology metadata entry (if not already present). Do not alter
          // the RDF store contents beyond applying parsed namespaces.
          Object.entries(parsedNamespaces).forEach(([p, nsUri]) => {
            try {
              const canonical = canonicalByNs[String(nsUri)];
              if (!canonical) return;
              const already = (get().loadedOntologies || []).some((o: any) => o.url === canonical);
              if (!already) {
                const wk = WELL_KNOWN.ontologies[canonical];
                const meta: LoadedOntology = {
                  url: canonical,
                  name: (wk && wk.name) ? wk.name : String(canonical),
                  classes: [],
                  properties: [],
                  namespaces: parsed.namespaces || {}
                };
                set((state) => ({ loadedOntologies: [...state.loadedOntologies, meta] }));
              }
            } catch (_) { /* ignore per-namespace errors */ }
          });
        } catch (e) { try { fallback('wellknown.match.failed', { error: String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ } }


        const ontologyClasses: OntologyClass[] = [];
        const ontologyProperties: ObjectProperty[] = [];

        const classGroups = new Map<string, any[]>();
        parsed.nodes.forEach(node => {
          const updates: any = {};
          // Collect all rdf type candidates, preferring rdfTypes array when present
          const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
            ? (node as any).rdfTypes.slice()
            : ((node as any).rdfType ? [(node as any).rdfType] : []);
          // Prefer non-NamedIndividual types as "meaningful". If none found, preserve whatever types exist.
          const meaningful = allTypes.filter((t: string) => t && !String(t).includes('NamedIndividual'));
          if (meaningful.length > 0) {
            // Provide the full list of meaningful types so the RDF manager can preserve them.
            updates.rdfTypes = meaningful;
          } else if (allTypes.length > 0) {
            updates.rdfTypes = allTypes;
          } else if (node.classType && node.namespace) {
            updates.rdfTypes = [`${node.namespace}:${node.classType}`];
          }

          if (node.literalProperties && node.literalProperties.length > 0) {
            updates.annotationProperties = node.literalProperties.map(prop => ({
              propertyUri: prop.key,
              value: prop.value,
              type: prop.type || 'xsd:string'
            }));
          } else if ((node as any).annotationProperties && (node as any).annotationProperties.length > 0) {
            updates.annotationProperties = (node as any).annotationProperties.map((ap: any) => ({
              propertyUri: ap.propertyUri || ap.property || ap.key,
              value: ap.value,
              type: ap.type || 'xsd:string'
            }));
          }

          const isIndividual = (node as any).entityType === 'individual';
          const hasLiterals = node.literalProperties && node.literalProperties.length > 0;
          if ((isIndividual || hasLiterals) && Object.keys(updates).length > 0) {
            rdfManager.updateNode(node.uri, updates);
            // lightweight log for debug when running focused tests
            // ((...__vg_args)=>{try{debug('console.debug',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.debug(...__vg_args);})(`Loaded entity ${node.uri} into RDF store with type ${updates.type}`);
          }

          const classKey = `${node.namespace}:${node.classType}`;
          if (!classGroups.has(classKey)) classGroups.set(classKey, []);
          classGroups.get(classKey)!.push(node);
        });

        classGroups.forEach((nodes, classKey) => {
          const firstNode = nodes[0];
          const properties = Array.from(new Set(
            nodes.flatMap((node: any) => (node.literalProperties || []).map((p: any) => p.key))
          ));
          ontologyClasses.push({
            uri: classKey,
            label: firstNode.classType,
            namespace: firstNode.namespace,
            properties,
            restrictions: {}
          });
        });

        const propertyGroups = new Map<string, any[]>();
        parsed.edges.forEach(edge => {
          if (!propertyGroups.has(edge.propertyType)) propertyGroups.set(edge.propertyType, []);
          propertyGroups.get(edge.propertyType)!.push(edge);
        });

        propertyGroups.forEach((edges, propertyType) => {
          const domains = Array.from(new Set(edges.map((edge: any) => {
            const s = parsed.nodes.find((n: any) => n.id === edge.source);
            return s ? `${s.namespace}:${s.classType}` : '';
          }).filter(Boolean)));

          const ranges = Array.from(new Set(edges.map((edge: any) => {
            const t = parsed.nodes.find((n: any) => n.id === edge.target);
            return t ? `${t.namespace}:${t.classType}` : '';
          }).filter(Boolean)));

          const firstEdge = edges[0];
          ontologyProperties.push({
            uri: propertyType,
            label: firstEdge.label,
            domain: domains,
            range: ranges,
            namespace: firstEdge.namespace
          });
        });

        const loadedOntology: LoadedOntology = {
          url,
          name: getOntologyName(url),
          classes: ontologyClasses,
          properties: ontologyProperties,
          namespaces: parsed.namespaces
        };

        try {
          const { rdfManager } = get();
          Object.entries(parsed.namespaces || {}).forEach(([prefix, ns]) => {
            rdfManager.addNamespace(prefix, ns);
          });
        } catch (nsErr) {
          try { fallback('rdf.namespaces.add.failed', { error: String(nsErr) }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        }

        set((state) => ({
          loadedOntologies: [...state.loadedOntologies, loadedOntology],
          availableClasses: [...state.availableClasses, ...ontologyClasses],
          availableProperties: [...state.availableProperties, ...ontologyProperties]
        }));

        // Persist a "recent ontology" entry so the UI can surface recently loaded ontologies.
        try {
          const appCfg = useAppConfigStore.getState();
          if (appCfg && typeof appCfg.addRecentOntology === 'function') {
            let norm = url;
            try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
            appCfg.addRecentOntology(norm);
          }
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

        // Update currentGraph (respect preserveGraph param) and merge parsed graph nodes/edges
        try {
          const nodes = (parsed.nodes || []).map((n: any) => {
            const nodeId = n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random());
            // Prefer a meaningful (non-NamedIndividual) rdf:type when deciding the node's
            // classType/namespace for the diagram. This ensures UI badges show the actual
            // class (e.g. iof-mat:Specimen) rather than the generic owl:NamedIndividual.
            const allTypes = (n as any).rdfTypes && (n as any).rdfTypes.length > 0
              ? (n as any).rdfTypes.slice()
              : ((n as any).rdfType ? [(n as any).rdfType] : []);
            const meaningful = allTypes.filter((t: string) => t && !String(t).includes('NamedIndividual'));
            const chosen = meaningful.length > 0 ? meaningful[0] : (allTypes.length > 0 ? allTypes[0] : undefined);

            let computedClassType = n.classType;
            let computedNamespace = n.namespace;

            try {
              if (chosen) {
                const chosenStr = String(chosen);
                if (chosenStr.includes(':')) {
                  const idx = chosenStr.indexOf(':');
                  computedNamespace = chosenStr.substring(0, idx);
                  computedClassType = chosenStr.substring(idx + 1);
                } else if (/^https?:\/\//i.test(chosenStr)) {
                  // Try to map full URI back to a known prefix via rdfManager if available
                  try {
                    const mgr = get().rdfManager;
                    const nsMap = (mgr && typeof mgr.getNamespaces === 'function') ? mgr.getNamespaces() : {};
                    let matched = false;
                    for (const [p, uri] of Object.entries(nsMap || {})) {
                      if (uri && chosenStr.startsWith(uri)) {
                        computedNamespace = p === ':' ? '' : p;
                        computedClassType = chosenStr.substring(uri.length);
                        matched = true;
                        break;
                      }
                    }
                    if (!matched) {
                      // fallback to short local name from the URI
                      const parts = chosenStr.split(/[#/]/).filter(Boolean);
                      computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                    }
                  } catch {
                    const parts = chosenStr.split(/[#/]/).filter(Boolean);
                    computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                  }
                } else {
                  const parts = chosenStr.split(/[#/]/).filter(Boolean);
                  computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                }
              }
            } catch {
              // ignore and fall back to parser-provided classType/namespace
            }

            return {
              id: nodeId,
              uri: n.uri || n.iri,
              data: {
                individualName: n.individualName || (n.uri ? n.uri.split('/').pop() : nodeId),
                classType: computedClassType,
                namespace: computedNamespace,
                uri: n.uri || n.iri,
                literalProperties: n.literalProperties || [],
                annotationProperties: n.annotationProperties || []
              }
            };
          });

          const edges = (parsed.edges || []).map((e: any) => ({
            id: e.id || `${e.source}-${e.target}-${e.propertyType}`,
            source: e.source,
            target: e.target,
            data: e
          }));

          if (!preserveGraph) {
            set({ currentGraph: { nodes, edges } });
          } else {
            const existing = get().currentGraph;
            const mergedNodes: any[] = [...existing.nodes];
            const existingUris = new Set<string>();
            existing.nodes.forEach((m: any) => {
              const mid = (m && m.data && ((m.data.uri as string) || (m.data.iri as string) || (m.data.individualName as string) || (m.data.id as string))) || m.uri || m.id;
              if (mid) existingUris.add(String(mid));
            });

            (parsed.nodes || []).forEach((n: any) => {
              const nIds = [n.uri, n.id, (n.data && n.data.uri), (n.data && n.data.iri), (n.data && n.data.individualName), (n.data && n.data.id)];
              const exists = nIds.some((id) => id && existingUris.has(String(id)));
              if (!exists) {
                const nodeObj = {
                  id: n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random()),
                  uri: n.uri || n.iri,
                  data: {
                    individualName: n.individualName || (n.uri ? n.uri.split('/').pop() : (n.id || '')),
                    classType: n.classType,
                    namespace: n.namespace,
                    uri: n.uri || n.iri,
                    literalProperties: n.literalProperties || [],
                    annotationProperties: n.annotationProperties || []
                  }
                };
                mergedNodes.push(nodeObj);
                nIds.forEach(id => { if (id) existingUris.add(String(id)); });
              }
            });

            const mergedEdges: any[] = [...existing.edges];
            (parsed.edges || []).forEach((e: any) => {
              const edgeId = e.id || `${e.source}-${e.target}-${e.propertyType}`;
              if (!mergedEdges.find((me: any) => me.id === edgeId)) {
                mergedEdges.push({
                  id: edgeId,
                  source: e.source,
                  target: e.target,
                  data: e
                });
              }
            });

            set({ currentGraph: { nodes: mergedNodes, edges: mergedEdges } });
          }
        } catch (mergeErr) {
          ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to update currentGraph from parsed RDF:', mergeErr);
        }

        // Centralized: merge namespaces and apply parsed nodes idempotently via RDFManager helpers.
        try {
          const { rdfManager } = get();
          rdfManager.applyParsedNamespaces(parsed.namespaces || {});
          rdfManager.applyParsedNodes(parsed.nodes || [], { preserveExistingLiterals: true });

          // Also ensure object property triples (edges) are persisted into the RDF store so
          // downstream components (reasoner, exporters) can rely on them. Map parsed edge
          // source/target ids back to node URIs and add named-node triples idempotently.
          try {
            const store = rdfManager.getStore();
            (parsed.edges || []).forEach((e: any) => {
              try {
                // Find source and target nodes to obtain real IRIs
                const s = (parsed.nodes || []).find((n: any) => n.id === e.source);
                const t = (parsed.nodes || []).find((n: any) => n.id === e.target);
                if (!s || !t || !s.uri || !t.uri) return;

                const subj = s.uri;
                const obj = t.uri;
                const pred = e.propertyUri || e.propertyType;

                // Expand predicate to full IRI using rdfManager and avoid duplicate quads by checking existence first
                const predFull = rdfManager && typeof rdfManager.expandPrefix === 'function' ? rdfManager.expandPrefix(pred) : pred;
                try {
                  const existing = store.getQuads(namedNode(subj), namedNode(predFull), namedNode(obj), null);
                    if (!existing || existing.length === 0) {
                    try {
                      store.addQuad(quad(namedNode(subj), namedNode(predFull), namedNode(obj)));
                    } catch (addErr) {
                      // best-effort: ignore if adding fails
                      try { fallback('rdf.addQuad.objectProperty.failed', { subj, pred: predFull, obj, error: String(addErr) }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
                    }
                  }
                } catch (e) {
                  // If getQuads with namedNode throws for any reason, fallback to best-effort add with expanded predicate
                  try {
                    store.addQuad(quad(namedNode(subj), namedNode(predFull), namedNode(obj)));
                  } catch (addErr) {
                    ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to add object property quad (fallback) for', subj, predFull, obj, addErr);
                  }
                }
              } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
            });
          } catch (edgeErr) {
            try { fallback('rdf.persist.edges.failed', { error: String(edgeErr) }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
          }

          // Keep compatibility: also ensure the in-memory graph reflects parsed rdfTypes where present.
          (parsed.nodes || []).forEach((node: any) => {
            try {
              const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
                ? (node as any).rdfTypes.slice()
                : ((node as any).rdfType ? [(node as any).rdfType] : []);
              if (allTypes && allTypes.length > 0) {
                try { (get().updateNode as any)(node.uri, { rdfTypes: allTypes }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
              }
            } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
          });
        } catch (reapplyErr) {
          try { fallback('rdf.reapply.failed', { error: String(reapplyErr) }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        }

        // Add a loaded ontology meta entry
        try {
          const loadedOntology: LoadedOntology = {
            url: 'parsed-rdf',
            name: 'Parsed RDF Graph',
            classes: [],
            properties: [],
            namespaces: parsed.namespaces || {}
          };
          set((state) => ({
            loadedOntologies: [...state.loadedOntologies, loadedOntology]
          }));
        } catch (metaErr) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(metaErr) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

        return;
      } catch (fetchOrParseError) {
        warn('ontology.fetch.parse.failed', { url, error: (fetchOrParseError && (fetchOrParseError as Error).message) ? (fetchOrParseError as Error).message : String(fetchOrParseError) }, { caller: true });
        // No fallback — per policy do not register synthetic ontology metadata on fetch/parse failure.
        return;
      }

      // In cases where fetching/parsing the remote ontology failed we still register
      // the URL as a loaded ontology entry but do not invent classes/properties.
      try {
        ensureNamespacesPresent(rdfManager, {
          rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
          owl: 'http://www.w3.org/2002/07/owl#',
          skos: 'http://www.w3.org/2004/02/skos/core#',
          dcterms: 'http://purl.org/dc/terms/'
        });
      } catch (_) { /* ignore */ }

      const mockOntology: LoadedOntology = {
        url,
        name: getOntologyName(url),
        classes: [],
        properties: [],
        namespaces: rdfManager.getNamespaces()
      };

      set((state) => ({
        loadedOntologies: [...state.loadedOntologies, mockOntology],
        availableClasses: [...state.availableClasses],
        availableProperties: [...state.availableProperties]
      }));

      // Persist recent ontology entry for user convenience
      try {
        const appCfg = useAppConfigStore.getState();
        if (appCfg && typeof appCfg.addRecentOntology === 'function') {
          let norm = url;
          try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
          appCfg.addRecentOntology(norm);
        }
      } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
    } catch (error) {
      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load ontology:', error);
      throw error;
    }
  },

  validateGraph: (nodes: any[], edges: any[]) => {
    const errors: ValidationError[] = [];
    const { availableClasses, availableProperties } = get();

    nodes.forEach(node => {
      const nodeData = node.data || node;
      const nodeClass = availableClasses.find(cls =>
        cls.label === nodeData.classType && cls.namespace === nodeData.namespace
      );

      if (!nodeClass) {
        errors.push({
          nodeId: node.id,
          message: `Class ${nodeData.namespace || 'unknown'}:${nodeData.classType || 'unknown'} not found in loaded ontologies`,
          severity: 'error'
        });
      }
    });

    edges.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);

      if (sourceNode && targetNode && edge.data) {
        const property = availableProperties.find(prop =>
          prop.uri === edge.data.propertyType
        );

        if (property) {
          const sourceClassUri = `${sourceNode.data.namespace}:${sourceNode.data.classType}`;
          const targetClassUri = `${targetNode.data.namespace}:${targetNode.data.classType}`;

          if (property.domain.length > 0 && !property.domain.includes(sourceClassUri)) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} domain restriction violated`,
              severity: 'error'
            });
          }

          if (property.range.length > 0 && !property.range.includes(targetClassUri)) {
            errors.push({
              nodeId: edge.id,
              message: `Property ${edge.data.propertyType} range restriction violated`,
              severity: 'error'
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

    return availableProperties.filter(prop => {
      const domainMatch = prop.domain.length === 0 || prop.domain.includes(sourceClass);
      const rangeMatch = prop.range.length === 0 || prop.range.includes(targetClass);
      return domainMatch && rangeMatch;
    });
  },

  loadOntologyFromRDF: async (rdfContent: string, onProgress?: (progress: number, message: string) => void, preserveGraph: boolean = true, graphName?: string) => {
    // Parse raw RDF content and merge into the RDF manager + currentGraph.
    // This function accepts raw RDF (Turtle/JSON-LD/RDF/XML) and must not treat the
    // content as a URL (unlike loadOntology).
    logCallGraph?.('loadOntologyFromRDF:start', { length: (rdfContent || '').length });
    try {
      const { parseRDFFile } = await import('../utils/rdfParser');
      const { rdfManager } = get();

      onProgress?.(10, 'Starting RDF parsing...');

      // Best-effort: populate rdfManager directly from raw content first so any triples
      // (including annotation properties like dc:description and domain/range on properties)
      // are present in the RDFManager's store for downstream consumers (reasoner/exporter).
      // Keep this wrapped in try/catch because some RDF inputs may be malformed for the N3 parser
      // or this environment; parsed graph helpers below remain authoritative and idempotent.
      try {
        // Await intentionally so the store is populated before further processing.
        // applyParsedNodes is idempotent so duplicates are avoided.
        await rdfManager.loadRDFIntoGraph(rdfContent, graphName);
      } catch (loadErr) {
        // best-effort - log and continue with parsed application which will also ensure data is persisted
        warn('rdfManager.loadIntoGraph.failed', { error: (loadErr && (loadErr as Error).message) ? (loadErr as Error).message : String(loadErr) }, { caller: true });
      }

      // Diagnostics: report whether the expected dc:description triple exists immediately after loadRDF.
      try {
        const store = rdfManager.getStore();
        const totalQuads = store.getQuads(null, null, null, null).length;
        const dcFull = rdfManager.expandPrefix('dc:description');
        const hasDc = store.getQuads(null, null, null, null).some((q: any) => (q.predicate && q.predicate.value) === dcFull);
      } catch (diagErr) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(diagErr) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

      const parsed = await parseRDFFile(rdfContent, onProgress);

      // Diagnostic: if parsed nodes include 'Specimen' (or other interesting URIs), dump quads for inspection.
      try {
        const store = rdfManager.getStore();
        (parsed.nodes || []).forEach((n: any) => {
          if (n && n.uri && typeof n.uri === 'string' && (n.uri.includes('Specimen') || n.uri.includes('SpecimenLength'))) {
            const all = store.getQuads(null, null, null, null) || [];
            const subjectQuads = all.filter((q: any) => q.subject && q.subject.value === n.uri);
            debug('rdfManager.parsedNode.quads', { uri: n.uri, quads: subjectQuads.map((q: any) => ({
              predicate: q.predicate && q.predicate.value,
              object: q.object && (q.object.value || (q.object && q.object.id) || null)
            })) }, { caller: true });
          }
        });
      } catch (diagErr) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(diagErr) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

      // Add parsed namespaces to RDF manager and apply parsed nodes via helpers
      try {
        const { rdfManager } = get();
        rdfManager.applyParsedNamespaces(parsed.namespaces || {});
        rdfManager.applyParsedNodes(parsed.nodes || [], { preserveExistingLiterals: true });

        // Also ensure object property triples (edges) are persisted into the RDF store so
        // downstream components (reasoner, exporters) can rely on them. Map parsed edge
        // source/target ids back to node URIs and add named-node triples idempotently.
        try {
          const store = rdfManager.getStore();
          (parsed.edges || []).forEach((e: any) => {
            try {
              // Find source and target nodes to obtain real IRIs
              const s = (parsed.nodes || []).find((n: any) => n.id === e.source);
              const t = (parsed.nodes || []).find((n: any) => n.id === e.target);
              if (!s || !t || !s.uri || !t.uri) return;

              const subj = s.uri;
              const obj = t.uri;
              const pred = e.propertyUri || e.propertyType;

              // Avoid duplicate quads by checking existence first
              const existing = store.getQuads(subj, pred, obj, null);
              if (!existing || existing.length === 0) {
                try {
                  store.addQuad(quad(namedNode(subj), namedNode(pred), namedNode(obj)));
                } catch (addErr) {
                  // best-effort: ignore if adding fails
                  ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to add object property quad for', subj, pred, obj, addErr);
                }
              }
            } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
          });
        } catch (edgeErr) {
          ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to persist parsed edges into RDF store:', edgeErr);
        }

        // Keep compatibility: also ensure the in-memory graph reflects parsed rdfTypes where present.
        (parsed.nodes || []).forEach((node: any) => {
          try {
            const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
              ? (node as any).rdfTypes.slice()
              : ((node as any).rdfType ? [(node as any).rdfType] : []);
            if (allTypes && allTypes.length > 0) {
              try { (get().updateNode as any)(node.uri, { rdfTypes: allTypes }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
            }
          } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        });
        // Keep compatibility: also ensure the in-memory graph reflects parsed rdfTypes where present.
        (parsed.nodes || []).forEach((node: any) => {
          try {
            const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
              ? (node as any).rdfTypes.slice()
              : ((node as any).rdfType ? [(node as any).rdfType] : []);
            if (allTypes && allTypes.length > 0) {
              try { (get().updateNode as any)(node.uri, { rdfTypes: allTypes }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
            }
          } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        });
      } catch (reapplyErr) {
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('reapply annotations failed:', reapplyErr);
      }

      // Build diagram-friendly nodes/edges and merge into currentGraph according to preserveGraph
      try {
        const nodesForDiagram = (parsed.nodes || []).map((n: any) => {
          const nodeId = n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random());
          // Derive a meaningful classType/namespace for diagram nodes preferring non-NamedIndividual rdf:types.
          const allTypes = (n as any).rdfTypes && (n as any).rdfTypes.length > 0
            ? (n as any).rdfTypes.slice()
            : ((n as any).rdfType ? [(n as any).rdfType] : []);
          const meaningful = allTypes.filter((t: string) => t && !String(t).includes('NamedIndividual'));
          const chosen = meaningful.length > 0 ? meaningful[0] : (allTypes.length > 0 ? allTypes[0] : undefined);

          let computedClassType = n.classType;
          let computedNamespace = n.namespace;

          try {
            if (chosen) {
              const chosenStr = String(chosen);
              if (chosenStr.includes(':')) {
                const idx = chosenStr.indexOf(':');
                computedNamespace = chosenStr.substring(0, idx);
                computedClassType = chosenStr.substring(idx + 1);
              } else if (/^https?:\/\//i.test(chosenStr)) {
                try {
                  const mgr = get().rdfManager;
                  const nsMap = (mgr && typeof mgr.getNamespaces === 'function') ? mgr.getNamespaces() : {};
                  let matched = false;
                  for (const [p, uri] of Object.entries(nsMap || {})) {
                    if (uri && chosenStr.startsWith(uri)) {
                      computedNamespace = p === ':' ? '' : p;
                      computedClassType = chosenStr.substring(uri.length);
                      matched = true;
                      break;
                    }
                  }
                  if (!matched) {
                    const parts = chosenStr.split(/[#/]/).filter(Boolean);
                    computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                  }
                } catch {
                  const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                  computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                }
              } else {
                const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
              }
            }
          } catch {
            // ignore and fall back to parser-provided values
          }

          return {
            id: nodeId,
            uri: n.uri || n.iri,
            data: {
              individualName: n.individualName || (n.uri ? n.uri.split('/').pop() : nodeId),
              classType: computedClassType,
              namespace: computedNamespace,
              uri: n.uri || n.iri,
              literalProperties: n.literalProperties || [],
              annotationProperties: n.annotationProperties || []
            }
          };
        });

        const edgesForDiagram = (parsed.edges || []).map((e: any) => ({
          id: e.id || `${e.source}-${e.target}-${e.propertyType}`,
          source: e.source,
          target: e.target,
          data: e
        }));

        if (!preserveGraph) {
          set({ currentGraph: { nodes: nodesForDiagram, edges: edgesForDiagram } });
        } else {
          const existing = get().currentGraph;
          const mergedNodes: any[] = [...existing.nodes];
          const existingUris = new Set<string>();
          existing.nodes.forEach((m: any) => {
            const mid = (m && m.data && ((m.data.uri as string) || (m.data.iri as string) || (m.data.individualName as string) || (m.data.id as string))) || m.uri || m.id;
            if (mid) existingUris.add(String(mid));
          });

          (parsed.nodes || []).forEach((n: any) => {
            const nIds = [n.uri, n.id, (n.data && n.data.uri), (n.data && n.data.iri), (n.data && n.data.individualName), (n.data && n.data.id)];
            const exists = nIds.some((id) => id && existingUris.has(String(id)));
            if (!exists) {
              const nodeObj = {
                id: n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random()),
                uri: n.uri || n.iri,
                data: {
                  individualName: n.individualName || (n.uri ? n.uri.split('/').pop() : (n.id || '')),
                  classType: n.classType,
                  namespace: n.namespace,
                  uri: n.uri || n.iri,
                  literalProperties: n.literalProperties || [],
                  annotationProperties: n.annotationProperties || []
                }
              };
              mergedNodes.push(nodeObj);
              nIds.forEach(id => { if (id) existingUris.add(String(id)); });
            }
          });

          const mergedEdges: any[] = [...existing.edges];
          (parsed.edges || []).forEach((e: any) => {
            const edgeId = e.id || `${e.source}-${e.target}-${e.propertyType}`;
            if (!mergedEdges.find((me: any) => me.id === edgeId)) {
              mergedEdges.push({
                id: edgeId,
                source: e.source,
                target: e.target,
                data: e
              });
            }
          });

          set({ currentGraph: { nodes: mergedNodes, edges: mergedEdges } });
        }
        } catch (mergeErr) {
          try { fallback('graph.merge.failed', { error: String(mergeErr) }, { level: 'warn', captureStack: true }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        }

      return;
    } catch (error) {
      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load ontology from RDF:', error);
      throw error;
    }
  },

  loadKnowledgeGraph: async (source: string, options?: { onProgress?: (progress: number, message: string) => void; timeout?: number }) => {
    logCallGraph?.('loadKnowledgeGraph:start', source);
    const timeout = options?.timeout || 30000;

    try {
      let rdfContent: string;

      if (source.startsWith('http://') || source.startsWith('https://')) {
        options?.onProgress?.(10, 'Fetching RDF from URL...');
        // Delegate fetching and CORS/proxy handling to rdfManager.loadFromUrl so that
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeout);

        try {
          const candidateUrls = source.startsWith('http://') ? [source.replace(/^http:\/\//, 'https://'), source] : [source];
          let response: Response | null = null;
          let lastFetchError: any = null;
          for (const candidate of candidateUrls) {
            try {
              response = await fetch(candidate, {
                signal: controller.signal,
                headers: {
                  'Accept': 'text/turtle, application/rdf+xml, application/ld+json, */*'
                }
              });
              break;
            } catch (err) {
              lastFetchError = err;
              ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})(`Fetch failed for ${candidate}:`, err);
            }
          }



          if (!response || !response.ok) {
            const fetchErr = lastFetchError || new Error(`Failed to fetch RDF from ${source}`);
            try {
              if (typeof window !== 'undefined') {
                try { (window as any).__VG_LAST_RDF_ERROR = { message: String(fetchErr), url: source, snippet: '' }; } catch (_) { /* ignore */ }
                try { window.dispatchEvent(new CustomEvent('vg:rdf-parse-error', { detail: (window as any).__VG_LAST_RDF_ERROR })); } catch (_) { /* ignore */ }
              }
            } catch (_) { /* ignore */ }
            throw fetchErr;
          }

          const contentLength = response.headers.get('content-length');
          if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
            throw new Error('File too large (>10MB). Please use a smaller file.');
          }

          rdfContent = await response.text();
          options?.onProgress?.(20, 'RDF content downloaded');
        } catch (error: any) {

          if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout / 1000} seconds. The file might be too large.`);
          }
          throw error;
        }
      } else {
        rdfContent = source;
      }

      await get().loadOntologyFromRDF(rdfContent, options?.onProgress, true, source);

      options?.onProgress?.(90, 'Checking for additional ontologies...');
      const extractedOntologies = extractReferencedOntologies(rdfContent);

      // Only auto-load additional ontologies that are explicitly configured by the user
      // (app config `additionalOntologies`). Detecting prefixes in incoming RDF is still
      // useful for namespace recognition, but should not trigger network loads unless the
      // ontology is configured for auto-load.
      if (extractedOntologies.length > 0) {
        try {
          const appCfg = useAppConfigStore.getState();
          const configured = (appCfg && appCfg.config && Array.isArray(appCfg.config.additionalOntologies))
            ? appCfg.config.additionalOntologies
            : [];

          // Normalize helper to match the normalization used elsewhere in this file.
          function normalizeUri(u: string): string {
            try {
              return new URL(String(u)).toString();
            } catch {
              return typeof u === 'string' ? u.replace(/\/+$/, '') : u;
            }
          }

          const configuredNorm = new Set(configured.map((u: string) => normalizeUri(u)));
          const toLoad = extractedOntologies.filter((u: string) => configuredNorm.has(normalizeUri(u)));

          if (toLoad.length > 0) {
            await get().loadAdditionalOntologies(toLoad, options?.onProgress);
          } else {
            options?.onProgress?.(100, 'No configured additional ontologies referenced; skipping auto-load');
          }
        } catch (e) {
          // Preserve previous behavior of best-effort but avoid throwing from this optional step.
          ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed while computing configured additional ontologies to auto-load:', e);
        }
      }
    } catch (error) {

      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load knowledge graph:', error);
      throw error;
    }
  },

    loadAdditionalOntologies: async (ontologyUris: string[], onProgress?: (progress: number, message: string) => void) => {
    logCallGraph?.('loadAdditionalOntologies:start', ontologyUris && ontologyUris.length);
    const { loadedOntologies } = get();
    const alreadyLoaded = new Set(loadedOntologies.map(o => o.url));

    // Helper: normalize URLs to a canonical form for reliable comparisons
    function normalizeUri(u: string): string {
      try {
        return new URL(u).toString();
      } catch {
        // fallback: trim trailing slash for simple normalization
        return typeof u === 'string' ? u.replace(/\/+$/, '') : u;
      }
    }

    // Respect user-disabled ontologies so a removed entry isn't re-loaded when referenced by a graph.
    // Use normalized URL comparisons for both already-loaded and disabled lists to avoid mismatch.
    const appCfg = useAppConfigStore.getState();
    const disabled = (appCfg && appCfg.config && Array.isArray(appCfg.config.disabledAdditionalOntologies)) ? appCfg.config.disabledAdditionalOntologies : [];
    const disabledNorm = disabled.map(d => normalizeUri(d));

    // Normalize alreadyLoaded URLs as well for reliable comparison.
    const alreadyLoadedNorm = new Set(Array.from(alreadyLoaded).map(u => normalizeUri(String(u))));

    const toLoad = ontologyUris.filter(uri => {
      const norm = normalizeUri(uri);
      return !alreadyLoadedNorm.has(norm) && !disabledNorm.includes(norm);
    });

    if (toLoad.length === 0) {
      onProgress?.(100, 'No new ontologies to load');
      return;
    }

    onProgress?.(95, `Loading ${toLoad.length} additional ontologies...`);

    const wellKnownOntologies = WELL_KNOWN.ontologies;

    const appConfigStore = useAppConfigStore.getState();

    for (let i = 0; i < toLoad.length; i++) {
      const uri = toLoad[i];
          const wkEntry = WELL_KNOWN.ontologies[uri as keyof typeof WELL_KNOWN.ontologies];
          const ontologyName = wkEntry ? wkEntry.name : undefined;

      try {
        onProgress?.(95 + (i / toLoad.length) * 5, `Loading ${ontologyName || uri}...`);

        if (wkEntry) {
          try {
            ensureNamespacesPresent(get().rdfManager, wkEntry.namespaces || {});
            ensureNamespacesPresent(get().rdfManager, {
              rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
              owl: 'http://www.w3.org/2002/07/owl#',
              skos: 'http://www.w3.org/2004/02/skos/core#',
              dcterms: 'http://purl.org/dc/terms/'
            });
          } catch (_) { /* ignore */ }

          const mockOntology: LoadedOntology = {
            url: uri,
            name: wkEntry ? (wkEntry.name || uri.split('/').pop() || 'Known Ontology') : (uri.split('/').pop() || 'Known Ontology'),
            classes: [],
            properties: [],
            namespaces: get().rdfManager.getNamespaces()
          };
          set((state) => ({
            loadedOntologies: [...state.loadedOntologies, mockOntology],
            availableClasses: [...state.availableClasses],
            availableProperties: [...state.availableProperties]
          }));
        } else {
          if (uri.startsWith('http://') || uri.startsWith('https://')) {
            try {
              const candidateUrls = uri.startsWith('http://') ? [uri.replace(/^http:\/\//, 'https://'), uri] : [uri];
              let response: Response | null = null;
              let lastFetchError: any = null;
              for (const candidate of candidateUrls) {
                try {
                  response = await fetch(candidate, {
                    headers: { 'Accept': 'text/turtle, application/rdf+xml, application/ld+json, */*' },
                    signal: AbortSignal.timeout(10000)
                  });
                  break;
                } catch (err) {
                  lastFetchError = err;
                  ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})(`Failed to fetch ontology ${candidate}:`, err);
                }
              }
                if (response && response.ok) {
                  const content = await response.text();
                  await get().loadOntologyFromRDF(content, undefined, true, uri);
                } else {
                  ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})(`Could not fetch ontology from ${uri}:`, lastFetchError);
                  // Do not register synthetic ontology metadata on fetch failure per policy.
                  ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } console.warn(...__vg_args);})(`Skipping synthetic ontology metadata for ${uri} due to fetch failure`, lastFetchError);
                  continue;
                }
            } catch (fetchError) {
              ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})(`Could not fetch ontology from ${uri}:`, fetchError);
              // Do not register synthetic ontology metadata on fetch error per policy.
              ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } console.warn(...__vg_args);})(`Skipping synthetic ontology metadata for ${uri} due to fetch error`, fetchError);
              continue;
            }
          }
        }
      } catch (error) {
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})(`Failed to load additional ontology ${uri}:`, error);
      }
    }

    onProgress?.(100, 'Additional ontologies loaded');
  },

  setCurrentGraph: (nodes: (ParsedNode | DiagramNode)[], edges: (ParsedEdge | DiagramEdge)[]) => {
    set({ currentGraph: { nodes, edges } });
  },

  clearOntologies: () => {
    const { rdfManager } = get();
    rdfManager.clear();
    set({
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
      validationErrors: [],
      currentGraph: { nodes: [], edges: [] }
    });
  },

  /**
   * Remove a previously loaded ontology by URL.
   * This will:
   *  - remove the ontology meta entry from loadedOntologies
   *  - remove classes/properties contributed by that ontology from available lists
   *  - remove the named graph that stores that ontology's triples from the RDF store
   *  - remove the ontology from app config additionalOntologies so it won't be auto-loaded on startup
   *
   * This is best-effort and idempotent.
   */
  removeLoadedOntology: (url: string) => {
    try {
      const appConfigStore = useAppConfigStore.getState();
      const { rdfManager, loadedOntologies } = get();

      // Immediately persist the disabled flag to prevent any concurrent auto-loads
      // from re-loading this ontology while removal proceeds. Use a normalized form.
      try {
        if (appConfigStore && typeof appConfigStore.addDisabledOntology === 'function') {
          let norm = url;
          try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
          appConfigStore.addDisabledOntology(norm);
        }
      } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

      const remainingOntologies = (loadedOntologies || []).filter(o => o.url !== url);
      const removed = (loadedOntologies || []).filter(o => o.url === url);

      // Remove classes/properties contributed by removed ontologies
      const remainingClasses = (get().availableClasses || []).filter(c => !removed.some(r => r.classes.some(rc => rc.uri === c.uri)));
      const remainingProperties = (get().availableProperties || []).filter(p => !removed.some(r => r.properties.some(rp => rp.uri === p.uri)));

      set({
        loadedOntologies: remainingOntologies,
        availableClasses: remainingClasses,
        availableProperties: remainingProperties
      });

      // Remove the named graph(s) that correspond to the removed ontologies.
      // We rely on per-source named graphs for deterministic removal. Additionally,
      // remove any declared namespace prefixes for the ontology so UI/export code
      // no longer presents those prefixes. We avoid broad namespace sweeps, but
      // when an ontology provided explicit prefixes we remove the prefix mapping
      // and any triples matching that namespace as a best-effort cleanup for
      // content that may have been added into the default graph.
      removed.forEach(o => {
        try {
          // Remove the named graph that was used to store this ontology's triples (exact)
          try { rdfManager.removeGraph(o.url); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

          // Remove declared namespace prefixes for this ontology and any triples
          // that reference them (best-effort). This handles cases where the
          // ontology's content was previously loaded into the default graph.
          Object.entries(o.namespaces || {}).forEach(([p, ns]) => {
            try { rdfManager.removeNamespaceAndQuads(ns); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
          });
        } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      });

      // Also remove from persisted app config additionalOntologies if present and mark as disabled
      // so the app won't auto-load it again if the ontology is referenced by a loaded graph.
      try {
        if (appConfigStore && typeof appConfigStore.removeAdditionalOntology === 'function') {
          // Remove both raw and normalized forms from additionalOntologies to avoid mismatches
          try { appConfigStore.removeAdditionalOntology(url); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
          let norm = url;
          try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
          try { appConfigStore.removeAdditionalOntology(norm); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

          try {
            if (typeof appConfigStore.addDisabledOntology === 'function') {
              appConfigStore.addDisabledOntology(norm);
            }
          } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
        }
      } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      } catch (err) {
      try { fallback('ontology.removeLoaded.failed', { error: String(err) }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
    }
  },

  updateNode: (entityUri: string, updates: any) => {
    logCallGraph?.('updateNode', entityUri, updates && Object.keys(updates || {}).length);
    const { rdfManager, currentGraph } = get();

    if (updates.annotationProperties && Array.isArray(updates.annotationProperties)) {
      try {
        const ns = rdfManager.getNamespaces();
        updates.annotationProperties.forEach((p: any) => {
          if (p && typeof p.propertyUri === 'string') {
            const colon = p.propertyUri.indexOf(':');
            if (colon > 0) {
              const prefix = p.propertyUri.substring(0, colon);
              if (prefix === 'dc' && !ns['dc']) {
                rdfManager.addNamespace('dc', 'http://purl.org/dc/elements/1.1/');
              }
            }
          }
        });
      } catch (e) {
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to ensure namespaces for annotationProperties:', e);
      }
    }

    rdfManager.updateNode(entityUri, updates);

    const updatedNodes = currentGraph.nodes.map(node => {
      const nodeData = getNodeData(node as ParsedNode | DiagramNode);
      const nodeUri = nodeData.iri || nodeData.uri || (node as any).uri || (node as any).id;
      if (nodeUri === entityUri) {
        const updatedData = { ...nodeData };

        // If rdfTypes were provided in the update, prefer the first meaningful (non-NamedIndividual)
        // type as the node's visible class. This ensures nodes display the real class prefix
        // instead of retaining stale values like "owl" from classType when only NamedIndividual
        // was present previously.
        if (updates.rdfTypes && Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
          try {
            const nonNamed = updates.rdfTypes.find((t: any) => t && !String(t).includes('NamedIndividual'));
            const chosen = nonNamed || updates.rdfTypes[0];
            if (chosen) {
              const chosenStr = String(chosen);
              // prefixed form: prefix:LocalName
              if (chosenStr.includes(':') && !/^https?:\/\//i.test(chosenStr)) {
                const idx = chosenStr.indexOf(':');
                updatedData.namespace = chosenStr.substring(0, idx);
                updatedData.classType = chosenStr.substring(idx + 1);
                updatedData.type = chosenStr.substring(idx + 1);
                updatedData.type_namespace = updatedData.namespace;
              } else if (/^https?:\/\//i.test(chosenStr)) {
                // full URI -> attempt to map back to a known prefix via rdfManager
                try {
                  const mgr = get().rdfManager;
                  const nsMap = (mgr && typeof mgr.getNamespaces === 'function') ? mgr.getNamespaces() : {};
                  let matched = false;
                  for (const [p, uri] of Object.entries(nsMap || {})) {
                    if (uri && chosenStr.startsWith(uri)) {
                      updatedData.namespace = p === ':' ? '' : p;
                      updatedData.classType = chosenStr.substring(uri.length);
                      updatedData.type = updatedData.classType;
                      updatedData.type_namespace = updatedData.namespace;
                      matched = true;
                      break;
                    }
                  }
                  if (!matched) {
                    // fallback to local name
                    const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                    updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                    updatedData.type = updatedData.classType;
                    // leave namespace as-is (do not overwrite with "http" or similar)
                    updatedData.type_namespace = updatedData.type_namespace || updatedData.namespace || '';
                  }
                } catch {
                  const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                  updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                  updatedData.type = updatedData.classType;
                }
              } else {
                // fallback short label
                const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                updatedData.type = updatedData.classType;
                updatedData.type_namespace = updatedData.type_namespace || updatedData.namespace || '';
              }
            }
          } catch {
            // ignore and keep existing nodeData values
          }
        }

        if (updates.type) {
          const [namespace, classType] = (updates.type as string).split(':');
          updatedData.namespace = namespace;
          updatedData.classType = classType;
          updatedData.type = classType || updatedData.type;
          updatedData.type_namespace = namespace || updatedData.type_namespace;
        }

        if (updates.annotationProperties) {
          const legacy = updates.annotationProperties.map((prop: any) => ({
            propertyUri: prop.propertyUri,
            value: prop.value,
            type: prop.type || 'xsd:string'
          }));
          updatedData.annotationProperties = legacy;

          updatedData.annotations = legacy.map((p: any) => {
            const key = p.propertyUri || p.property || p.key || 'unknown';
            return { [key]: p.value };
          });

          updatedData.literalProperties = legacy.map((p: any) => ({
            key: p.propertyUri,
            value: p.value,
            type: p.type || 'xsd:string'
          }));
        }

        updatedData.iri = updatedData.iri || updatedData.uri || entityUri;

        const newNode = {
          ...node,
          iri: updatedData.iri,
          type: updatedData.type || updatedData.classType || '',
          type_namespace: updatedData.type_namespace || updatedData.namespace || '',
          annotations: updatedData.annotations || updatedData.annotationProperties || [],
          uri: updatedData.uri || updatedData.iri || entityUri,
          classType: updatedData.classType,
          rdfTypes: updatedData.rdfTypes,
          annotationProperties: updatedData.annotationProperties,
          literalProperties: updatedData.literalProperties,
          namespace: updatedData.namespace,
          // Preserve the original node id if present; fall back to updatedData.id or nodeUri.
          id: (node as any).id || updatedData.id || nodeUri,
          position: updatedData.position,
          data: {
            ...((node as any).data || {}),
            ...updatedData,
            // Ensure data.id is preserved so downstream code can still find nodes by id
            id: (node as any).id || updatedData.id || nodeUri,
            iri: updatedData.iri,
            type: updatedData.type || updatedData.classType || '',
            type_namespace: updatedData.type_namespace || updatedData.namespace || '',
            annotations: updatedData.annotations || updatedData.annotationProperties || []
          }
        };

        return newNode;
      }
      return node;
    });

    set({ currentGraph: { ...currentGraph, nodes: updatedNodes } });
  },

  exportGraph: async (format: 'turtle' | 'json-ld' | 'rdf-xml') => {
    const { rdfManager } = get();
    switch (format) {
      case 'turtle':
        return await rdfManager.exportToTurtle();
      case 'json-ld':
        return await rdfManager.exportToJsonLD();
      case 'rdf-xml':
        return await rdfManager.exportToRdfXml();
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  },

  getRdfManager: () => {
    const { rdfManager } = get();
    return rdfManager;
  }
}));

/**
 * Extract ontology URIs referenced in RDF content that should be loaded
 */
function extractReferencedOntologies(rdfContent: string): string[] {
  const ontologyUris = new Set<string>();

  const namespacePatterns = [
    /@prefix\s+\w+:\s*<([^>]+)>/g,
    /xmlns:\w+="([^"]+)"/g,
    /"@context"[^}]*"([^"]+)"/g
  ];

    const wellKnownOntologies = Object.keys(WELL_KNOWN.ontologies);

  namespacePatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(rdfContent)) !== null) {
      const uri = match[1];
      if (wellKnownOntologies.includes(uri)) {
        ontologyUris.add(uri);
      }
    }
  });

  const prefixUsage = [
    /\bfoaf:/g,
    /\bowl:/g,
    /\brdfs:/g,
    /\biof:/g,
    /\borg:/g,
    /\bskos:/g
  ];

  prefixUsage.forEach((pattern, index) => {
    if (pattern.test(rdfContent)) {
      ontologyUris.add(wellKnownOntologies[index]);
    }
  });

  return Array.from(ontologyUris);
}

// Helper functions for mock data
function getOntologyName(url: string): string {
  const names: Record<string, string> = {
    'http://xmlns.com/foaf/0.1/': 'FOAF',
    'https://www.w3.org/TR/vocab-org/': 'Organization',
    'http://purl.org/dc/elements/1.1/': 'Dublin Core',
    'http://www.w3.org/2004/02/skos/core#': 'SKOS'
  };
  return names[url] || 'Custom Ontology';
}

/**
 * Ensure the supplied namespaces are present in the RDF manager. Idempotent.
 */
function ensureNamespacesPresent(rdfMgr: any, nsMap?: Record<string, string>) {
  if (!nsMap || typeof nsMap !== 'object') return;
  try {
    const existing = rdfMgr && typeof rdfMgr.getNamespaces === 'function' ? rdfMgr.getNamespaces() : {};
    Object.entries(nsMap).forEach(([p, ns]) => {
      try {
        // If neither the prefix nor the namespace URI exists, add it.
        if (!existing[p] && !Object.values(existing).includes(ns)) {
          try { rdfMgr.addNamespace(p, ns); } catch (e) { try { if (typeof fallback === "function") { fallback("rdf.addNamespace.failed", { prefix: p, namespace: ns, error: String(e) }, { level: 'warn' }); } } catch (_) { /* ignore */ } }
        }
      } catch (_) { /* ignore individual entries */ }
    });
  } catch (e) {
    try { if (typeof fallback === "function") { fallback("rdf.ensureNamespaces.failed", { error: String(e) }); } } catch (_) { /* ignore */ }
  }
}
