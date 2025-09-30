/* eslint-disable no-empty, @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-expressions, no-useless-catch */
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
} from "@xyflow/react";
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
  const {
    loadedOntologies,
    availableClasses,
    loadKnowledgeGraph,
    exportGraph,
    loadAdditionalOntologies,
    getRdfManager,
    availableProperties,
    availableClasses: ac,
    ontologiesVersion,
  } = useOntologyStore();
  const { startReasoning } = useReasoningStore();
  const { settings } = useSettingsStore();
  const {
    config,
    setCurrentLayout,
    setShowLegend,
    setViewMode: setPersistedViewMode,
  } = useAppConfigStore();

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
    const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
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
    return loadedOntologies.flatMap((ontology) => [
      ...ontology.classes.map((cls) => ({
        iri: cls.iri,
        label: cls.label,
        namespace: cls.namespace,
        rdfType: "owl:Class" as const,
        description: `Class from ${ontology.name}`,
      })),
      ...ontology.properties.map((prop) => ({
        iri: prop.iri,
        label: prop.label,
        namespace: prop.namespace,
        rdfType: prop.iri.includes("ObjectProperty")
          ? "owl:ObjectProperty"
          : ("owl:AnnotationProperty" as const),
        description: `Property from ${ontology.name}`,
      })),
    ]);
  }, [ontologiesVersion, loadedOntologies]);

  const availablePropertiesSnapshot = useMemo(() => {
    return Array.isArray(availableProperties) ? (availableProperties as any[]).slice() : [];
  }, [availableProperties, ontologiesVersion]);

  const initialMapRef = useRef(true);
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
  const originalAutoLayoutRef = useRef<boolean | null>(null);
  // One-shot flag to force layout after the next successful mapping run (used by loaders)
  const forceLayoutNextMappingRef = useRef<boolean>(false);

  // Keep refs in sync with state so other callbacks can read the latest snapshot synchronously.


  const doLayout = useCallback(
    async (candidateNodes: RFNode<NodeData>[], candidateEdges: RFEdge<LinkData>[], force = false) => {
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
        const layoutType = (config && (config.currentLayout)) || lm.suggestOptimalLayout();

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
          try { delete (copy as any).selected; } catch (_) {}
          return copy;
        }),
      );

      setEdges((prev) =>
        (prev || []).map((e) => {
          const copy = { ...(e as RFEdge<LinkData>) } as RFEdge<LinkData>;
          try { delete (copy as any).selected; } catch (_) {}
          return copy;
        }),
      );
      // Instrumentation: signal that a mapping run completed so tests can wait deterministically.
      try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) {}
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
        try { forceLayoutNextMappingRef.current = true; } catch (_) {}
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

    await doLayout(nodes, edges, !!force);
  },
    [setCurrentLayout, setCurrentLayoutState, doLayout],
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
       setNodeEditorOpen(true);
     } else {
       setSelectedNodePayload(null);
       setNodeEditorOpen(false);
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
       setLinkEditorOpen(true);
     } else {
       setSelectedLinkPayload(null);
       setLinkEditorOpen(false);
     }
   }, []);

  useEffect(() => {
    const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
    if (!mgr) return;

    let mounted = true;
    let debounceTimer: number | null = null;
    // If a mapping run returns an empty result while we still have a previous snapshot,
    // it's likely a transient race. We schedule a single quick retry and skip applying
    // the empty result to avoid clearing the canvas unexpectedly.
    let subjectsCallback: ((subs?: string[] | undefined, quads?: any[] | undefined) => void) | null = null;

    const pendingQuads: any[] = [];
    const pendingSubjects: Set<string> = new Set<string>();

    const translateQuadsToDiagram = (quads: any[]) => {
      let registry: any = undefined;
      if (typeof useOntologyStore === "function" && typeof (useOntologyStore as any).getState === "function") {
        registry = (useOntologyStore as any).getState().namespaceRegistry;
      }
      try {
        console.debug("[VG_DEBUG] translateQuadsToDiagram.input", {
          count: Array.isArray(quads) ? quads.length : 0,
          sample: (Array.isArray(quads) ? quads.slice(0, 10) : quads),
        });
      } catch (_) {}
      return mapQuadsToDiagram(quads, ({
        predicateKind: predicateClassifier,
        availableProperties: availablePropertiesSnapshot,
        availableClasses: availableClasses,
        registry,
        palette: palette as any,
      } as any));
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
      } catch (_) {}

      // Minimal, deterministic mapping: translate quads and apply mapper output
      // directly using React Flow's applyNodeChanges/applyEdgeChanges helper.
      const diagram = translateQuadsToDiagram(dataQuads);
      const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes);
      const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges);

      // Project mapper output to simple change objects (reset each node/edge to mapper's item).
      const nodeChanges = (mappedNodes || []).map((n: any) => ({ id: String(n.id), type: "reset", item: n }));
      const edgeChanges = (mappedEdges || []).map((e: any) => ({ id: String(e.id), type: "reset", item: e }));

      // mark mapping active
      try { mappingInProgressRef.current = true; } catch (_) {}

      setNodes((prev) => applyNodeChanges(nodeChanges as any, prev));
      setEdges((prev) => applyEdgeChanges(edgeChanges as any, prev));

      // Signal mapping completion for tests
      try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) {}

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
                try { await new Promise((r) => setTimeout(r, 50)); } catch (_) {}
                try {
                  const inst = reactFlowInstance && reactFlowInstance.current;
                  if (inst && typeof (inst as any).fitView === "function") {
                    try { (inst as any).fitView({ padding: 0.1 }); } catch (_) {}
                  }
                } catch (_) {}
              } catch (_) {}
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
              try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) {}
            }
          } catch (_) {
            /* swallow scheduling failures */
          }
        }, 0);
      } catch (_) {}

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

    subjectsCallback = (subs?: string[] | undefined, quads?: any[] | undefined) => {
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
      } catch (_) {}

      // Normalize incoming subjects
      const incomingSubjects = Array.isArray(subs) ? subs.map((s) => String(s)) : [];
      if (incomingSubjects.length > 0) {
        for (const s of incomingSubjects) {
          try { pendingSubjects.add(String(s)); } catch (_) {}
        }
      }

      // If we have quads for this emission attempt, apply the mapper output directly by
      // projecting mapper items into change objects and using applyNodeChanges/applyEdgeChanges.
      if (Array.isArray(quads) && quads.length > 0) {
        try {
          const diagram = translateQuadsToDiagram(quads || []);
          const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
          const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges) || [];

          const mappedById = new Map((mappedNodes || []).map((m: any) => [String(m.id), m]));
          const mappedEdgeById = new Map((mappedEdges || []).map((e: any) => [String(e.id), e]));

          // Snapshot prev state for id checks (use current closure vars safely)
          const prevNodeIds = new Set((nodes || []).map((n) => String(n.id)));
          const prevEdgeIds = new Set((edges || []).map((e) => String(e.id)));

          // Split mapped nodes into existing (update via applyNodeChanges) and new (append)
          const existingMappedNodes = (mappedNodes || []).filter((m: any) => prevNodeIds.has(String(m.id)));
          const newMappedNodes = (mappedNodes || []).filter((m: any) => !prevNodeIds.has(String(m.id)));

          // 1) Update existing nodes (preserve RF runtime metadata) using applyNodeChanges
          try {
            if ((existingMappedNodes || []).length > 0) {
              const nodeChanges = (existingMappedNodes || []).map((n: any) => ({ id: String(n.id), type: "reset", item: n }));
              setNodes((prev) => applyNodeChanges(nodeChanges as any, prev || []));
            }
          } catch (_) {
            // fallback: if applyNodeChanges unexpectedly fails, replace whole nodes array
            try { setNodes(mappedNodes); } catch (_) {}
          }

          // 2) Remove edges that touch any of the incoming subjects (incomingSubjects comes from outer normalization)
          // We remove edges where the subject is either the source or the target so that
          // mapper output for the subject can replace all links touching it.
          const subjectSet = new Set<string>((incomingSubjects || []).map((s: any) => String(s)));
          try {
            setEdges((prev = []) =>
              (prev || []).filter((e) => {
                try {
                  const src = String(e.source);
                  const tgt = String(e.target);
                  return !subjectSet.has(src) && !subjectSet.has(tgt);
                } catch (_) {
                  return true;
                }
              }),
            );
          } catch (_) { /* ignore */ }

          // 3) Merge/update existing edges and append new edges
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
            try { setEdges(mappedEdges); } catch (_) {}
          }

          // 4) Append new mapped nodes that weren't present (filter again against the current nodes)
          try {
            setNodes((prev = []) => {
              const nowIds = new Set((prev || []).map((n) => String(n.id)));
              const toAdd = (newMappedNodes || []).filter((m: any) => !nowIds.has(String(m.id)));
              if (!toAdd || toAdd.length === 0) return prev || [];
              return [...(prev || []), ...toAdd];
            });
          } catch (_) { /* ignore */ }

          // 5) Ensure endpoints referenced by mappedEdges exist as nodes (append placeholders if needed)
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
          try { if (typeof window !== "undefined") (window as any).__VG_LAST_MAPPING_RUN = Date.now(); } catch (_) {}

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
                    try { await new Promise((r) => setTimeout(r, 50)); } catch (_) {}
                    try {
                      const inst = reactFlowInstance && reactFlowInstance.current;
                      if (inst && typeof (inst as any).fitView === "function") {
                        try { (inst as any).fitView({ padding: 0.1 }); } catch (_) {}
                      }
                    } catch (_) {}
                  } catch (_) {}
                } else {
                  const autoLayoutEnabled = !!(config && (config as any).autoApplyLayout);
                  if (autoLayoutEnabled) {
                    try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) {}
                  }
                }

                if (applyRequestedRef.current) {
                  applyRequestedRef.current = false;
                  try { await doLayout(mergedNodes, mergedEdges, true); } catch (_) {}
                }
              } catch (_) { /* ignore */ }
            }, 0);
          } catch (_) {}

          return;
        } catch (err) {
          try { console.debug("[VG_DEBUG] subjectsCallback.directMappingFailed", { err }); } catch (_) {}
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
      mgr.onSubjectsChange(subjectsCallback as any);
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

        }
      }
    } catch (_) { /* ignore snapshot failures */ }

    // Also subscribe to the generic change counter as a robust fallback for
    // environments where subject-level notifications are not delivered.
    // The onChange handler will request a full store snapshot and schedule a mapping run.
    let changeCallback: ((count?: number, meta?: any) => void) | null = null;
    if (typeof mgr.onChange === "function") {
      changeCallback = (_count?: number) => {
        try {
          // Replace any pending incremental queue with a snapshot of the full store
          // so mapQuadsToDiagram runs with authoritative data.
          try {
            pendingQuads.length = 0;
            const store = mgr.getStore && typeof mgr.getStore === "function" ? mgr.getStore() : null;
            if (store && typeof store.getQuads === "function") {
              const all = store.getQuads(null, null, null, null) || [];
              for (const q of all) pendingQuads.push(q);
            }
          } catch (_) {
            // ignore failures but continue to schedule mapping
          }
          scheduleRunMapping();
        } catch (_) {
          /* ignore onChange handler errors */
        }
      };
      try {
        mgr.onChange(changeCallback as any);
      } catch (_) {
        changeCallback = null;
      }
    }

    return () => {
      mounted = false;
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (typeof mgr.offSubjectsChange === "function" && subjectsCallback) {
        mgr.offSubjectsChange(subjectsCallback as any);
      }
      if (changeCallback && typeof mgr.offChange === "function") {
        try { mgr.offChange(changeCallback as any); } catch (_) { /* ignore */ }
      }
    };
  }, [getRdfManager, setNodes, setEdges, availableProperties, availableClasses]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;
    // Expose a helper so other UI components can request that the next mapping run triggers layout.
    try {
      (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING = () => {
        try { forceLayoutNextMappingRef.current = true; } catch (_) {}
      };
    } catch (_) {}

    const pending = (window as any).__VG_APPLY_LAYOUT_PENDING;
      if (Array.isArray(pending) && pending.length > 0) {
      void Promise.resolve().then(async () => {
        for (const req of pending.splice(0)) {
          try {
            await doLayout(nodes, edges, true);
            await new Promise((r) => setTimeout(r, 200));
            try { req.resolve(true); } catch (_) {}
          } catch (err) {
            try { req.resolve(false); } catch (_) {}
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
      try { delete (window as any).__VG_KNOWLEDGE_CANVAS_READY; } catch (_) {}
      try { delete (window as any).__VG_APPLY_LAYOUT; } catch (_) {}
    };
  }, []);

  useEffect(() => {
    const missing = (nodes || []).filter((n) => {
      try {
        return !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number";
      } catch (_) {
        return true;
      }
    });
    if (missing.length > 0) {
      try {
        // no-op: keep behavior but don't log
      } catch (_) {}
    }
  }, [nodes]);

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

        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          try {
            canvasActions.setLoading(true, 5, "Loading startup graph...");
            // Mark that the next mapping should trigger a layout since this is a user-requested startup load
            try { forceLayoutNextMappingRef.current = true; } catch (_) {}
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

        if (additional && additional.length > 0 && typeof loadAdditionalOntologies === "function") {
          loadTriggerRef.current = true;
        }
      } catch (_) {
        //
      }
    };

    if (typeof (window as any).__VG_INIT_APP === "function") {
      (window as any).__VG_INIT_APP({ force: true });
    }

    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) {}
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
      setNodes((nds) =>
        (nds || []).map((n) => {
          try {
            const hasNodeErr = !!(
              Array.isArray(result?.errors) &&
              result.errors.find((er: any) => er.nodeId === n.id)
            );
            return { ...(n as RFNode<NodeData>), data: { ...(n.data as NodeData), hasReasoningError: hasNodeErr } } as RFNode<NodeData>;
          } catch (_) {
            return n;
          }
        }),
      );
      setEdges((eds) =>
        (eds || []).map((e) => {
          try {
            const hasEdgeErr = !!(
              Array.isArray(result?.errors) &&
              result.errors.find((er: any) => er.edgeId === e.id)
            );
            return { ...(e as RFEdge<LinkData>), data: { ...(e.data as LinkData), hasReasoningError: hasEdgeErr } } as RFEdge<LinkData>;
          } catch (_) {
            return e;
          }
        }),
      );
    },
    [setNodes, setEdges, startReasoning, settings],
  );

  const onNodeDoubleClickStrict = useCallback((event: any, node: any) => {
    try { event?.stopPropagation && event.stopPropagation(); } catch (_) {}
    try { suppressSelectionRef.current = true; setTimeout(() => { suppressSelectionRef.current = false; }, 0); } catch (_) {}
    setSelectedNodePayload(node || null);
    setNodeEditorOpen(true);
  }, []);

  const onEdgeDoubleClickStrict = useCallback((event: any, edge: any) => {
    try { event?.stopPropagation && event.stopPropagation(); } catch (_) {}
    try { suppressSelectionRef.current = true; setTimeout(() => { suppressSelectionRef.current = false; }, 0); } catch (_) {}
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

    setSelectedLinkPayload(selectedLinkPayload || edge || null);
    setLinkEditorOpen(true);
  }, [nodes, availableProperties, loadedOntologies]);

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

    const edgeIdForEditor = String(
      (params as any).id ||
        generateEdgeId(
          String(claimedSource),
          String(claimedTarget),
          String(predUriToUse || ""),
        ),
    );
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

  const onEdgeUpdateStrict = useCallback((oldEdge: RFEdge<LinkData>, connection: any) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) {
      toast.error("Invalid edge update endpoints");
      return;
    }
    if (connection.source === connection.target) {
      toast.error("Cannot create self-loop");
      return;
    }
    const sourceIsTBox = !!(sourceNode.data && (sourceNode.data as any).isTBox);
    const targetIsTBox = !!(targetNode.data && (targetNode.data as any).isTBox);
    if (sourceIsTBox !== targetIsTBox) {
      toast.error("Cannot relink edge across ABox and TBox");
      return;
    }

    const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
    if (mgr && typeof mgr.getStore === "function") {
      const store = mgr.getStore();
      const oldData = oldEdge && oldEdge.data ? (oldEdge.data as LinkData) : undefined;
      const oldPredCandidate = oldData && (oldData.propertyUri || oldData.propertyType)
        ? oldData.propertyUri || oldData.propertyType
        : availableProperties && availableProperties.length > 0
          ? availableProperties[0].iri || (availableProperties[0] as any).key
          : "http://www.w3.org/2000/01/rdf-schema#seeAlso";
      const oldPredFull = mgr.expandPrefix && typeof mgr.expandPrefix === "function" ? mgr.expandPrefix(oldPredCandidate) : oldPredCandidate;
      const oldSubj = oldEdge.source;
      const oldObj = oldEdge.target;

      const oldSubjTerm = termForIri(String(oldSubj));
      const oldObjTerm = termForIri(String(oldObj));
      const g = namedNode("urn:vg:data");
      const found = store.getQuads(oldSubjTerm, namedNode(oldPredFull), oldObjTerm, g) || [];
      for (const q of found) store.removeQuad(q);

      const subjIri = (sourceNode.data && (sourceNode.data as NodeData).iri) || sourceNode.id;
      const objIri = (targetNode.data && (targetNode.data as NodeData).iri) || targetNode.id;
      const subjTerm = termForIri(String(subjIri));
      const objTerm = termForIri(String(objIri));
      const predTerm2 = namedNode(oldPredFull);
      const exists = store.getQuads(subjTerm, predTerm2, objTerm, g) || [];
      if (exists.length === 0) store.addQuad(DataFactory.quad(subjTerm, predTerm2, objTerm, g));

    }

    setEdges((eds) =>
      eds.map((e) =>
        e.id === oldEdge.id
          ? { ...e, source: connection.source!, target: connection.target! }
          : e,
      ),
    );
  }, [nodes, setEdges, availableProperties]);

  const onEdgeUpdateEnd = useCallback(() => {}, []);

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

  const safeNodes = useMemo(() => {
    return (nodes || []).map((n) => {
      if (!n || !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number") {
        return { ...(n || {}), position: { x: 0, y: 0 } } as RFNode<NodeData>;
      }
      return n;
    });
  }, [nodes]);

  // Use React Flow native change handlers so RF manages runtime metadata correctly.
  const onNodesChange = useCallback(
    (changes: any) => setNodes((nodesSnapshot) => applyNodeChanges(changes, nodesSnapshot)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: any) => setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [setEdges],
  );

  const rfProps: any = {
    nodes: safeNodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onInit,
    onNodeDoubleClick: onNodeDoubleClickStrict,
    onEdgeDoubleClick: onEdgeDoubleClickStrict,
    onConnect: onConnectStrict,
    onEdgeUpdate: onEdgeUpdateStrict,
    onEdgeUpdateEnd,
    nodeTypes: { ontology: OntologyNode },
    edgeTypes: { floating: FloatingEdge },
    connectionLineComponent: FloatingConnectionLine,
    minZoom: 0.1,
    className: "knowledge-graph-canvas bg-canvas-bg",
  };

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
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
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onInit={onInit}
            onNodeDoubleClick={onNodeDoubleClickStrict}
            onEdgeDoubleClick={onEdgeDoubleClickStrict}
            onConnect={onConnectStrict}
            onSelectionChange={onSelectionChange}
            nodeTypes={{ ontology: OntologyNode }}
            edgeTypes={{ floating: FloatingEdge }}
            connectionLineComponent={FloatingConnectionLine}
            minZoom={0.1}
            className="knowledge-graph-canvas bg-canvas-bg"
          >
          <Controls position="bottom-left" showInteractive={true} showZoom={true} showFitView={true} />
          <Background gap={16} color="var(--grid-color, rgba(0,0,0,0.03))" />
        </ReactFlow>
      </div>

      <ReasoningIndicator
        onOpenReport={() => canvasActions.toggleReasoningReport(true)}
        onRunReason={() => {
            void triggerReasoningStrict(nodes, edges, true);
        }}
      />

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
