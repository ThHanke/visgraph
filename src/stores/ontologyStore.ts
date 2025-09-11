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
    if (typeof process !== 'undefined' && process.env && process.env.VG_CALL_GRAPH_LOGGING === 'true') return true;
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

  try {
    const cfg = useAppConfigStore.getState();
    if (cfg && (cfg as any).callGraphLogging) return true;
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

  return false;
}

function logCallGraph(...args: any[]) {
  if (shouldLogCallGraph()) {
    ((...__vg_args)=>{try{debug('console.debug',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.debug(...__vg_args);})('[vg-call-graph]', ...args);
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
        try {
          const nsMap = wkEntry && wkEntry.namespaces ? wkEntry.namespaces : {};
          ensureNamespacesPresent(rdfManager, nsMap);
        } catch (e) {
          try { fallback('rdf.addNamespace.failed', { error: String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }

        const loadedOntology: LoadedOntology = {
          url,
          name: wkEntry.name || deriveOntologyName(url),
          classes: [],
          properties: [],
          namespaces: rdfManager.getNamespaces()
        };

        set((state) => ({
          loadedOntologies: [...state.loadedOntologies, loadedOntology],
          availableClasses: [...state.availableClasses],
          availableProperties: [...state.availableProperties]
        }));

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
        const { content } = await rdfManager.loadFromUrl(url, { timeoutMs: 15000, onProgress: (p: number, m: string) => {/* no-op or forward */} });
        const { parseRDFFile } = await import('../utils/rdfParser');
        const parsed = await parseRDFFile(content);

        try {
          const parsedNamespaces = parsed.namespaces || {};
          const canonicalByNs: Record<string, string> = {};

          Object.entries(WELL_KNOWN.ontologies || {}).forEach(([ontUrl, meta]: any) => {
            if (meta && meta.namespaces) {
              Object.values(meta.namespaces).forEach((nsUri: any) => {
                try { canonicalByNs[String(nsUri)] = ontUrl; } catch (_) { /* ignore */ }
              });
            }
          });

          Object.values(WELL_KNOWN.prefixes || {}).forEach((nsUri: any) => {
            try {
              if (WELL_KNOWN.ontologies[String(nsUri)]) canonicalByNs[String(nsUri)] = String(nsUri);
            } catch (_) { /* ignore */ }
          });

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
          const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
            ? (node as any).rdfTypes.slice()
            : ((node as any).rdfType ? [(node as any).rdfType] : []);
          const meaningful = allTypes.filter((t: string) => t && !String(t).includes('NamedIndividual'));
          if (meaningful.length > 0) {
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
          name: deriveOntologyName(url),
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
          try { fallback('rdf.namespaces.add.failed', { error: String(nsErr) }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }

        set((state) => ({
          loadedOntologies: [...state.loadedOntologies, loadedOntology],
          availableClasses: [...state.availableClasses, ...ontologyClasses],
          availableProperties: [...state.availableProperties, ...ontologyProperties]
        }));

        try {
          const appCfg = useAppConfigStore.getState();
          if (appCfg && typeof appCfg.addRecentOntology === 'function') {
            let norm = url;
            try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
            appCfg.addRecentOntology(norm);
          }
        } catch (_) { /* ignore */ }

        // Merge parsed graph into currentGraph (preserveGraph behavior)
        try {
          const nodes = (parsed.nodes || []).map((n: any) => {
            const nodeId = n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random());
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
                    const parts = chosenStr.split(/[#/]/).filter(Boolean);
                    computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                  }
                } else {
                  const parts = chosenStr.split(/[#/]/).filter(Boolean);
                  computedClassType = parts.length ? parts[parts.length - 1] : chosenStr;
                }
              }
            } catch {
              // ignore
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

          // Merge into existing graph preserving previous nodes/edges
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
        } catch (mergeErr) {
          try { fallback('graph.merge.failed', { error: String(mergeErr) }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }

        return;
      } catch (fetchOrParseError) {
        warn('ontology.fetch.parse.failed', { url, error: (fetchOrParseError && (fetchOrParseError as any).message) ? (fetchOrParseError as any).message : String(fetchOrParseError) }, { caller: true });
        return;
      }
    } catch (error: any) {
      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { /* ignore */ } console.error('Failed to load ontology:', error);})()
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
    logCallGraph?.('loadOntologyFromRDF:start', { length: (rdfContent || '').length });
    try {
      const { parseRDFFile } = await import('../utils/rdfParser');
      const { rdfManager } = get();

      onProgress?.(10, 'Starting RDF parsing...');

      try {
        await rdfManager.loadRDFIntoGraph(rdfContent, graphName);
      } catch (loadErr) {
        warn('rdfManager.loadIntoGraph.failed', { error: (loadErr && (loadErr as any).message) ? (loadErr as any).message : String(loadErr) }, { caller: true });
      }

      const parsed = await parseRDFFile(rdfContent, onProgress);

      try {
        const { rdfManager } = get();
        rdfManager.applyParsedNamespaces(parsed.namespaces || {});
        rdfManager.applyParsedNodes(parsed.nodes || [], { preserveExistingLiterals: true });

        try {
          const store = rdfManager.getStore();
          (parsed.edges || []).forEach((e: any) => {
            try {
              const s = (parsed.nodes || []).find((n: any) => n.id === e.source);
              const t = (parsed.nodes || []).find((n: any) => n.id === e.target);
              if (!s || !t || !s.uri || !t.uri) return;
              const subj = s.uri;
              const obj = t.uri;
              const pred = e.propertyUri || e.propertyType;
              const existing = store.getQuads(namedNode(subj), namedNode(pred), namedNode(obj), null);
              if (!existing || existing.length === 0) {
                try {
                  store.addQuad(quad(namedNode(subj), namedNode(pred), namedNode(obj)));
                } catch (addErr) {
                  /* ignore */
                }
              }
            } catch (_) { /* ignore */ }
          });
        } catch (_) { /* ignore */ }

        (parsed.nodes || []).forEach((node: any) => {
          try {
            const allTypes = (node as any).rdfTypes && (node as any).rdfTypes.length > 0
              ? (node as any).rdfTypes.slice()
              : ((node as any).rdfType ? [(node as any).rdfType] : []);
            if (allTypes && allTypes.length > 0) {
              try { (get().updateNode as any)(node.uri, { rdfTypes: allTypes }); } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }
        });
      } catch (reapplyErr) {
        /* ignore */
      }

      try {
        const nodesForDiagram = (parsed.nodes || []).map((n: any) => {
          const nodeId = n.id || n.uri || n.iri || `${n.namespace}:${n.classType}` || String(Math.random());
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
            // ignore
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
      } catch (_) { /* ignore */ }

    } catch (error: any) {
      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { /* ignore */ } console.error('Failed to load ontology from RDF:', error);})()
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => { controller.abort(); }, timeout);

        try {
          const candidateUrls = source.startsWith('http://') ? [source.replace(/^http:\/\//, 'https://'), source] : [source];
          let response: Response | null = null;
          let lastFetchError: any = null;
          for (const candidate of candidateUrls) {
            try {
              response = await fetch(candidate, {
                signal: controller.signal,
                headers: { 'Accept': 'text/turtle, application/rdf+xml, application/ld+json, */*' }
              });
              break;
            } catch (err) {
              lastFetchError = err;
              try { fallback('console.warn', { args: [`Fetch failed for ${candidate}:`, String(err)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
            }
          }

          if (!response || !response.ok) {
            const fetchErr = lastFetchError || new Error(`Failed to fetch RDF from ${source}`);
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
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        rdfContent = source;
      }

      await get().loadOntologyFromRDF(rdfContent, options?.onProgress, true, source);

      options?.onProgress?.(90, 'Checking for additional ontologies...');
      const extractedOntologies = extractReferencedOntologies(rdfContent);

      if (extractedOntologies.length > 0) {
        try {
          const appCfg = useAppConfigStore.getState();
          const configured = (appCfg && appCfg.config && Array.isArray(appCfg.config.additionalOntologies))
            ? appCfg.config.additionalOntologies
            : [];

          function normalizeUri(u: string): string {
            try { return new URL(String(u)).toString(); } catch { return typeof u === 'string' ? u.replace(/\/+$/, '') : u; }
          }

          const configuredNorm = new Set(configured.map((u: string) => normalizeUri(u)));
          const toLoad = extractedOntologies.filter((u: string) => configuredNorm.has(normalizeUri(u)));

          if (toLoad.length > 0) {
            await get().loadAdditionalOntologies(toLoad, options?.onProgress);
          } else {
            options?.onProgress?.(100, 'No configured additional ontologies referenced; skipping auto-load');
          }
        } catch (e) {
          try { fallback('console.warn', { args: ['Failed while computing configured additional ontologies to auto-load:', String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }
      }
    } catch (error: any) {
      try { fallback('console.error', { args: ['Failed to load knowledge graph:', String(error)] }, { level: 'error' }); } catch (_) { /* ignore */ }
      throw error;
    }
  },

  loadAdditionalOntologies: async (ontologyUris: string[], onProgress?: (progress: number, message: string) => void) => {
    logCallGraph?.('loadAdditionalOntologies:start', ontologyUris && ontologyUris.length);
    const { loadedOntologies } = get();
    const alreadyLoaded = new Set(loadedOntologies.map(o => o.url));

    function normalizeUri(u: string): string {
      try { return new URL(String(u)).toString(); } catch { return typeof u === 'string' ? u.replace(/\/+$/, '') : u; }
    }

    const appCfg = useAppConfigStore.getState();
    const disabled = (appCfg && appCfg.config && Array.isArray(appCfg.config.disabledAdditionalOntologies)) ? appCfg.config.disabledAdditionalOntologies : [];
    const disabledNorm = new Set(disabled.map(d => normalizeUri(d)));
    const alreadyLoadedNorm = new Set(Array.from(alreadyLoaded).map(u => normalizeUri(String(u))));

    const toLoad = ontologyUris.filter(uri => {
      const norm = normalizeUri(uri);
      return !alreadyLoadedNorm.has(norm) && !disabledNorm.has(norm);
    });

    if (toLoad.length === 0) {
      onProgress?.(100, 'No new ontologies to load');
      return;
    }

    onProgress?.(95, `Loading ${toLoad.length} additional ontologies...`);

    for (let i = 0; i < toLoad.length; i++) {
      const uri = toLoad[i];
      const wkEntry = WELL_KNOWN.ontologies[uri as keyof typeof WELL_KNOWN.ontologies];
      const ontologyName = wkEntry ? wkEntry.name : undefined;

      try {
        onProgress?.(95 + Math.floor((i / toLoad.length) * 5), `Loading ${ontologyName || uri}...`);

        if (wkEntry) {
          try {
            ensureNamespacesPresent(get().rdfManager, wkEntry.namespaces || {});
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
          continue;
        }

        if (uri.startsWith('http://') || uri.startsWith('https://')) {
          const candidateUrls = uri.startsWith('http://') ? [uri.replace(/^http:\/\//, 'https://'), uri] : [uri];
          let fetched = false;
          let lastFetchError: any = null;

          for (const candidate of candidateUrls) {
            try {
              const response = await fetch(candidate, {
                headers: { 'Accept': 'text/turtle, application/rdf+xml, application/ld+json, */*' },
                signal: AbortSignal.timeout(10000)
              });

              if (response && response.ok) {
                const content = await response.text();
                await get().loadOntologyFromRDF(content, undefined, true, uri);
                fetched = true;
                break;
              } else {
                lastFetchError = lastFetchError || new Error(`HTTP ${response ? response.status : 'NO_RESPONSE'}`);
              }
            } catch (err) {
              lastFetchError = err;
              try { fallback('console.warn', { args: [`Failed to fetch ontology ${candidate}:`, String(err)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
            }
          }

          if (!fetched) {
            try { fallback('console.warn', { args: [`Could not fetch ontology from ${uri}:`, String(lastFetchError)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
            // Per policy: do not register synthetic ontology metadata on fetch failure.
            continue;
          }
        } else {
          // If it's not an http(s) URI, we treat it as inline RDF content and attempt to parse it.
          try {
            await get().loadOntologyFromRDF(uri, undefined, true, uri);
          } catch (e) {
            try { fallback('console.warn', { args: [`Failed to parse non-http ontology content for ${uri}:`, String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
            continue;
          }
        }
      } catch (error: any) {
        try { fallback('console.warn', { args: [`Failed to load additional ontology ${uri}:`, String(error)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
        continue;
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

  removeLoadedOntology: (url: string) => {
    try {
      const appConfigStore = useAppConfigStore.getState();
      const { rdfManager, loadedOntologies } = get();
      try {
        if (appConfigStore && typeof appConfigStore.addDisabledOntology === 'function') {
          let norm = url;
          try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
          appConfigStore.addDisabledOntology(norm);
        }
      } catch (_) { /* ignore */ }

      const remainingOntologies = (loadedOntologies || []).filter(o => o.url !== url);
      const removed = (loadedOntologies || []).filter(o => o.url === url);

      const remainingClasses = (get().availableClasses || []).filter(c => !removed.some(r => r.classes.some(rc => rc.uri === c.uri)));
      const remainingProperties = (get().availableProperties || []).filter(p => !removed.some(r => r.properties.some(rp => rp.uri === p.uri)));

      set({
        loadedOntologies: remainingOntologies,
        availableClasses: remainingClasses,
        availableProperties: remainingProperties
      });

      removed.forEach(o => {
        try { rdfManager.removeGraph(o.url); } catch (_) { /* ignore */ }
        Object.entries(o.namespaces || {}).forEach(([p, ns]) => {
          try { rdfManager.removeNamespaceAndQuads(ns); } catch (_) { /* ignore */ }
        });
      });

      try {
        if (appConfigStore && typeof appConfigStore.removeAdditionalOntology === 'function') {
          try { appConfigStore.removeAdditionalOntology(url); } catch (_) { /* ignore */ }
          let norm = url;
          try { norm = new URL(String(url)).toString(); } catch { norm = String(url).replace(/\/+$/, ''); }
          try { appConfigStore.removeAdditionalOntology(norm); } catch (_) { /* ignore */ }
          try { if (typeof appConfigStore.addDisabledOntology === 'function') appConfigStore.addDisabledOntology(norm); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    } catch (err) {
      try { fallback('ontology.removeLoaded.failed', { error: String(err) }, { level: 'warn' }); } catch (_) { /* ignore */ }
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
        try { fallback('console.warn', { args: ['Failed to ensure namespaces for annotationProperties:', String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
      }
    }

    rdfManager.updateNode(entityUri, updates);

    const updatedNodes = currentGraph.nodes.map(node => {
      const nodeData = getNodeData(node as ParsedNode | DiagramNode);
      const nodeUri = nodeData.iri || nodeData.uri || (node as any).uri || (node as any).id;
      if (nodeUri === entityUri) {
        const updatedData = { ...nodeData };

        if (updates.rdfTypes && Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
          try {
            const nonNamed = updates.rdfTypes.find((t: any) => t && !String(t).includes('NamedIndividual'));
            const chosen = nonNamed || updates.rdfTypes[0];
            if (chosen) {
              const chosenStr = String(chosen);
              if (chosenStr.includes(':') && !/^https?:\/\//i.test(chosenStr)) {
                const idx = chosenStr.indexOf(':');
                updatedData.namespace = chosenStr.substring(0, idx);
                updatedData.classType = chosenStr.substring(idx + 1);
                updatedData.type = chosenStr.substring(idx + 1);
                updatedData.type_namespace = updatedData.namespace;
              } else if (/^https?:\/\//i.test(chosenStr)) {
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
                    const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                    updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                    updatedData.type = updatedData.classType;
                    updatedData.type_namespace = updatedData.type_namespace || updatedData.namespace || '';
                  }
                } catch {
                  const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                  updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                  updatedData.type = updatedData.classType;
                }
              } else {
                const parts = chosenStr.split(/[#\/]/).filter(Boolean);
                updatedData.classType = parts.length ? parts[parts.length - 1] : chosenStr;
                updatedData.type = updatedData.classType;
                updatedData.type_namespace = updatedData.type_namespace || updatedData.namespace || '';
              }
            }
          } catch {
            /* ignore */
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
          id: (node as any).id || updatedData.id || nodeUri,
          position: updatedData.position,
          data: {
            ...((node as any).data || {}),
            ...updatedData,
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

  try {
    const prefixToOntUrls = new Map<string, string[]>();
    const wkPrefixes = WELL_KNOWN.prefixes || {};
    const wkOnt = WELL_KNOWN.ontologies || {};

    Object.entries(wkPrefixes).forEach(([prefix, nsUri]) => {
      const urls: string[] = [];
      try {
        if ((wkOnt as any)[nsUri]) urls.push(nsUri);
      } catch (_) { /* ignore */ }

      Object.entries(wkOnt).forEach(([ontUrl, meta]) => {
        try {
          const m = meta as any;
          if (m && m.namespaces && m.namespaces[prefix] === nsUri) {
            if (!urls.includes(ontUrl)) urls.push(ontUrl);
          }
          if (m && m.aliases && Array.isArray(m.aliases) && m.aliases.includes(nsUri)) {
            if (!urls.includes(ontUrl)) urls.push(ontUrl);
          }
        } catch (_) { /* ignore per-entry errors */ }
      });

      if (urls.length > 0) prefixToOntUrls.set(prefix, urls);
    });

    for (const [prefix, urls] of prefixToOntUrls.entries()) {
      const safe = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp(`\\b${safe}:`, 'g');
      if (re.test(rdfContent)) {
        urls.forEach(u => ontologyUris.add(u));
      }
    }
  } catch (_) { /* best-effort only */ }

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
        if (m && m.aliases && Array.isArray(m.aliases) && m.aliases.includes(url)) {
          return m.name || String(ontUrl);
        }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  try {
    let label = '';
    try {
      const u = new URL(String(url));
      const fragment = u.hash ? u.hash.replace(/^#/, '') : '';
      const pathSeg = (u.pathname || '').split('/').filter(Boolean).pop() || '';
      label = fragment || pathSeg || u.hostname || String(url);
    } catch (_) {
      const parts = String(url).split(/[#/]/).filter(Boolean);
      label = parts.length ? parts[parts.length - 1] : String(url);
    }

    label = label.replace(/\.(owl|rdf|ttl|jsonld|json)$/i, '');
    label = label.replace(/[-_.]+v?\d+(\.\d+)*$/i, '').replace(/\d{4}-\d{2}-\d{2}$/i, '');
    label = decodeURIComponent(label);
    label = label.replace(/[_\-\+\.]/g, ' ');
    label = label.replace(/([a-z])([A-Z])/g, '$1 $2');
    label = label.replace(/\s+/g, ' ').trim();
    if (!label) return 'Custom Ontology';
    label = label.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return label || 'Custom Ontology';
  } catch (_) {
    return 'Custom Ontology';
  }
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
        if (!existing[p] && !Object.values(existing).includes(ns)) {
          try { rdfMgr.addNamespace(p, ns); } catch (e) { try { if (typeof fallback === "function") { fallback("rdf.addNamespace.failed", { prefix: p, namespace: ns, error: String(e) }, { level: 'warn' }); } } catch (_) { /* ignore */ } }
        }
      } catch (_) { /* ignore individual entries */ }
    });
  } catch (e) {
    try { if (typeof fallback === "function") { fallback("rdf.ensureNamespaces.failed", { error: String(e) }); } } catch (_) { /* ignore */ }
  }
}
