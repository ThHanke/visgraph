/* eslint-disable @typescript-eslint/no-unused-expressions, no-useless-catch, react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  applyNodeChanges,
  applyEdgeChanges,
  MiniMap,
} from "@xyflow/react";
// import '../../tailwind-config.js';
import { useOntologyStore } from "../../stores/ontologyStore";
import { DataFactory } from "n3";
import { useReasoningStore } from "../../stores/reasoningStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAppConfigStore } from "../../stores/appConfigStore";
import { CanvasToolbar } from "./CanvasToolbar";
import { ResizableNamespaceLegend } from "./ResizableNamespaceLegend";
import { ReasoningIndicator } from "./ReasoningIndicator";
import { ReasoningReportModal } from "./ReasoningReportModal";
import { Progress } from "../ui/progress";
import type { ReactFlowInstance } from "@xyflow/react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../types/canvas";
import mapQuadsToDiagram from "./core/mappingHelpers";
import { CustomOntologyNode as OntologyNode } from "./CustomOntologyNode";
import FloatingEdge from "./FloatingEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";
import createEdge from "./core/createEdge";
import { generateEdgeId } from "./core/edgeHelpers";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { useCanvasState } from "../../hooks/useCanvasState";
import { toast } from "sonner";
import { LayoutManager } from "./LayoutManager";
import { NodePropertyEditor } from "./NodePropertyEditor";
import * as LinkPropertyEditorModule from "./LinkPropertyEditor";
const LinkPropertyEditor: any = (() => {
  try {
    const mod = LinkPropertyEditorModule as any;
    if (mod && typeof mod === "object") {
      if ((mod as any).LinkPropertyEditor) return (mod as any).LinkPropertyEditor;
      if ((mod as any).default) return (mod as any).default;
    }
  } catch (_) { /* swallow mock inspection errors */ }
  return () => null;
})();
/**
 * KnowledgeCanvas (pure quad integration)
 *
 * This version of KnowledgeCanvas consumes quad batches emitted by the RDF manager
 * and translates them directly into React Flow node and edge state. It performs
 * no lookups against the RDF store and does not call computeTermDisplay/expandPrefix.
 *
 * Behaviour:
 * - Subscribes to rdfManager.onSubjectsChange expecting a quads payload as the
 *   second argument: onSubjectsChange((subjects, quads) => { ... })
 * - Accumulates incoming quads and runs a debounced mapping pass that:
 *   - Translates quads -> NodeData / LinkData directly (no deduping; triples are used as-is)
 *   - Merges existing node positions and runtime __rf flags into newly produced nodes
 *
 * Note: per instructions this implementation is intentionally minimal and does not
 * attempt backwards compatibility or fallbacks. It expects the RDF manager to
 * provide quads in the subject-level emission.
 */

const { namedNode } = DataFactory;

// Provide a race-safe stub for external test runners that may call window.__VG_APPLY_LAYOUT
// before the React component mounts. The stub queues requests and returns a Promise that
// will be resolved once the component mounts and processes the queued requests.
try {
  (window as any).__VG_APPLY_LAYOUT = (layoutKey?: string) => {
    try {
      if (!((window as any).__VG_APPLY_LAYOUT_PENDING)) (window as any).__VG_APPLY_LAYOUT_PENDING = [];
      return new Promise((resolve) => {
        try {
          (window as any).__VG_APPLY_LAYOUT_PENDING.push({ layoutKey, resolve });
        } catch (e) {
          try { resolve(false); } catch (_) { /* ignore */ }
        }
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  };
} catch (_) { /* ignore global attach failures */ }

const KnowledgeCanvas: React.FC = () => {
  // Resolve NodePropertyEditor at runtime using require so test-level vi.mock
  // values that export either a named export or a default export are supported.
  const [nodes, setNodes] = useNodesState<RFNode<NodeData>>([]);
  const [edges, setEdges] = useEdgesState<RFEdge<LinkData>>([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const { state: canvasState, actions: canvasActions } = useCanvasState();
  // Attempt to use selective selectors for better performance, but fall back to the full store
  // shape when tests/mock implementations return the raw store object (common in unit tests).
  const _os_raw = (useOntologyStore as any) && typeof (useOntologyStore as any) === "function" ? (useOntologyStore as any)() : {};
  const _sel_loadedOntologies = useOntologyStore((s: any) => s.loadedOntologies);
  const loadedOntologies = ((): any[] => {
    try {
      if (Array.isArray(_sel_loadedOntologies)) return _sel_loadedOntologies;
      if (_sel_loadedOntologies && typeof _sel_loadedOntologies === "object" && Object.prototype.hasOwnProperty.call(_sel_loadedOntologies, "loadedOntologies")) return _sel_loadedOntologies.loadedOntologies;
    } catch (_) { /* ignore */ }
    try { return _os_raw && Array.isArray(_os_raw.loadedOntologies) ? _os_raw.loadedOntologies : []; } catch (_) { return []; }
  })();

  const _sel_availableClasses = useOntologyStore((s: any) => s.availableClasses);
  const availableClasses = ((): any[] => {
    try {
      if (Array.isArray(_sel_availableClasses)) return _sel_availableClasses;
      if (_sel_availableClasses && typeof _sel_availableClasses === "object" && Object.prototype.hasOwnProperty.call(_sel_availableClasses, "availableClasses")) return _sel_availableClasses.availableClasses;
    } catch (_) { /* ignore */ }
    try { return _os_raw && Array.isArray(_os_raw.availableClasses) ? _os_raw.availableClasses : []; } catch (_) { return []; }
  })();
  const ac = availableClasses;

  const _sel_loadKnowledgeGraph = useOntologyStore((s: any) => s.loadKnowledgeGraph);
  const loadKnowledgeGraph = typeof _sel_loadKnowledgeGraph === "function" ? _sel_loadKnowledgeGraph : (_os_raw && typeof _os_raw.loadKnowledgeGraph === "function" ? _os_raw.loadKnowledgeGraph : undefined);

  const _sel_exportGraph = useOntologyStore((s: any) => s.exportGraph);
  const exportGraph = typeof _sel_exportGraph === "function" ? _sel_exportGraph : (_os_raw && typeof _os_raw.exportGraph === "function" ? _os_raw.exportGraph : undefined);

  const _sel_loadAdditionalOntologies = useOntologyStore((s: any) => s.loadAdditionalOntologies);
  const loadAdditionalOntologies = typeof _sel_loadAdditionalOntologies === "function" ? _sel_loadAdditionalOntologies : (_os_raw && typeof _os_raw.loadAdditionalOntologies === "function" ? _os_raw.loadAdditionalOntologies : undefined);

  const _sel_getRdfManager = useOntologyStore((s: any) => s.getRdfManager);
  const getRdfManager = typeof _sel_getRdfManager === "function" ? _sel_getRdfManager : ((_os_raw && typeof _os_raw.getRdfManager === "function") ? _os_raw.getRdfManager : undefined);

  const _sel_availableProperties = useOntologyStore((s: any) => s.availableProperties);
  const availableProperties = ((): any[] => {
    try {
      if (Array.isArray(_sel_availableProperties)) return _sel_availableProperties;
      if (_sel_availableProperties && typeof _sel_availableProperties === "object" && Object.prototype.hasOwnProperty.call(_sel_availableProperties, "availableProperties")) return _sel_availableProperties.availableProperties;
    } catch (_) { /* ignore */ }
    try { return _os_raw && Array.isArray(_os_raw.availableProperties) ? _os_raw.availableProperties : []; } catch (_) { return []; }
  })();

  const _sel_ontologiesVersion = useOntologyStore((s: any) => s.ontologiesVersion);
  const ontologiesVersion = (_sel_ontologiesVersion !== undefined) ? _sel_ontologiesVersion : (_os_raw && _os_raw.ontologiesVersion !== undefined ? _os_raw.ontologiesVersion : undefined);

  // Safe getter for the RDF manager: prefer the selector-provided function but fall back to the store's getState accessor.
  // Some test mocks replace the store-level getter, so this helper ensures we find the manager reliably.
  const getRdfManagerSafe = useCallback(() => {
    try {
      const maybe = typeof getRdfManager === "function" ? getRdfManager() : undefined;
      if (maybe) return maybe;
      const gs = (useOntologyStore as any).getState && (useOntologyStore as any).getState().getRdfManager;
      return typeof gs === "function" ? gs() : undefined;
    } catch (_) {
      return undefined;
    }
  }, [getRdfManager]);

  const startReasoning = useReasoningStore((s) => s.startReasoning);
  const settings = useSettingsStore((s) => s.settings);
  const config = useAppConfigStore((s) => s.config);
  const setCurrentLayout = useAppConfigStore((s) => s.setCurrentLayout);
  const setShowLegend = useAppConfigStore((s) => s.setShowLegend);
  const setPersistedViewMode = useAppConfigStore((s) => s.setViewMode);

  const [viewMode, setViewMode] = useState(config.viewMode);
  const [showLegend, setShowLegendState] = useState(config.showLegend);
  const [currentLayout, setCurrentLayoutState] = useState(config.currentLayout);
  // Layout toggle initialized from persisted config
  const [layoutEnabled, setLayoutEnabled] = useState(() => !!(config && config.autoApplyLayout));

  // Palette from RDF manager — used to compute colors without rebuilding palettes.
  const palette = usePaletteFromRdfManager();

  // Local editor state driven by React Flow events (node/edge payloads come from RF state).
  const [nodeEditorOpen, setNodeEditorOpen] = useState<boolean>(false);
  const [linkEditorOpen, setLinkEditorOpen] = useState<boolean>(false);
  const [selectedNodePayload, setSelectedNodePayload] = useState<any | null>(null);
  const [selectedLinkPayload, setSelectedLinkPayload] = useState<any | null>(null);


  // Expose namedNode factory for synchronous store queries in the local classifier.
  const termForIri = (iri: string) => {
    if (typeof iri === "string" && iri.startsWith("_:")) {
      return DataFactory.blankNode(iri.slice(2));
    }
    return namedNode(String(iri));
  };

  const predicateClassifier = (predIri: string) => {
    // Quick fat-map hint
    if (Array.isArray(availableProperties)) {
      const found = (availableProperties as any[]).find((p) => String(p.iri) === String(predIri));
      if (found) {
        if (Array.isArray(found.range) && found.range.length > 0) return "object";
        if (Array.isArray(found.domain) && found.domain.length > 0) return "object";
      }
    }

    // Precise check against RDF store rdf:type triples (authoritative)
    const mgr = getRdfManagerSafe ? getRdfManagerSafe() : (typeof getRdfManager === "function" ? getRdfManager() : undefined);
    if (!mgr || typeof mgr.getStore !== "function") return "unknown";
    const store = mgr.getStore();
    const rdfTypeIri = typeof (mgr as any).expandPrefix === "function" ? (mgr as any).expandPrefix("rdf:type") : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const quads = store.getQuads(namedNode(predIri), namedNode(rdfTypeIri), null, null) || [];
    for (const q of quads) {
      const t = q && (q.object as any) && (q.object as any).value ? String((q.object as any).value) : "";
      if (!t) continue;
      if (t === "http://www.w3.org/2002/07/owl#AnnotationProperty") return "annotation";
      if (t === "http://www.w3.org/2002/07/owl#ObjectProperty") return "object";
      if (t === "http://www.w3.org/2002/07/owl#DatatypeProperty") return "datatype";
    }
    return "unknown";
  };

  const handleToggleLayoutEnabled = useCallback((enabled: boolean) => {
    setLayoutEnabled(Boolean(enabled));
    useAppConfigStore.getState().setAutoApplyLayout(Boolean(enabled));
  }, []);

  const _blacklistedPrefixes = new Set(['owl', 'rdf', 'rdfs', 'xml', 'xsd']);
  const _blacklistedUris = [
    'http://www.w3.org/2002/07/owl',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'http://www.w3.org/2000/01/rdf-schema#',
    'http://www.w3.org/XML/1998/namespace',
    'http://www.w3.org/2001/XMLSchema#'
  ];

  function isBlacklistedIri(val?: string | null): boolean {
    if (!val) return false;
    const s = String(val).trim();
    if (!s) return false;
    if (s.includes(':') && !/^https?:\/\//i.test(s)) {
      const prefix = s.split(':', 1)[0];
      if (_blacklistedPrefixes.has(prefix)) return true;
    }
    for (const u of _blacklistedUris) {
      if (s.startsWith(u)) return true;
    }
    return false;
  }

  useEffect(() => {
    setViewMode(config.viewMode);
    setShowLegendState(config.showLegend);
    setCurrentLayoutState(config.currentLayout);
    setLayoutEnabled(Boolean(config.autoApplyLayout));
  }, [config.viewMode, config.showLegend, config.currentLayout, config.autoApplyLayout]);

  const allEntities = useMemo(() => {
    const list = Array.isArray(loadedOntologies) ? loadedOntologies : [];
    return list.flatMap((ontology) => [
      ...((Array.isArray(ontology?.classes) ? ontology.classes : []).map((cls: any) => ({
        iri: cls.iri,
        label: cls.label,
        namespace: cls.namespace,
        rdfType: "owl:Class" as const,
        description: `Class from ${ontology.name}`,
      }))),
      ...((Array.isArray(ontology?.properties) ? ontology.properties : []).map((prop: any) => ({
        iri: prop.iri,
        label: prop.label,
        namespace: prop.namespace,
        rdfType: String(prop.iri || "").includes("ObjectProperty")
          ? "owl:ObjectProperty"
          : ("owl:AnnotationProperty" as const),
        description: `Property from ${ontology.name}`,
      }))),
    ]);
  }, [ontologiesVersion, loadedOntologies]);

  const availablePropertiesSnapshot = useMemo(() => {
    return Array.isArray(availableProperties) ? (availableProperties as any[]).slice() : [];
  }, [availableProperties, ontologiesVersion]);

  // Predicate-kind lookup snapshot (derived from availablePropertiesSnapshot).
  // The pure mapper can use this lookup synchronously and deterministically.
  const predicateKindLookup = useMemo(() => {
    const m = new Map<string, "annotation" | "object" | "datatype" | "unknown">();
    try {
      const arr = Array.isArray(availablePropertiesSnapshot) ? availablePropertiesSnapshot : [];
      for (const p of arr) {
        try {
          const iri = p && (p.iri || p.key) ? String(p.iri || p.key) : "";
          if (!iri) continue;
          const kindRaw = (p && (p.propertyKind || p.kind || p.type)) || undefined;
          if (kindRaw === "object" || (Array.isArray(p.range) && p.range.length > 0)) {
            m.set(iri, "object");
            continue;
          }
          if (kindRaw === "datatype" || (Array.isArray(p.range) && p.range.length === 0 && Array.isArray(p.domain) && p.domain.length === 0)) {
            m.set(iri, "datatype");
            continue;
          }
          if (kindRaw === "annotation") {
            m.set(iri, "annotation");
            continue;
          }
          // fallback unknown
          if (!m.has(iri)) m.set(iri, "unknown");
        } catch (_) { /* ignore per-entry */ }
      }
    } catch (_) { /* ignore */ }
    return m;
  }, [availablePropertiesSnapshot, ontologiesVersion]);

  const predicateKindFn = useCallback((predIri: string) => {
    try {
      const k = predicateKindLookup.get(String(predIri));
      return (k as any) || "unknown";
    } catch (_) {
      return "unknown";
    }
  }, [predicateKindLookup]);

  // Snapshot of available classes derived from the ontology store so we pass
  // stable references to the mapper/worker and avoid triggering unnecessary work.
  const availableClassesSnapshot = useMemo(() => {
    try {
      return Array.isArray(availableClasses) ? (availableClasses as any[]).slice() : [];
    } catch (_) {
      return [];
    }
  }, [availableClasses, ontologiesVersion]);

  // Namespace registry snapshot used by the mapper. Use ontologiesVersion as a
  // cheap and reliable signal that the registry may have changed.
  const registrySnapshot = useMemo(() => {
    try {
      const st = (useOntologyStore as any).getState && (useOntologyStore as any).getState();
      const reg = st && Array.isArray(st.namespaceRegistry) ? st.namespaceRegistry.slice() : [];
      return reg;
    } catch (_) {
      return [];
    }
  }, [ontologiesVersion]);

  const initialMapRef = useRef(true);

  // In-process mapper wrapper kept for compatibility with earlier worker-based
  // experiments. For now we run the pure mapper synchronously on the main thread.
  // Keeping this wrapper lets us later reintroduce a worker without changing
  // translateQuadsToDiagram call sites.
  const mapQuadsWithWorker = async (quads: any[], opts: any) => {
    try {
      return mapQuadsToDiagram(quads, opts);
    } catch (err) {
      throw err;
    }
  };
  const loadTriggerRef = useRef(false);
  const loadFitRef = useRef(false);

  // Removed legacy diagramRef/positionsRef shim: LayoutManager is now pure and returns node changes.
  const layoutManagerRef = useRef<LayoutManager | null>(new LayoutManager());

  const layoutInProgressRef = useRef<boolean>(false);
  const lastLayoutFingerprintRef = useRef<string | null>(null);
  const suppressSelectionRef = useRef<boolean>(false);

  const linkSourceRef = useRef<NodeData | null>(null);
  const linkTargetRef = useRef<NodeData | null>(null);
  const getRdfManagerRef = useRef(getRdfManager);

  // Small control refs for layout coordination
  const mappingInProgressRef = useRef<boolean>(false);
  const applyRequestedRef = useRef<boolean>(false);
  // One-shot flag to force layout after the next successful mapping run (used by loaders)
  const forceLayoutNextMappingRef = useRef<boolean>(false);

  // Keep refs in sync with state so other callbacks can read the latest snapshot synchronously.


  const doLayout = useCallback(
    async (candidateNodes: RFNode<NodeData>[], candidateEdges: RFEdge<LinkData>[], force = false, layoutTypeOverride?: string) => {
      if (!force && (!layoutEnabled || !(config && config.autoApplyLayout))) return;
      if (layoutInProgressRef.current) {
        if (!force) return;
        return;
      }

      const lm = layoutManagerRef.current;
      if (!lm) return;

      const fingerprintParts: string[] = [];
      for (const n of candidateNodes || []) {
        const id = String(n.id);
        const px = n.position ? Math.round((n.position as any).x) : 0;
        const py = n.position ? Math.round((n.position as any).y) : 0;
        fingerprintParts.push(`${id}|${px}|${py}`);
      }
      for (const e of candidateEdges || []) {
        fingerprintParts.push(`E:${String(e.id)}`);
      }
      const fingerprint = fingerprintParts.join(';');

      if (!force && lastLayoutFingerprintRef.current === fingerprint) return;

      layoutInProgressRef.current = true;
      try {
        const layoutType = layoutTypeOverride || (config && (config.currentLayout)) || lm.suggestOptimalLayout();

        // Ask the layout manager to compute node change objects for the provided nodes/edges.
        const nodeChanges = await lm.applyLayout(layoutType as any, { nodeSpacing: (config && (config.layoutSpacing as any)) || undefined }, {
          nodes: candidateNodes || [],
          edges: candidateEdges || [],
        });

        // Apply layout results to React Flow state via applyNodeChanges so RF runtime metadata is preserved.
        if (Array.isArray(nodeChanges) && nodeChanges.length > 0) {
          try {
            setNodes((prev) => applyNodeChanges(nodeChanges as any, prev || []));
          } catch (errApply) {
            // Fallback: if applyNodeChanges fails, attempt a reset-merge using the returned positions
            try {
              setNodes((prev = []) => {
                const prevById = new Map((prev || []).map((p) => [String(p.id), p]));
                const changes = (nodeChanges || []).map((nc: any) => {
                  const id = String(nc.id);
                  const pos = nc.position || (nc.item && nc.item.position) || { x: 0, y: 0 };
                  const existing = prevById.get(id);
                  const item = existing
                    ? { ...(existing as any), position: pos, data: { ...(existing as any).data, ...(nc.item && nc.item.data ? nc.item.data : {}) } }
                    : { id, type: "ontology", position: pos, data: (nc.item && nc.item.data) || {} };
                  return { id, type: "reset", item };
                });
                return applyNodeChanges(changes as any, prev || []);
              });
            } catch {
              // Last resort: full replace with nodes from nodeChanges (best-effort)
              try {
                const full = (nodeChanges || []).map((nc: any) => ({
                  id: String(nc.id),
                  type: "ontology",
                  position: nc.position || (nc.item && nc.item.position) || { x: 0, y: 0 },
                  data: (nc.item && nc.item.data) || {},
                })) as RFNode<NodeData>[];
                setNodes(full);
              } catch {
                // swallow to avoid breaking layout caller
              }
            }
          }
        }
      } catch (err) {
        // allow errors to surface in tests
        throw err;
      } finally {
        lastLayoutFingerprintRef.current = fingerprint;
        layoutInProgressRef.current = false;
      }
    },
    [layoutEnabled, config],
  );

  useEffect(() => {
    const auto = !!(config && (config as any).autoApplyLayout);
    if (!auto) return;

    const nodeIds = (nodes || []).map((n) => String(n.id)).sort().join(',');
    const edgeIds = (edges || []).map((e) => String(e.id)).sort().join(',');
    const structFp = `N:${nodeIds}|E:${edgeIds}`;

    if (lastLayoutFingerprintRef.current !== structFp) {
      lastLayoutFingerprintRef.current = structFp;
      void doLayout(nodes, edges, false);
    }
  }, [nodes.length, edges.length, config && (config as any).autoApplyLayout, doLayout]);

  useEffect(() => {
    const auto = !!(config && (config as any).autoApplyLayout);
    if (!auto) return;
    void doLayout(nodes, edges, false);
  }, [viewMode, config && (config as any).autoApplyLayout, doLayout]);

  const handleToggleLegend = useCallback(() => {
    const newValue = !showLegend;
    setShowLegendState(newValue);
    setShowLegend(newValue);
  }, [showLegend, setShowLegend]);

  const handleViewModeChange = useCallback(
    (mode: "abox" | "tbox") => {
      setViewMode(mode);
      setPersistedViewMode(mode);

      setNodes((prev) =>
        (prev || []).map((n) => {
          const copy = { ...(n as RFNode<NodeData>) } as RFNode<NodeData>;
          try { delete (copy as any).selected; } catch (_) { void 0; }
          return copy;
        }),
      );

      setEdges((prev) =>
        (prev || []).map((e) => {
          const copy = { ...(e as RFEdge<LinkData>) } as RFEdge<LinkData>;
          try { delete (copy as any).selected; } catch (_) { void 0; }
          return copy;
        }),
      );
      // Instrumentation: signal that a mapping run completed so tests can wait deterministically.
      try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) { void 0; }
    },
    [setPersistedViewMode, canvasActions, setNodes, setEdges],
  );

  const handleExport = useCallback(
    async (format: "turtle" | "owl-xml" | "json-ld") => {
      const rdfFormat = format === "owl-xml" ? "rdf-xml" : format;
      const content = await exportGraph(rdfFormat as any);
      const blob = new Blob([content], {
        type:
          format === "json-ld"
            ? "application/ld+json"
            : format === "owl-xml"
              ? "application/rdf+xml"
              : "text/turtle",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `knowledge-graph-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "owl-xml" ? "owl" : format === "json-ld" ? "jsonld" : "ttl"}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Graph exported as ${format.toUpperCase()}`);
    },
    [exportGraph],
  );

  const onLoadFile = useCallback(
    async (file: File | any) => {
      canvasActions.setLoading(true, 10, "Reading file...");
      try {
        let text: string;
        if (file.type === "url" || typeof file === "string" || file.url) {
          const url = file.url || file;
          canvasActions.setLoading(true, 10, "Fetching from URL...");
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
          text = await response.text();
        } else {
          text = await file.text();
        }
        canvasActions.setLoading(true, 30, "Parsing RDF...");

        loadTriggerRef.current = true;
        loadFitRef.current = true;

        // Ensure the next mapping run performs layout for this user-initiated load
        try { forceLayoutNextMappingRef.current = true; } catch (_) { void 0; }
        await loadKnowledgeGraph(text, {
          onProgress: (progress: number, message: string) => {
            canvasActions.setLoading(true, Math.max(progress, 30), message);
          },
        });
        toast.success("Knowledge graph loaded successfully");

        setTimeout(() => {
          void doLayout(nodes, edges, true);
        }, 300);
        void doLayout(nodes, edges, true);
      } finally {
        canvasActions.setLoading(false, 0, "");
      }
    },
    [loadKnowledgeGraph, canvasActions, doLayout],
  );

  const handleLayoutChange = useCallback(
    async (layoutType: string, force = false, options?: { nodeSpacing?: number }) => {
      setCurrentLayout(String(layoutType || ""));
      setCurrentLayoutState(String(layoutType || ""));

      if (options && typeof options.nodeSpacing === "number") {
        useAppConfigStore.getState().setLayoutSpacing(Math.max(50, Math.min(500, options.nodeSpacing)));
      }

    await doLayout(nodes, edges, !!force, layoutType);
  },
    [setCurrentLayout, setCurrentLayoutState, doLayout, nodes, edges],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
    if (typeof window !== "undefined") (window as any).__VG_RF_INSTANCE = instance;
  }, []);

  const onSelectionChange = useCallback((selection: { nodes?: any[]; edges?: any[] } = {}) => {

     // If a double-click handler recently set a guard we suppress processing
     // of the selection-change event to avoid races where selection-change
     // would immediately close an editor opened by double-click.
     if (suppressSelectionRef.current) {
       return;
     }

     const selNodes = Array.isArray(selection.nodes) ? selection.nodes : [];
     const selEdges = Array.isArray(selection.edges) ? selection.edges : [];

     if (selNodes.length === 1) {
       setSelectedNodePayload(selNodes[0]);
     } else {
       setSelectedNodePayload(null);
     }

     if (selEdges.length === 1) {
       const e = selEdges[0];
       const src = e.source || (e.data && e.data.from) || "";
       const tgt = e.target || (e.data && e.data.to) || "";
       const payload = {
         id: e.id || e.key || `${src}-${tgt}`,
         key: e.id || e.key || `${src}-${tgt}`,
         source: src,
         target: tgt,
         data: e.data || {},
         operation: "edit",
       };
       setSelectedLinkPayload(payload);
     } else {
       setSelectedLinkPayload(null);
     }
   }, []);

  useEffect(() => {
    // Prefer the store-level getter (works with test mocks) then the selector-provided getter.
    const storeGetter = (useOntologyStore as any).getState && (useOntologyStore as any).getState().getRdfManager;
    const mgr = (typeof storeGetter === "function" ? storeGetter() : undefined) || (typeof getRdfManager === "function" ? getRdfManager() : (getRdfManagerSafe ? getRdfManagerSafe() : undefined));
    if (!mgr) return;

    let mounted = true;
    let debounceTimer: number | null = null;
    // If a mapping run returns an empty result while we still have a previous snapshot,
    // it's likely a transient race. We schedule a single quick retry and skip applying
    // the empty result to avoid clearing the canvas unexpectedly.
    let subjectsCallback: ((subs?: string[] | undefined, quads?: any[] | undefined) => Promise<void>) | null = null;

    const pendingQuads: any[] = [];
    const pendingSubjects: Set<string> = new Set<string>();

    const translateQuadsToDiagram = async (quads: any[]) => {
      let registry: any = undefined;
      if (typeof useOntologyStore === "function" && typeof (useOntologyStore as any).getState === "function") {
        registry = (useOntologyStore as any).getState().namespaceRegistry;
      }
      try {
        console.debug("[VG_DEBUG] translateQuadsToDiagram.input", {
          count: Array.isArray(quads) ? quads.length : 0,
          sample: (Array.isArray(quads) ? quads.slice(0, 10) : quads),
        });
      } catch (_) { void 0; }

      const opts = {
        predicateKind: predicateClassifier,
        availableProperties: availablePropertiesSnapshot,
        availableClasses: availableClasses,
        registry,
        palette: palette as any,
      } as any;

      // Prefer worker offload; fallback to in-process mapper on failure.
      try {
        const res = await mapQuadsWithWorker(quads, opts);
        return res;
      } catch (err) {
        try { console.debug("[VG_DEBUG] mapQuads worker failed, falling back to main thread", { err }); } catch (_) { void 0; }
        try {
          return mapQuadsToDiagram(quads, opts);
        } catch (err2) {
          try { console.debug("[VG_DEBUG] translateQuadsToDiagram fallback failed", { err2 }); } catch (_) { void 0; }
          return { nodes: [], edges: [] };
        }
      }
    };

    const runMapping = async () => {
      if (!mounted) return;
      if (!pendingQuads || pendingQuads.length === 0) return;

      // Atomically consume and clear the pending buffer so each mapping run
      // processes only the quads that were present when the run started.
      const dataQuads: any[] = pendingQuads.splice(0, pendingQuads.length);
      // Capture and clear the set of subjects that changed in this batch
      const subjects: string[] = Array.from(pendingSubjects);
      pendingSubjects.clear();

      try {
        console.debug("[VG_DEBUG] mappingBatch.start", {
          pendingQuads: dataQuads.map((q: any) => ({
            subject: q && q.subject ? (q.subject as any).value : undefined,
            predicate: q && q.predicate ? (q.predicate as any).value : undefined,
            object: q && q.object ? (q.object as any).value : undefined,
            graph: q && q.graph ? (q.graph as any).value : undefined,
          })),
        });
      } catch (_) { void 0; }

      // Minimal, deterministic mapping: translate quads and apply mapper output
      // directly using React Flow's applyNodeChanges/applyEdgeChanges helper.
      const diagram = await translateQuadsToDiagram(dataQuads);
      const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes);
      const mappedEdges: RFEdge<LinkData>[] = ((diagram && diagram.edges) || []).map((e: any) => createEdge(e));

      // Build deterministic add/replace change objects so:
      // - mapper-provided positions are applied only for new nodes
      // - existing nodes preserve runtime metadata (position, selected, __rf, etc.)
      try { mappingInProgressRef.current = true; } catch (_) { void 0; }

      // Update nodes using a functional updater so we compare against the latest snapshot.
      try {
        setNodes((prev = []) => {
          const prevArr = prev || [];
          const prevById = new Map((prevArr || []).map((n: any) => [String(n.id), n]));
          const changes: any[] = [];

          for (const m of mappedNodes || []) {
            try {
              const id = String(m.id);
              const existing = prevById.get(id);
              if (existing) {
                // Existing node: preserve runtime metadata (position, selected, __rf, etc.)
                // Do NOT overwrite position from the mapper for existing nodes.
                const item = {
                  ...existing,
                  type: m.type || existing.type,
                  position: existing.position || (m && m.position) || { x: 0, y: 0 },
                  data: (m && m.data) ? { ...(m.data) } : { ...(existing.data || {}) },
                } as any;
                changes.push({ id, type: "replace", item });
              } else {
                // New node: allow mapper-provided position (node position is only passed to new nodes)
                const item = {
                  ...(m as any),
                  position: (m && m.position) ? m.position : { x: 0, y: 0 },
                } as any;
                changes.push({ type: "add", item });
              }
            } catch (_) {
              // per-item ignore
            }
          }

          if (changes.length === 0) return prevArr;
          return applyNodeChanges(changes as any, prevArr);
        });
      } catch (_) { /* ignore node update failures */ }

      // Update edges using a functional updater so we compare against the latest snapshot.
      try {
        setEdges((prev = []) => {
          const prevArr = prev || [];
          const prevById = new Map(prevArr.map((e: any) => [String(e.id), e]));
          const changes: any[] = [];

          for (const m of mappedEdges || []) {
            try {
              const id = String(m.id);
              const existing = prevById.get(id);
              if (existing) {
                const item = {
                  ...existing,
                  source: (m && m.source) ? m.source : existing.source,
                  target: (m && m.target) ? m.target : existing.target,
                  data: { ...(existing.data || {}), ...(m && m.data ? m.data : {}) },
                } as any;
                changes.push({ id, type: "replace", item });
              } else {
                const item = { ...(m as any) } as any;
                changes.push({ type: "add", item });
              }
            } catch (_) {
              // per-item ignore
            }
          }

          if (changes.length === 0) return prevArr;
          return applyEdgeChanges(changes as any, prevArr);
        });
      } catch (_) { /* ignore edge update failures */ }

      // Signal mapping completion for tests
      try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) { void 0; }

      // Schedule layout and queued-apply processing on next tick (ensures state flushed)
      try {
        setTimeout(async () => {
          try {
            mappingInProgressRef.current = false;

            const mergedNodes = Array.isArray(mappedNodes) ? mappedNodes : (nodes || []);
            const mergedEdges = Array.isArray(mappedEdges) ? mappedEdges : (edges || []);

            // If loader requested a forced layout for the next mapping, honor it first.
            if (forceLayoutNextMappingRef.current) {
              forceLayoutNextMappingRef.current = false;
              try {
                await doLayout(mergedNodes, mergedEdges, true);
                // Give React Flow a moment to apply node changes, then fit the view so the user sees the graph.
                try { await new Promise((r) => setTimeout(r, 50)); } catch (_) { void 0; }
                try {
                  const inst = reactFlowInstance && reactFlowInstance.current;
                  if (inst && typeof (inst as any).fitView === "function") {
                    try { (inst as any).fitView({ padding: 0.1 }); } catch (_) { void 0; }
                  }
                } catch (_) { void 0; }
              } catch (_) { void 0; }
            } else {
              // Otherwise run layout if autoApplyLayout is enabled
              try {
                const autoLayoutEnabled = !!(config && (config as any).autoApplyLayout);
                if (autoLayoutEnabled) {
                  await doLayout(mergedNodes, mergedEdges, true);
                }
              } catch (_) { /* ignore layout errors */ }
            }

            // Honor any manual Apply that was queued while mapping was in progress
            if (applyRequestedRef.current) {
              applyRequestedRef.current = false;
              try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) { void 0; }
            }
          } catch (_) {
            /* swallow scheduling failures */
          }
        }, 0);
      } catch (_) { void 0; }

    };

    if (!initialMapRef.current) {
      // runMapping();
    } else {
      initialMapRef.current = false;
    }

    const scheduleRunMapping = () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        runMapping();
        debounceTimer = null;
      }, 100);
    };

    subjectsCallback = async (subs?: string[] | undefined, quads?: any[] | undefined) => {
      try {
        console.debug("[VG_DEBUG] rdfManager.onSubjectsChange", {
          subjects: Array.isArray(subs) ? subs.slice() : subs,
          quads: (Array.isArray(quads) ? (quads as any[]).map((q: any) => ({
            subject: q && q.subject ? (q.subject as any).value : undefined,
            predicate: q && q.predicate ? (q.predicate as any).value : undefined,
            object: q && q.object ? (q.object as any).value : undefined,
            graph: q && q.graph ? (q.graph as any).value : undefined,
          })) : []),
        });
      } catch (_) { void 0; }

      // Normalize incoming subjects
      const incomingSubjects = Array.isArray(subs) ? subs.map((s) => String(s)) : [];
      if (incomingSubjects.length > 0) {
        for (const s of incomingSubjects) {
          try { pendingSubjects.add(String(s)); } catch (_) { void 0; }
        }
      }

      // If we have quads for this emission attempt, apply the mapper output directly by
      // projecting mapper items into change objects and using applyNodeChanges/applyEdgeChanges.
      if (Array.isArray(quads) && quads.length > 0) {
          try {
            const diagram = await translateQuadsToDiagram(quads || []);
            const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
            const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges) || [];

          const mappedById = new Map((mappedNodes || []).map((m: any) => [String(m.id), m]));
          const mappedEdgeById = new Map((mappedEdges || []).map((e: any) => [String(e.id), e]));

          // Merge mapper output into the current nodes via add/replace changes so
          // mapper-provided positions are applied only to new nodes and existing
          // runtime metadata is preserved.
          try {
            setNodes((prev = []) => {
              const prevArr = prev || [];
              const prevById = new Map((prevArr || []).map((n: any) => [String(n.id), n]));
              const changes: any[] = [];

              for (const m of mappedNodes || []) {
                try {
                  const id = String(m.id);
                  const existing = prevById.get(id);
                  if (existing) {
                    const item = {
                      ...existing,
                      type: m.type || existing.type,
                      position: existing.position || (m && m.position) || { x: 0, y: 0 },
                      data: (m && m.data) ? { ...(m.data) } : { ...(existing.data || {}) },
                    } as any;
                    changes.push({ id, type: "replace", item });
                  } else {
                    const item = {
                      ...(m as any),
                      position: (m && m.position) ? m.position : { x: 0, y: 0 },
                    } as any;
                    changes.push({ type: "add", item });
                  }
                } catch (_) {
                  // per-item ignore
                }
              }

              if (changes.length === 0) return prevArr;
              return applyNodeChanges(changes as any, prevArr);
            });
          } catch (_) { /* ignore node update failures */ }

          // Do not remove edges here — the mapper merge below will update/add edges.
          // Removing edges that reference changed subjects can drop edges when the mapper
          // returns a partial result (e.g. node-only updates). Keep the subjectSet
          // available for future use if explicit deletions become detectable.
          const subjectSet = new Set<string>((incomingSubjects || []).map((s: any) => String(s)));

          // Merge/update existing edges and append new edges (functional update).
          try {
            setEdges((prev = []) => {
              const prevArr = prev || [];
              const prevById = new Map(prevArr.map((e: any) => [String(e.id), e]));
              const out = prevArr.map((e: any) => {
                const m = mappedEdgeById.get(String(e.id));
                if (!m) return e;
                return {
                  ...e,
                  source: m.source || e.source,
                  target: m.target || e.target,
                  data: { ...(e.data || {}), ...(m.data || {}) },
                };
              });
              for (const m of mappedEdges || []) {
                if (!prevById.has(String(m.id))) out.push(m);
              }
              return out;
            });
          } catch (_) {
            try { setEdges(mappedEdges); } catch (_) { void 0; }
          }

          // Ensure endpoints referenced by mappedEdges exist as nodes (append placeholders if needed).
          try {
            setNodes((prev = []) => {
              const current = prev || [];
              const currentIds = new Set(current.map((n) => String(n.id)));
              const placeholders: RFNode<NodeData>[] = [];
              for (const e of mappedEdges || []) {
                if (e && String(e.source) && !currentIds.has(String(e.source))) {
                  currentIds.add(String(e.source));
                  placeholders.push({
                    id: String(e.source),
                    type: "ontology",
                    position: { x: 0, y: 0 },
                    data: {
                      key: String(e.source),
                      iri: String(e.source),
                      rdfTypes: [],
                      literalProperties: [],
                      annotationProperties: [],
                      visible: true,
                      hasReasoningError: false,
                      namespace: "",
                      label: String(e.source),
                    } as NodeData,
                  } as RFNode<NodeData>);
                }
                if (e && String(e.target) && !currentIds.has(String(e.target))) {
                  currentIds.add(String(e.target));
                  placeholders.push({
                    id: String(e.target),
                    type: "ontology",
                    position: { x: 0, y: 0 },
                    data: {
                      key: String(e.target),
                      iri: String(e.target),
                      rdfTypes: [],
                      literalProperties: [],
                      annotationProperties: [],
                      visible: true,
                      hasReasoningError: false,
                      namespace: "",
                      label: String(e.target),
                    } as NodeData,
                  } as RFNode<NodeData>);
                }
              }
              if (placeholders.length === 0) return current;
              return [...current, ...placeholders];
            });
          } catch (_) { /* ignore */ }

          // Signal mapping completion for tests
          try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) { void 0; }

          // Schedule layout against the merged mapper output (next tick so state flushes).
          try {
            setTimeout(async () => {
              try {
                const mergedNodes = Array.isArray(mappedNodes) ? mappedNodes : (nodes || []);
                const mergedEdges = Array.isArray(mappedEdges) ? mappedEdges : (edges || []);

                if (forceLayoutNextMappingRef.current) {
                  forceLayoutNextMappingRef.current = false;
                  try {
                    await doLayout(mergedNodes, mergedEdges, true);
                    try { await new Promise((r) => setTimeout(r, 50)); } catch (_) { void 0; }
                    try {
                      const inst = reactFlowInstance && reactFlowInstance.current;
                      if (inst && typeof (inst as any).fitView === "function") {
                        try { (inst as any).fitView({ padding: 0.1 }); } catch (_) { void 0; }
                      }
                    } catch (_) { void 0; }
                  } catch (_) { void 0; }
                } else {
                  const autoLayoutEnabled = !!(config && (config as any).autoApplyLayout);
                  if (autoLayoutEnabled) {
                    try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) { void 0; }
                  }
                }

                if (applyRequestedRef.current) {
                  applyRequestedRef.current = false;
                  try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) { void 0; }
                }
              } catch (_) { /* ignore */ }
            }, 0);
          } catch (_) { void 0; }

          return;
        } catch (err) {
          try { console.debug("[VG_DEBUG] subjectsCallback.directMappingFailed", { err }); } catch (_) { void 0; }
          // fallthrough to queued mapping path below
        }
      }

      // Fallback: queue quads and schedule debounced mapping
      if (Array.isArray(quads) && quads.length > 0) {
        for (const q of quads) pendingQuads.push(q);
      }
      scheduleRunMapping();
    };

    // Subscribe to subject-level incremental notifications when available.
    if (typeof mgr.onSubjectsChange === "function" && subjectsCallback) {
      try { console.debug("[VG_DEBUG] registering mgr.onSubjectsChange"); } catch (_) { void 0; }
      try { mgr.onSubjectsChange(subjectsCallback as any); } catch (err) { try { console.debug("[VG_DEBUG] mgr.onSubjectsChange registration failed", err); } catch (_) { void 0; } }
    } else {
      try { console.debug("[VG_DEBUG] mgr.onSubjectsChange not available, subjectsCallback not registered"); } catch (_) { void 0; }
    }

    // Run an initial snapshot-to-mapping immediately so the canvas populates on mount
    // even if the RDF manager does not emit a subject-level event right away.
    try {
      const store = mgr.getStore && typeof mgr.getStore === "function" ? mgr.getStore() : null;
      if (store && typeof store.getQuads === "function") {
        const all = store.getQuads(null, null, null, null) || [];
        if (Array.isArray(all) && all.length > 0) {
          // Seed pendingQuads from the authoritative store snapshot and run mapping now.
          for (const q of all) pendingQuads.push(q);

          try { console.debug("[VG_DEBUG] seeded pendingQuads from store snapshot", { count: pendingQuads.length }); } catch (_) { void 0; }

          // Eager initial seeding: compute mapper output synchronously so the canvas
          // has a deterministically seeded node/edge snapshot immediately. This
          // avoids races in test environments where async mapping scheduling may
          // run after assertions that expect nodes to be present.
          try {
            const eagerOpts = {
              predicateKind: predicateClassifier,
              availableProperties: availablePropertiesSnapshot,
              availableClasses: availableClassesSnapshot,
              registry: registrySnapshot,
              palette: palette as any,
            } as any;
            try {
              const diagram = mapQuadsToDiagram(all, eagerOpts);
              const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
              const mappedEdges: RFEdge<LinkData>[] = ((diagram && diagram.edges) || []).map((e: any) => createEdge(e));

              // Merge into React Flow state without removing existing runtime metadata.
              try {
                setNodes((prev = []) => {
                  const current = prev || [];
                  const byId = new Map(current.map((n) => [String(n.id), n]));
                  const out = current.slice();
                  for (const m of mappedNodes || []) {
                    if (!byId.has(String(m.id))) out.push(m as any);
                  }
                  return out;
                });
              } catch (_) { /* ignore */ }

              try {
                setEdges((prev = []) => {
                  const current = prev || [];
                  const byId = new Set(current.map((e) => String(e.id)));
                  const out = current.slice();
                  for (const me of mappedEdges || []) {
                    if (!byId.has(String(me.id))) out.push(me as any);
                  }
                  return out;
                });
              } catch (_) { /* ignore */ }
            } catch (errMapSync) {
              try { console.debug("[VG_DEBUG] eager mapQuadsToDiagram failed", errMapSync); } catch (_) { void 0; }
            }
          } catch (_) { void 0; }

          try { scheduleRunMapping(); } catch (err) { try { console.debug("[VG_DEBUG] scheduleRunMapping failed", err); } catch (_) { void 0; } }
        }
      }
    } catch (_) { /* ignore snapshot failures */ }

    // Also subscribe to the generic change counter as a robust fallback for
    // environments where subject-level notifications are not delivered.
    // The onChange handler will request a full store snapshot and schedule a mapping run.
    // NOTE: removed full-store onChange fallback. Canvas now relies solely on
    // subject-level incremental notifications (mgr.onSubjectsChange) and explicit
    // initial snapshot seeding. The full-store fallback caused large mapping runs
    // for localized edits and has been intentionally removed.

    return () => {
      mounted = false;
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (typeof mgr.offSubjectsChange === "function" && subjectsCallback) {
        mgr.offSubjectsChange(subjectsCallback as any);
      }
      
    };
  }, [getRdfManager, setNodes, setEdges, availableProperties, availableClasses]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;
    // Expose a helper so other UI components can request that the next mapping run triggers layout.
    try {
      (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING = () => {
        try { forceLayoutNextMappingRef.current = true; } catch (_) { void 0; }
      };
    } catch (_) { void 0; }

    const pending = (window as any).__VG_APPLY_LAYOUT_PENDING;
      if (Array.isArray(pending) && pending.length > 0) {
      void Promise.resolve().then(async () => {
        for (const req of pending.splice(0)) {
          try {
            await doLayout(nodes, edges, true);
            await new Promise((r) => setTimeout(r, 200));
            try { req.resolve(true); } catch (_) { void 0; }
          } catch (err) {
            try { req.resolve(false); } catch (_) { void 0; }
          }
        }
      });
    }

    (window as any).__VG_APPLY_LAYOUT = async (layoutKey?: string) => {
      try {
        await doLayout(nodes, edges, true);
        await new Promise((r) => setTimeout(r, 200));
        return true;
      } catch {
        return false;
      }
    };

    return () => {
      try { delete (window as any).__VG_KNOWLEDGE_CANVAS_READY; } catch (_) { void 0; }
      try { delete (window as any).__VG_APPLY_LAYOUT; } catch (_) { void 0; }
    };
  }, []);


  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__VG_INIT_APP = async (opts?: { force?: boolean }) => {
      try {
        (window as any).__VG_INIT_APP_RAN = true;

        const cfg =
          (useAppConfigStore as any).getState
            ? (useAppConfigStore as any).getState().config
            : config;
        const additional = Array.isArray(cfg?.additionalOntologies)
          ? cfg.additionalOntologies.filter(Boolean)
          : [];

        let startupUrl = "";
        try {
          const u = new URL(String(window.location.href));
          startupUrl =
            u.searchParams.get("url") ||
            u.searchParams.get("rdfUrl") ||
            u.searchParams.get("vg_url") ||
            "";
        } catch (_) {
          startupUrl = "";
        }

        // If user configured additional ontologies and persisted autoload is enabled,
        // load them immediately on startup (no gates/fallbacks).
        try {
          const disabledList = Array.isArray(cfg?.disabledAdditionalOntologies) ? cfg.disabledAdditionalOntologies : [];
          const toLoad = (additional || []).filter((u: any) => u && !disabledList.includes(u));
          if (Array.isArray(toLoad) && toLoad.length > 0 && typeof loadAdditionalOntologies === "function" && cfg && cfg.persistedAutoload) {
            try {
              console.debug("[VG_DEBUG] Autoload start - configured additionalOntologies:", toLoad);
              canvasActions.setLoading(true, 5, "Autoloading configured ontologies...");
              // Mark that the next mapping should trigger layout since these are startup loads
              try { forceLayoutNextMappingRef.current = true; } catch (_) { void 0; }
              await loadAdditionalOntologies(toLoad, (progress: number, message: string) => {
                try {
                  console.debug(`[VG_DEBUG] loadAdditionalOntologies progress ${progress}%: ${message}`);
                } catch (_) { void 0; }
                try { canvasActions.setLoading(true, Math.max(5, progress), message); } catch (_) { void 0; }
              });
              try { console.debug("[VG_DEBUG] Autoload complete - requested ontologies loaded"); } catch (_) { void 0; }
              loadTriggerRef.current = true;
              loadFitRef.current = true;
            } finally {
              canvasActions.setLoading(false, 0, "");
            }
          } else {
            // preserve previous trigger behavior when autoload not enabled
            if (additional && additional.length > 0 && typeof loadAdditionalOntologies === "function") {
              loadTriggerRef.current = true;
            }
          }
        } catch (err) {
          try { console.debug("[VG_DEBUG] Autoload error", err); } catch (_) { void 0; }
          // ensure we don't block init on autoload failures
          if (additional && additional.length > 0 && typeof loadAdditionalOntologies === "function") {
            loadTriggerRef.current = true;
          }
        }

        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          try {
            canvasActions.setLoading(true, 5, "Loading startup graph...");
            // Mark that the next mapping should trigger a layout since this is a user-requested startup load
            try { forceLayoutNextMappingRef.current = true; } catch (_) { void 0; }
            await loadKnowledgeGraph(startupUrl, {
              onProgress: (progress: number, message: string) => {
                canvasActions.setLoading(true, Math.max(progress, 5), message);
              },
              timeout: 30000,
            });
            toast.success("Startup knowledge graph loaded");
            loadTriggerRef.current = true;
            loadFitRef.current = true;
          } finally {
            canvasActions.setLoading(false, 0, "");
          }
        }
      } catch (_) {
        //
      }
    };

    if (typeof (window as any).__VG_INIT_APP === "function") {
      (window as any).__VG_INIT_APP({ force: true });
    }

    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) { void 0; }
    };
  }, [loadKnowledgeGraph]);

  useEffect(() => {
    const nodeHiddenById = new Map<string, boolean>();

    setNodes((prev) =>
      (prev || []).map((n) => {
        try {
          const isTBox = !!(n.data && (n.data as any).isTBox);
          const visibleFlag =
            n.data && typeof (n.data as any).visible === "boolean"
              ? (n.data as any).visible
              : true;
          const shouldBeVisible = visibleFlag && (viewMode === "tbox" ? isTBox : !isTBox);
          const hidden = !shouldBeVisible;
          nodeHiddenById.set(String(n.id), hidden);
          return hidden === !!(n as any).hidden ? n : { ...n, hidden };
        } catch (_) {
          return n;
        }
      }),
    );

    setEdges((prev) =>
      (prev || []).map((e) => {
        try {
          const s = String(e.source);
          const t = String(e.target);
          const sHidden = nodeHiddenById.get(s) || false;
          const tHidden = nodeHiddenById.get(t) || false;

          let hidden = !!sHidden || !!tHidden;

          if (!hidden) {
            const sNode = nodes.find((nn) => String(nn.id) === s);
            const tNode = nodes.find((nn) => String(nn.id) === t);
            if (!sNode || !tNode) {
              hidden = true;
            } else {
              const sIsT = !!(sNode.data && (sNode.data as any).isTBox);
              const tIsT = !!(tNode.data && (tNode.data as any).isTBox);
              if (sIsT !== tIsT) hidden = true;
              else {
                const shouldBeTBox = viewMode === "tbox";
                if (sIsT !== shouldBeTBox) hidden = true;
              }
            }
          }

          return hidden === !!(e as any).hidden ? e : { ...e, hidden };
        } catch (_) {
          return e;
        }
      }),
    );
  }, [viewMode, nodes.length, edges.length, setNodes, setEdges]);

  const triggerReasoningStrict = useCallback(
    async (ns: RFNode<NodeData>[], es: RFEdge<LinkData>[], force = false) => {
      if (!startReasoning || (!settings?.autoReasoning && !force)) return;
      const nodesPayload = (ns || []).map((n) =>
        n.data && n.data.iri ? { iri: n.data.iri, key: n.id } : { key: n.id },
      );
      const edgesPayload = (es || []).map((e) => ({ id: e.id, source: e.source, target: e.target }));
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      const result = await startReasoning(nodesPayload as any, edgesPayload as any, mgr && mgr.getStore && mgr.getStore());

      const errors = Array.isArray(result?.errors) ? result.errors : [];
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];

      const nodeErrMap = new Map<string, string[]>();
      const nodeWarnMap = new Map<string, string[]>();
      const edgeErrMap = new Map<string, string[]>();
      const edgeWarnMap = new Map<string, string[]>();

      try {
        for (const er of errors) {
          try {
            if (er && er.nodeId) {
              const a = nodeErrMap.get(String(er.nodeId)) || [];
              a.push(String(er.message || er));
              nodeErrMap.set(String(er.nodeId), a);
            }
            if (er && er.edgeId) {
              const a = edgeErrMap.get(String(er.edgeId)) || [];
              a.push(String(er.message || er));
              edgeErrMap.set(String(er.edgeId), a);
            }
          } catch (_) { /* per-item */ }
        }
      } catch (_) { /* ignore */ }

      try {
        for (const w of warnings) {
          try {
            if (w && w.nodeId) {
              const a = nodeWarnMap.get(String(w.nodeId)) || [];
              a.push(String(w.message || w));
              nodeWarnMap.set(String(w.nodeId), a);
            }
            if (w && w.edgeId) {
              const a = edgeWarnMap.get(String(w.edgeId)) || [];
              a.push(String(w.message || w));
              edgeWarnMap.set(String(w.edgeId), a);
            }
          } catch (_) { /* per-item */ }
        }
      } catch (_) { /* ignore */ }

      // Merge targeted node updates (only nodes referenced in the reasoning result)
      setNodes((nds) =>
        (nds || []).map((n) => {
          try {
            const id = String(n.id);
            const errs = nodeErrMap.get(id) || [];
            const warns = nodeWarnMap.get(id) || [];
            const prevErrs = (n.data && (n.data as any).reasoningErrors) || [];
            const prevWarns = (n.data && (n.data as any).reasoningWarnings) || [];
            const changed =
              JSON.stringify(prevErrs) !== JSON.stringify(errs) ||
              JSON.stringify(prevWarns) !== JSON.stringify(warns);
            if (!changed) return n;
            return {
              ...(n as RFNode<NodeData>),
              data: {
                ...(n.data as NodeData),
                reasoningErrors: errs,
                reasoningWarnings: warns,
                hasReasoningError: errs.length > 0,
                hasReasoningWarning: warns.length > 0,
              },
            } as RFNode<NodeData>;
          } catch (_) {
            return n;
          }
        }),
      );

      // Merge targeted edge updates (only edges referenced in the reasoning result)
      setEdges((eds) =>
        (eds || []).map((e) => {
          try {
            const id = String(e.id);
            const errs = edgeErrMap.get(id) || [];
            const warns = edgeWarnMap.get(id) || [];
            const prevErrs = (e.data && (e.data as any).reasoningErrors) || [];
            const prevWarns = (e.data && (e.data as any).reasoningWarnings) || [];
            const changed =
              JSON.stringify(prevErrs) !== JSON.stringify(errs) ||
              JSON.stringify(prevWarns) !== JSON.stringify(warns);
            if (!changed) return e;
            return {
              ...(e as RFEdge<LinkData>),
              data: {
                ...(e.data as LinkData),
                reasoningErrors: errs,
                reasoningWarnings: warns,
                hasReasoningError: errs.length > 0,
                hasReasoningWarning: warns.length > 0,
              },
            } as RFEdge<LinkData>;
          } catch (_) {
            return e;
          }
        }),
      );
    },
    [setNodes, setEdges, startReasoning, settings],
  );

  // Sync reasoning results from the global reasoning store into node/edge data so
  // the UI components (CustomOntologyNode / FloatingEdge) can render borders and
  // tooltip messages. This effect listens for updates to the current reasoning
  // result and applies targeted updates only to referenced nodes/edges.
  const currentReasoning = useReasoningStore((s) => s.currentReasoning);
  useEffect(() => {
    if (!currentReasoning) return;

    const result = currentReasoning;
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];

    const nodeErrMap = new Map<string, string[]>();
    const nodeWarnMap = new Map<string, string[]>();
    const edgeErrMap = new Map<string, string[]>();
    const edgeWarnMap = new Map<string, string[]>();

    try {
      for (const er of errors) {
        try {
          if (er && er.nodeId) {
            const a = nodeErrMap.get(String(er.nodeId)) || [];
            a.push(String(er.message || er));
            nodeErrMap.set(String(er.nodeId), a);
          }
          if (er && er.edgeId) {
            const a = edgeErrMap.get(String(er.edgeId)) || [];
            a.push(String(er.message || er));
            edgeErrMap.set(String(er.edgeId), a);
          }
        } catch (_) { /* per-item */ }
      }
    } catch (_) { /* ignore */ }

    try {
      for (const w of warnings) {
        try {
          if (w && w.nodeId) {
            const a = nodeWarnMap.get(String(w.nodeId)) || [];
            a.push(String(w.message || w));
            nodeWarnMap.set(String(w.nodeId), a);
          }
          if (w && w.edgeId) {
            const a = edgeWarnMap.get(String(w.edgeId)) || [];
            a.push(String(w.message || w));
            edgeWarnMap.set(String(w.edgeId), a);
          }
        } catch (_) { /* per-item */ }
      }
    } catch (_) { /* ignore */ }

    // Merge targeted node updates (only nodes referenced in the reasoning result)
    setNodes((nds) =>
      (nds || []).map((n) => {
        try {
          const id = String(n.id);
          const errs = nodeErrMap.get(id) || [];
          const warns = nodeWarnMap.get(id) || [];
          const prevErrs = (n.data && (n.data as any).reasoningErrors) || [];
          const prevWarns = (n.data && (n.data as any).reasoningWarnings) || [];
          const changed =
            JSON.stringify(prevErrs) !== JSON.stringify(errs) ||
            JSON.stringify(prevWarns) !== JSON.stringify(warns);
          if (!changed) return n;
          return {
            ...(n as RFNode<NodeData>),
            data: {
              ...(n.data as NodeData),
              reasoningErrors: errs,
              reasoningWarnings: warns,
              hasReasoningError: errs.length > 0,
              hasReasoningWarning: warns.length > 0,
            },
          } as RFNode<NodeData>;
        } catch (_) {
          return n;
        }
      }),
    );

    // Merge targeted edge updates (only edges referenced in the reasoning result)
    setEdges((eds) =>
      (eds || []).map((e) => {
        try {
          const id = String(e.id);
          const errs = edgeErrMap.get(id) || [];
          const warns = edgeWarnMap.get(id) || [];
          const prevErrs = (e.data && (e.data as any).reasoningErrors) || [];
          const prevWarns = (e.data && (e.data as any).reasoningWarnings) || [];
          const changed =
            JSON.stringify(prevErrs) !== JSON.stringify(errs) ||
            JSON.stringify(prevWarns) !== JSON.stringify(warns);
          if (!changed) return e;
          return {
            ...(e as RFEdge<LinkData>),
            data: {
              ...(e.data as LinkData),
              reasoningErrors: errs,
              reasoningWarnings: warns,
              hasReasoningError: errs.length > 0,
              hasReasoningWarning: warns.length > 0,
            },
          } as RFEdge<LinkData>;
        } catch (_) {
          return e;
        }
      }),
    );

    // After applying reasoning-specific updates, trigger a subject-level emission
    // for all known nodes so consumers (mapper/canvas) receive authoritative quads
    // even if the reasoner wrote inferred triples directly into the raw store.
    try {
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgr && typeof (mgr as any).triggerSubjectUpdate === "function") {
        try {
          const allNodeIris = (nodes || []).map((n) =>
            (n && n.data && (n.data as any).iri) ? String((n.data as any).iri) : String(n.id),
          );
          // Only trigger the subject update when the canvas has fully initialized.
          // This prevents premature emissions during test renders before providers
          // (e.g. TooltipProvider) are mounted, which would cause provider-required
          // components to throw.
          if (typeof window !== "undefined" && (window as any).__VG_KNOWLEDGE_CANVAS_READY) {
            // Fire-and-forget but catch errors to avoid blocking UI
            (mgr as any).triggerSubjectUpdate(allNodeIris).catch((err: any) => {
              try { console.debug("[VG_DEBUG] triggerSubjectUpdate failed", err); } catch (_) { /* ignore */ }
            });
          } else {
            try { console.debug("[VG_DEBUG] skipping triggerSubjectUpdate: canvas not ready"); } catch (_) { /* ignore */ }
          }
        } catch (err) {
          try { console.debug("[VG_DEBUG] triggerSubjectUpdate invocation failed", err); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }, [currentReasoning, setNodes, setEdges]);

  const onNodeDoubleClickStrict = useCallback((event: any, node: any) => {
    try { event?.stopPropagation && event.stopPropagation(); } catch (_) { void 0; }
    try { suppressSelectionRef.current = true; setTimeout(() => { suppressSelectionRef.current = false; }, 0); } catch (_) { void 0; }
    const wasSelected = !!(node && (node as any).selected);
    setSelectedNodePayload(node || null);
    if (wasSelected) {
      setNodeEditorOpen(true);
    } else {
      try {
        setNodes((prev = []) => (prev || []).map((n) => ({ ...n, selected: String(n.id) === String(node.id) })));
      } catch (_) { void 0; }
    }
  }, [setNodes]);

  // Drag performance metrics: simple measurement of drag event frequency and derived FPS.
  // Enabled only when the global debugAll flag is active in app config to avoid overhead in production.
  const dragMetricsRef = useRef<{ start?: number; last?: number; count: number; intervals: number[] }>({ count: 0, intervals: [] });

  const isDebugMetricsEnabled = () => {
    try {
      return !!(config && (config as any).debugAll);
    } catch (_) {
      return false;
    }
  };

  const onNodeDragStart = useCallback((event: any, node: any) => {
    try {
      if (!isDebugMetricsEnabled()) return;
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      dragMetricsRef.current.start = now;
      dragMetricsRef.current.last = now;
      dragMetricsRef.current.count = 0;
      dragMetricsRef.current.intervals = [];
      try { (window as any).__VG_DRAG_METRICS_ACTIVE = true; } catch (_) { void 0; }
    } catch (_) { void 0; }
  }, [config]);

  const onNodeDrag = useCallback((event: any, node: any) => {
    try {
      if (!isDebugMetricsEnabled()) return;
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const last = dragMetricsRef.current.last || now;
      const delta = now - last;
      dragMetricsRef.current.intervals.push(delta);
      dragMetricsRef.current.last = now;
      dragMetricsRef.current.count = (dragMetricsRef.current.count || 0) + 1;
    } catch (_) { void 0; }
  }, [config]);

  const onNodeDragStop = useCallback((event: any, node: any) => {
    try {
      if (!isDebugMetricsEnabled()) return;
      const intervals = dragMetricsRef.current.intervals || [];
      try { (window as any).__VG_DRAG_METRICS_ACTIVE = false; } catch (_) { void 0; }
      if (intervals.length === 0) {
        try { console.debug("[VG_DEBUG] drag metrics: no intervals"); } catch (_) { void 0; }
      } else {
        const sum = intervals.reduce((a, b) => a + b, 0);
        const avg = sum / intervals.length;
        const fps = avg > 0 ? 1000 / avg : 0;
        const count = dragMetricsRef.current.count || intervals.length;
        const metrics = { count, avgMs: Number(avg.toFixed(2)), fps: Math.round(fps) };
        try { console.debug("[VG_DEBUG] drag metrics", metrics); } catch (_) { void 0; }
        try { (window as any).__VG_LAST_DRAG_METRICS = metrics; } catch (_) { void 0; }
      }
    } catch (_) { void 0; }
  }, [config]);

  const onEdgeDoubleClickStrict = useCallback((event: any, edge: any) => {
    try { event?.stopPropagation && event.stopPropagation(); } catch (_) { void 0; }
    try { suppressSelectionRef.current = true; setTimeout(() => { suppressSelectionRef.current = false; }, 0); } catch (_) { void 0; }
    const srcId = edge.source || edge.from || (edge.data && edge.data.from) || '';
    const tgtId = edge.target || edge.to || (edge.data && edge.data.to) || '';

    const findNode = (id: string) =>
      nodes.find((n) => {
        try {
          return (
            String(n.id) === String(id) ||
            String((n as any).key) === String(id) ||
            (n.data && (String(n.data.iri) === String(id) || String(n.data.key) === String(id)))
          );
        } catch {
          return false;
        }
      });

    const sourceNode = findNode(srcId);
    const targetNode = findNode(tgtId);

    linkSourceRef.current = sourceNode ? (sourceNode.data as any) : null;
    linkTargetRef.current = targetNode ? (targetNode.data as any) : null;

    const edgeData = edge.data || {};
    const propUriFromEdge =
      edgeData.propertyUri || edgeData.propertyType || edge.propertyUri || edge.propertyType || "";
    let propLabelFromEdge = "";
    if (edgeData.label) {
      propLabelFromEdge = String(edgeData.label);
    } else {
      const foundPropEdge =
        (availableProperties || []).find((p: any) => String(p.iri) === String(propUriFromEdge)) ||
        (loadedOntologies || []).flatMap((o: any) => o.properties || []).find((p: any) => String(p.iri) === String(propUriFromEdge));
      if (foundPropEdge && (foundPropEdge.label || foundPropEdge.name)) {
        propLabelFromEdge = String(foundPropEdge.label || foundPropEdge.name);
      } else {
        const mgrLocal = getRdfManagerRef.current && getRdfManagerRef.current();
        if (mgrLocal && propUriFromEdge) {
          propLabelFromEdge = String(propUriFromEdge);
        } else {
          propLabelFromEdge = "";
        }
      }
    }

    const selectedLinkPayload = {
      id: edge.id || edge.key || `${srcId}-${tgtId}`,
      key: edge.id || edge.key || `${srcId}-${tgtId}`,
      source: srcId,
      target: tgtId,
      data: {
        propertyType: edgeData.propertyType || edge.propertyType || '',
        propertyUri: propUriFromEdge,
        label: propLabelFromEdge,
      },
    };

    const wasSelected = !!(edge && (edge as any).selected);
    setSelectedLinkPayload(selectedLinkPayload || edge || null);
    if (wasSelected) {
      setLinkEditorOpen(true);
    } else {
      try {
        setEdges((prev = []) => (prev || []).map((e) => ({ ...e, selected: String(e.id) === String(edge.id) })));
      } catch (_) { void 0; }
    }
  }, [nodes, availableProperties, loadedOntologies, setEdges]);

  const onEdgeClickStrict = useCallback((event: any, edge: any) => {
    try { event?.stopPropagation && event.stopPropagation(); } catch (_) { void 0; }
    try { suppressSelectionRef.current = true; setTimeout(() => { suppressSelectionRef.current = false; }, 0); } catch (_) { void 0; }
    const srcId = edge.source || edge.from || (edge.data && edge.data.from) || '';
    const tgtId = edge.target || edge.to || (edge.data && edge.data.to) || '';

    const findNode = (id: string) =>
      nodes.find((n) => {
        try {
          return (
            String(n.id) === String(id) ||
            String((n as any).key) === String(id) ||
            (n.data && (String(n.data.iri) === String(id) || String(n.data.key) === String(id)))
          );
        } catch {
          return false;
        }
      });

    const sourceNode = findNode(srcId);
    const targetNode = findNode(tgtId);

    linkSourceRef.current = sourceNode ? (sourceNode.data as any) : null;
    linkTargetRef.current = targetNode ? (targetNode.data as any) : null;

    const selectedLinkPayload = {
      id: edge.id || edge.key || `${srcId}-${tgtId}`,
      key: edge.id || edge.key || `${srcId}-${tgtId}`,
      source: srcId,
      target: tgtId,
      data: {
        propertyType: edge.data?.propertyType || edge.propertyType || '',
        propertyUri: edge.data?.propertyUri || edge.propertyUri || '',
        label: edge.data?.label || '',
      },
    };

    setSelectedLinkPayload(selectedLinkPayload || edge || null);
    setLinkEditorOpen(true);
  }, [nodes]);

  const onConnectStrict = useCallback((params: any) => {
    if (!params || !params.source || !params.target) return;
    const sourceNode = nodes.find((n) => n.id === params.source);
    const targetNode = nodes.find((n) => n.id === params.target);
    if (!sourceNode || !targetNode) {
      toast.error("Invalid connection endpoints");
      return;
    }
    if (params.source === params.target) {
      toast.error("Cannot connect a node to itself");
      return;
    }
    const sourceIsTBox = !!(sourceNode.data && (sourceNode.data as any).isTBox);
    const targetIsTBox = !!(targetNode.data && (targetNode.data as any).isTBox);
    if (sourceIsTBox !== targetIsTBox) {
      toast.error("Cannot connect nodes across ABox and TBox");
      return;
    }

    const claimedSource = String(params.source);
    const claimedTarget = String(params.target);

    let predCandidate: string | null = null;
    if (availableProperties && availableProperties.length > 0) {
      const srcClass =
        sourceNode && sourceNode.data
          ? `${(sourceNode.data as any).namespace || ""}:${(sourceNode.data as any).classType || ""}`
          : "";
      const tgtClass =
        targetNode && targetNode.data
          ? `${(targetNode.data as any).namespace || ""}:${(targetNode.data as any).classType || ""}`
          : "";

      const compatible = (availableProperties || []).find((p: any) => {
        const domain = Array.isArray(p.domain) ? p.domain : [];
        const range = Array.isArray(p.range) ? p.range : [];
        const domainMatch = domain.length === 0 || !srcClass || domain.includes(srcClass);
        const rangeMatch = range.length === 0 || !tgtClass || range.includes(tgtClass);
        return domainMatch && rangeMatch;
      });

      predCandidate = compatible
        ? (compatible.iri || (compatible as any).key || "")
        : (availableProperties[0].iri || (availableProperties[0] as any).key);
    }

    const predFallback = predCandidate || "http://www.w3.org/2002/07/owl#topObjectProperty";
    const predUriToUse = predCandidate || predFallback;

    let predLabel = "";
    const mgrLocal = getRdfManagerRef.current && getRdfManagerRef.current();
    if (mgrLocal && predUriToUse) predLabel = String(predUriToUse);

    linkSourceRef.current = sourceNode ? (sourceNode.data as any) : null;
    linkTargetRef.current = targetNode ? (targetNode.data as any) : null;

    // Generate a deterministic edge id based on subject/predicate/object only.
    // Do NOT include handle ids in the id — keep the mapping canonical to IRIs.
    const baseEdgeId = generateEdgeId(String(claimedSource), String(claimedTarget), String(predUriToUse || ""));
    const edgeIdForEditor = String((params as any).id || baseEdgeId);

    const selectedEdgeForEditor = {
      id: edgeIdForEditor,
      key: edgeIdForEditor,
      operation: "create",
      source: claimedSource,
      target: claimedTarget,
      data: {
        propertyUri: predUriToUse,
        label: predLabel,
      },
    };

    setSelectedLinkPayload(selectedEdgeForEditor as any);
    setLinkEditorOpen(true);
  }, [nodes, availableProperties, loadedOntologies]);


  const handleSaveNodeProperties = useCallback(
    async (properties: any[]) => {
    if (!selectedNodePayload) return;
    const entityUri =
        (selectedNodePayload as any)?.iri ||
        (selectedNodePayload as any)?.key;
      if (!entityUri) return;
      const annotationProperties = (properties || []).map((p: any) => ({
        property: p.key || p.property,
        value: p.value,
        datatype: p.type || "xsd:string",
      }));


      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgr && typeof mgr.getStore === "function") {
        const store = mgr.getStore();
        const g = namedNode("urn:vg:data");
        const subjTerm = termForIri(String(entityUri));
        for (const ap of annotationProperties) {
          const predFull = mgr.expandPrefix && typeof mgr.expandPrefix === "function" ? mgr.expandPrefix(ap.property) : ap.property;
          const predTerm = namedNode(predFull);
          const objTerm = typeof ap.value === "string" ? DataFactory.literal(String(ap.value)) : DataFactory.literal(String(ap.value));
          const exists = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
          if (!exists || exists.length === 0) {
            store.addQuad(DataFactory.quad(subjTerm, predTerm, objTerm, g));
          }
        }
      }
    },
    [selectedNodePayload, setNodes],
  );

  const handleSaveLinkProperty = useCallback(
    (propertyUri: string, label: string) => {
      const selected = selectedLinkPayload;
      if (!selected) return;

      setEdges((eds) =>
        eds.map((e) => {
          const keyMatch =
            e.id === (selected as any).key || e.id === (selected as any).id;
          if (keyMatch) {
            const newData: LinkData = {
              ...(e.data as LinkData),
              propertyType: propertyUri,
              propertyUri,
              label,
            };
            return { ...e, data: newData };
          }
          return e;
        }),
      );

      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgr && typeof mgr.getStore === "function" && selected) {
        const store = mgr.getStore();

        const subjIri =
          (selected as any).source ||
          (selected as any).data?.from ||
          (selected as any).from ||
          "";
        const objIri =
          (selected as any).target ||
          (selected as any).data?.to ||
          (selected as any).to ||
          "";

        if (subjIri && objIri) {
          const subjTerm = termForIri(String(subjIri));
          const objTerm = termForIri(String(objIri));

          const oldPredRaw =
            (selected as any).data?.propertyUri ||
            (selected as any).data?.propertyType ||
            (selected as any).propertyUri ||
            (selected as any).propertyType ||
            "";
          if (oldPredRaw) {
            const oldPredFull =
              mgr.expandPrefix && typeof mgr.expandPrefix === "function"
                ? mgr.expandPrefix(oldPredRaw)
                : oldPredRaw;
            const g = namedNode("urn:vg:data");
            const found =
              store.getQuads(
                subjTerm,
                namedNode(oldPredFull),
                objTerm,
                g,
              ) || [];
            for (const q of found) store.removeQuad(q);
          }

          const newPredFull =
            mgr.expandPrefix && typeof mgr.expandPrefix === "function"
              ? mgr.expandPrefix(propertyUri)
              : propertyUri;
          const newPredTerm = namedNode(newPredFull);
          const g = namedNode("urn:vg:data");
          const exists =
            store.getQuads(subjTerm, newPredTerm, objTerm, g) || [];
          if (exists.length === 0) {
            store.addQuad(DataFactory.quad(subjTerm, newPredTerm, objTerm, g));
          }
        }
      }
    },
    [selectedLinkPayload, setEdges],
  );

  const memoNodeTypes = useMemo(() => ({ ontology: OntologyNode }), [OntologyNode]);
  const memoEdgeTypes = useMemo(() => ({ floating: FloatingEdge }), [FloatingEdge]);
  const memoConnectionLine = useMemo(() => FloatingConnectionLine, [FloatingConnectionLine]);

  const safeNodes = useMemo(() => {
    return (nodes || []).map((n) => {
      if (!n || !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number") {
        return { ...(n || {}), position: { x: 0, y: 0 } } as RFNode<NodeData>;
      }
      return n;
    });
  }, [nodes]);

  // Memoize edges to provide a stable reference into ReactFlow and avoid
  // unnecessary reprocessing when edge list content hasn't materially changed.
  // We compute a small fingerprint based on edge ids to detect content changes.
  const memoEdges = useMemo(() => {
    try {
      return (edges || []).slice();
    } catch (_) {
      return edges;
    }
  }, [(edges || []).length, (edges || []).map((e: any) => String(e.id)).join(",")]);

  // Use React Flow native change handlers so RF manages runtime metadata correctly.
  const onNodesChange = useCallback(
    (changes: any) => setNodes((nodesSnapshot) => applyNodeChanges(changes, nodesSnapshot)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: any) => setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [setEdges],
  );

  
  return (
    <div className="h-lvh h-lvw h-screen bg-canvas-bg relative">
      <CanvasToolbar
        onAddNode={(payload: any) => {
          let normalizedUri = String(payload && (payload.iri || payload) ? (payload.iri || payload) : "");
          if (!/^https?:\/\//i.test(normalizedUri)) {
            const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
            if (mgr && typeof (mgr as any).expandPrefix === "function") {
              const expanded = (mgr as any).expandPrefix(normalizedUri);
              if (expanded && typeof expanded === "string") normalizedUri = expanded;
            }
          }

          if (!normalizedUri || !/^https?:\/\//i.test(normalizedUri)) return;

          const id = String(normalizedUri);
          const startPos = { x: 100, y: 100 };
          setNodes((nds) => [
            ...nds,
            {
              id,
              type: "ontology",
              position: startPos,
              data: {
                key: id,
                iri: normalizedUri,
                rdfTypes: [],
                literalProperties: [],
                annotationProperties: [],
                visible: true,
                hasReasoningError: false,
                namespace: "",
                label: normalizedUri,
              } as NodeData,
            },
          ]);
        }}
        onToggleLegend={handleToggleLegend}
        showLegend={showLegend}
        onExport={handleExport}
        onLoadFile={onLoadFile}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onLayoutChange={handleLayoutChange}
        currentLayout={currentLayout}
        layoutEnabled={layoutEnabled}
        onToggleLayoutEnabled={handleToggleLayoutEnabled}
        availableEntities={allEntities}
      />
      {showLegend ? <ResizableNamespaceLegend onClose={() => handleToggleLegend()} /> : null}
      {canvasState.isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-50 bg-card p-4 rounded-lg shadow-lg min-w-96">
          <div className="space-y-2">
            <div className="text-sm font-medium">
              {canvasState.loadingMessage}
            </div>
            <Progress value={canvasState.loadingProgress} className="w-full" />
            <div className="text-xs text-muted-foreground">
              {canvasState.loadingProgress}%
            </div>
          </div>
        </div>
      )}

      <div className="w-full h-full">
        <ReactFlow
            nodes={safeNodes}
            edges={memoEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onInit={onInit}
            onNodeDoubleClick={onNodeDoubleClickStrict}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onEdgeClick={onEdgeClickStrict}
            onConnect={onConnectStrict}
            onSelectionChange={onSelectionChange}
            nodeTypes={memoNodeTypes}
            edgeTypes={memoEdgeTypes}
            connectionLineComponent={memoConnectionLine}
            connectOnClick={false}
            minZoom={0.1}
            className="knowledge-graph-canvas bg-canvas-bg"
          >
          <Controls position="bottom-left" showInteractive={true} showZoom={true} showFitView={true} className="bg-muted/50" />
          <MiniMap nodeStrokeWidth={3} pannable={true}/>
          <Background gap={16} color="var(--grid-color, rgba(0,0,0,0.03))" />
        </ReactFlow>

      </div>

      <div className="fixed bottom-4 left-0 right-0 z-50 pointer-events-none">
        <div className="flex items-center justify-end gap-6 pointer-events-auto w-full px-4">
          <ReasoningIndicator
            onOpenReport={() => canvasActions.toggleReasoningReport(true)}
            onRunReason={() => {
              void triggerReasoningStrict(nodes, edges, true);
            }}
          />
        </div>
      </div>

      <ReasoningReportModal
        open={canvasState.showReasoningReport}
        onOpenChange={canvasActions.toggleReasoningReport}
      />
      <NodePropertyEditor
        open={nodeEditorOpen}
        onOpenChange={(open) => {
          setNodeEditorOpen(Boolean(open));
        }}
        nodeData={selectedNodePayload}
        availableEntities={allEntities}
        onSave={(props: any[]) => {
          handleSaveNodeProperties(props);
          setNodeEditorOpen(false);
        }}
        onDelete={(iriOrId: string) => {
          try {
            const id = String(iriOrId);
            // Remove node from RF state by id or by node.data.iri match
            try {
              setNodes((prev = []) =>
                (prev || []).filter((n) => {
                  try {
                    const nid = String(n.id);
                    const iri = n && (n as any).data && (n as any).data.iri ? String((n as any).data.iri) : "";
                    return nid !== id && iri !== id;
                  } catch {
                    return true;
                  }
                }),
              );
            } catch (_) { void 0; }
            // Remove edges touching the node
            try {
              setEdges((prev = []) =>
                (prev || []).filter((e) => {
                  try {
                    return String(e.source) !== id && String(e.target) !== id;
                  } catch {
                    return true;
                  }
                }),
              );
            } catch (_) { void 0; }
            // Best-effort: ask react-flow instance to delete elements if supported
            try {
              const inst = reactFlowInstance && reactFlowInstance.current;
              if (inst && typeof (inst as any).deleteElements === "function") {
                try { (inst as any).deleteElements([{ id }]); } catch (_) { void 0; }
              }
            } catch (_) { void 0; }
          } catch (_) { void 0; }
        }}
      />

      <LinkPropertyEditor
        open={linkEditorOpen}
        onOpenChange={(open) => {
          setLinkEditorOpen(Boolean(open));
        }}
        linkData={selectedLinkPayload}
        sourceNode={linkSourceRef.current}
        targetNode={linkTargetRef.current}
        onSave={(propertyUri: string, label: string) => {
          handleSaveLinkProperty(propertyUri, label);
          setLinkEditorOpen(false);
        }}
      />
    </div>
  );
};

export default KnowledgeCanvas;
