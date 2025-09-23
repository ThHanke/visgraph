/* eslint-disable no-empty, no-unused-expressions */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
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
import { NodePropertyEditor } from "./NodePropertyEditor";
import { LinkPropertyEditor } from "./LinkPropertyEditor";
import { Progress } from "../ui/progress";
import type { ReactFlowInstance } from "@xyflow/react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../types/canvas";
import mapQuadsToDiagram from "./core/mappingHelpers";
import { CustomOntologyNode as OntologyNode } from "./CustomOntologyNode";
import FloatingEdge from "./FloatingEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";
import { generateEdgeId } from "./core/edgeHelpers";
import { computeTermDisplay, shortLocalName } from "../../utils/termUtils";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { useCanvasState } from "../../hooks/useCanvasState";
import { toast } from "sonner";
import { fallback } from "../../utils/startupDebug";
import { LayoutManager } from "./LayoutManager";
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

const KnowledgeCanvas: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<NodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge<LinkData>>([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const { state: canvasState, actions: canvasActions } = useCanvasState();
  const {
    loadedOntologies,
    availableClasses,
    loadKnowledgeGraph,
    exportGraph,
    updateNode,
    loadAdditionalOntologies,
    getRdfManager,
    currentGraph,
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
    addAdditionalOntology,
  } = useAppConfigStore();

  const [viewMode, setViewMode] = useState(config.viewMode);
  const [showLegend, setShowLegendState] = useState(config.showLegend);
  const [currentLayout, setCurrentLayoutState] = useState(config.currentLayout);
  // Layout toggle initialized from persisted config
  const [layoutEnabled, setLayoutEnabled] = useState(() => !!(config && config.autoApplyLayout));

  // Palette from RDF manager — used to compute colors without rebuilding palettes.
  const palette = usePaletteFromRdfManager();

  // Expose namedNode factory for synchronous store queries in the local classifier.
  const { namedNode } = DataFactory;

  // Predicate classifier consults fat-map (availableProperties) then RDF store rdf:type triples.
  const predicateClassifier = (predIri: string) => {
    try {
      // Quick fat-map hint
      try {
        if (Array.isArray(availableProperties)) {
          const found = (availableProperties as any[]).find((p) => String(p.iri) === String(predIri));
          if (found) {
            if (Array.isArray(found.range) && found.range.length > 0) return "object";
            if (Array.isArray(found.domain) && found.domain.length > 0) return "object";
          }
        }
      } catch (_) { /* ignore fat-map failures */ }

      // Precise check against RDF store rdf:type triples (authoritative)
      try {
        const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
        if (!mgr || typeof mgr.getStore !== "function") return "unknown";
        const store = mgr.getStore();
        const rdfTypeIri = typeof (mgr as any).expandPrefix === "function" ? (mgr as any).expandPrefix("rdf:type") : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        const quads = store.getQuads(namedNode(predIri), namedNode(rdfTypeIri), null, null) || [];
        for (const q of quads) {
          try {
            const t = q && (q.object as any) && (q.object as any).value ? String((q.object as any).value) : "";
            if (!t) continue;
            if (t === "http://www.w3.org/2002/07/owl#AnnotationProperty") return "annotation";
            if (t === "http://www.w3.org/2002/07/owl#ObjectProperty") return "object";
            if (t === "http://www.w3.org/2002/07/owl#DatatypeProperty") return "datatype";
          } catch (_) { /* ignore per-quad */ }
        }
      } catch (_) { /* ignore store failures */ }
    } catch (_) { /* ignore overall */ }
    return "unknown";
  };

  // Keep toolbar toggle in sync with persisted config.autoApplyLayout so
  // "Auto" in the toolbar controls whether mapping triggers automatic layout.
  const handleToggleLayoutEnabled = useCallback((enabled: boolean) => {
    try {
      setLayoutEnabled(Boolean(enabled));
      // Persist user preference
      try {
        useAppConfigStore.getState().setAutoApplyLayout(Boolean(enabled));
      } catch (_) { /* ignore persistence failures */ }
    } catch (_) { /* ignore */ }
  }, []);

  // --- Blacklist helpers (copied/adapted from ReactFlowCanvas) ---
  // Filter out reserved/core RDF namespaces/prefixes so they are not shown as canvas nodes.
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
    try {
      const s = String(val).trim();
      if (!s) return false;
      // Prefixed form (e.g., rdf:label) - check prefix before colon if not an absolute IRI
      if (s.includes(':') && !/^https?:\/\//i.test(s)) {
        const prefix = s.split(':', 1)[0];
        if (_blacklistedPrefixes.has(prefix)) return true;
      }
      // Absolute IRI check
      for (const u of _blacklistedUris) {
        try {
          if (s.startsWith(u)) return true;
        } catch (_) { /* ignore per-candidate */ }
      }
    } catch (_) {
      return false;
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

  const initialMapRef = useRef(true);
  // When a programmatic "load" occurs we mark this ref so the next mapping pass can
  // perform a forced layout once the updated nodes/edges are available.
  const loadTriggerRef = useRef(false);

  // Lightweight layout integration
  const diagramRef = useRef<any>({
    nodes: [],
    edges: [],
    // setNodePositions will be called by LayoutManager.applyLayout with positioned nodes.
    // We convert those into full RF nodes and update React Flow state while preserving runtime flags.
    setNodePositions: (positioned: any[]) => {
      try {
        // Build a positions map from the incoming positioned array
        const newPosMap: Record<string, string> = {};
        try {
          if (Array.isArray(positioned)) {
            for (const p of positioned) {
              try {
                const id = String(p && (p.id || p.key || (p.data && (p.data.key || p.data.id))) || "");
                if (!id) continue;
                const pos = p && p.position ? p.position : { x: 0, y: 0 };
                newPosMap[id] = `${Math.round(pos.x)}:${Math.round(pos.y)}`;
              } catch (_) { /* ignore per-item */ }
            }
          }
        } catch (_) { /* ignore build errors */ }

        // Compare with previous positions to avoid unnecessary setNodes calls.
        const prevPosMap = positionsRef.current || {};
        let changed = false;
        try {
          const prevKeys = Object.keys(prevPosMap).sort();
          const newKeys = Object.keys(newPosMap).sort();
          if (prevKeys.length !== newKeys.length) changed = true;
          else {
            for (let i = 0; i < newKeys.length && !changed; i++) {
              const k = newKeys[i];
              if (prevPosMap[k] !== newPosMap[k]) changed = true;
            }
          }
        } catch (_) {
          changed = true;
        }

        if (!changed) {
          // Nothing to apply
          return;
        }

        // Apply merged nodes preserving runtime flags where possible
        setNodes((prev) => {
          try {
            const prevById = new Map<string, RFNode<NodeData>>();
            (prev || []).forEach((n) => prevById.set(String(n.id), n));
            const merged = Array.isArray(positioned)
              ? positioned.map((p) => {
                  const id = String(p && (p.id || p.key || (p.data && (p.data.key || p.data.id))) || "");
                  const pos = p && p.position ? p.position : { x: 0, y: 0 };
                  const prevNode = prevById.get(id);
                  const base = prevNode || (nodes || []).find((n) => String(n.id) === id) || null;
                  const mergedNode: RFNode<NodeData> = base
                    ? { ...base, position: { x: pos.x, y: pos.y } }
                    : {
                        id,
                        type: "ontology",
                        position: { x: pos.x, y: pos.y },
                        data: {
                          key: id,
                          iri: id,
                          rdfTypes: [],
                          literalProperties: [],
                          annotationProperties: [],
                          visible: true,
                          hasReasoningError: false,
                          namespace: "",
                          label: id,
                        } as NodeData,
                      };
                  if (prevNode) {
                    if ((prevNode as any).__rf) (mergedNode as any).__rf = (prevNode as any).__rf;
                    if ((prevNode as any).selected) (mergedNode as any).selected = true;
                  }
                  return mergedNode;
                })
              : [];
            // update positionsRef after successful merge
            try { positionsRef.current = newPosMap; } catch (_) { /* ignore */ }
            return merged;
          } catch (_) {
            // fallback to naive mapping (preserve safety)
            try { positionsRef.current = newPosMap; } catch (_) { /* ignore */ }
            return prev || [];
          }
        });
      } catch (_) {
        // ignore
      }
    },
    getNodePositions: () => {
      try {
        const snapshot: Record<string, { x: number; y: number }> = {};
        (nodes || []).forEach((n) => {
          try {
            snapshot[String(n.id)] = { x: (n.position && (n.position as any).x) || 0, y: (n.position && (n.position as any).y) || 0 };
          } catch (_) { /* ignore */ }
        });
        return snapshot;
      } catch (_) {
        return {};
      }
    },
  });
  const layoutManagerRef = useRef<LayoutManager | null>(new LayoutManager(diagramRef.current));

  // Keep refs to latest node/edge arrays so async callbacks (toolbar, load handlers) can
  // request layout using the most recent state rather than a stale closure.
  const nodesRef = useRef<RFNode<NodeData>[]>([]);
  const edgesRef = useRef<RFEdge<LinkData>[]>([]);
  // Track previous visible node count to detect the initial mapping after an autoload.
  const prevNodeCountRef = useRef<number>(0);

  // Layout guards & fingerprints to avoid re-entrant layout loops
  const layoutInProgressRef = useRef<boolean>(false);
  const lastLayoutFingerprintRef = useRef<string | null>(null);
  const positionsRef = useRef<Record<string, string>>({});
  // Dev helper: allow temporarily disabling blacklist during autoload so core vocabularies
  // (owl/rdf/rdfs) can be visible while debugging. This is intentionally a transient flag.
  const ignoreBlacklistRef = useRef<boolean>(false);

  useEffect(() => {
    nodesRef.current = nodes;
    try { prevNodeCountRef.current = Array.isArray(nodes) ? nodes.length : 0; } catch (_) { /* ignore */ }
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Apply layout helper (uses LayoutManager)
  const doLayout = useCallback(
    async (candidateNodes: RFNode<NodeData>[], candidateEdges: RFEdge<LinkData>[], force = false) => {
      try {
        // Debug: surface when layout is invoked (force flag and counts)
        try {
          console.debug('[VG] doLayout', {
            force: !!force,
            candidateNodeCount: Array.isArray(candidateNodes) ? candidateNodes.length : 0,
            candidateEdgeCount: Array.isArray(candidateEdges) ? candidateEdges.length : 0,
            layoutEnabled: !!layoutEnabled,
            autoApplyLayout: !!(config && config.autoApplyLayout),
          });
        } catch (_) { /* ignore debug failures */ }

        // If not forced, require both the local layout toggle and persisted autoApplyLayout to be enabled.
        if (!force && (!layoutEnabled || !(config && config.autoApplyLayout))) return;

        // Avoid overlapping layouts
        if (layoutInProgressRef.current) {
          if (!force) return;
          // If forced, we still do not run concurrently; skip to avoid re-entrancy.
          return;
        }

        const lm = layoutManagerRef.current;
        if (!lm) return;

        // Build a fingerprint of candidate nodes/edges (IDs + positions) to detect identical inputs.
        const fingerprintParts: string[] = [];
        try {
          for (const n of candidateNodes || []) {
            try {
              const id = String(n.id);
              const px = n.position ? Math.round((n.position as any).x) : 0;
              const py = n.position ? Math.round((n.position as any).y) : 0;
              fingerprintParts.push(`${id}|${px}|${py}`);
            } catch (_) { /* ignore per-node */ }
          }
          for (const e of candidateEdges || []) {
            try {
              fingerprintParts.push(`E:${String(e.id)}`);
            } catch (_) { /* ignore per-edge */ }
          }
        } catch (_) { /* ignore fingerprint build */ }
        const fingerprint = fingerprintParts.join(';');

        if (!force && lastLayoutFingerprintRef.current === fingerprint) {
          // Nothing changed since last layout -> skip
          return;
        }

        // Mark in-progress
        layoutInProgressRef.current = true;
        try {
          // Prepare lightweight nodes/edges for layout
          diagramRef.current.nodes = (candidateNodes || []).map((n) => ({ id: String(n.id), position: n.position, data: n.data }));
          diagramRef.current.edges = (candidateEdges || []).map((e) => ({ id: String(e.id), source: String(e.source), target: String(e.target), data: e.data }));
          // call layout manager with suggested layout type or config.currentLayout if present
          const layoutType = (config && (config.currentLayout)) || lm.suggestOptimalLayout();
          await lm.applyLayout(layoutType as any, { nodeSpacing: (config && (config.layoutSpacing as any)) || undefined });
        } catch (err) {
          try { console.warn('[VG] doLayout error', err); } catch (_) {}
        } finally {
          // update fingerprint after layout completes (positions applied via setNodePositions)
          try { lastLayoutFingerprintRef.current = fingerprint; } catch (_) {}
          layoutInProgressRef.current = false;
        }
      } catch (_) {
        // ignore outer failures
        layoutInProgressRef.current = false;
      }
    },
    [layoutEnabled, config],
  );

  // Removed nodes/edges-based debounce. Layout is triggered explicitly by mapping, viewMode changes,
  // or forced programmatic loads (onLoadFile/autoload). This avoids feedback loops where layout updates nodes
  // which retrigger layout.

  // Structural-change / view-mode triggered layout
  // - Layout runs when the node/edge set changes (structural change) OR when viewMode toggles,
  //   and only when autoApplyLayout is enabled (unless forced).
  // - runMapping still calls doLayout directly when mapping completes (force when loadTriggerRef set).
  const lastStructureFingerprintRef = useRef<string | null>(null);

  // Trigger layout on structural changes (node/edge additions/removals).
  useEffect(() => {
    try {
      const auto = !!(config && (config as any).autoApplyLayout);
      if (!auto) return;

      const nodeIds = (nodesRef.current || []).map((n) => String(n.id)).sort().join(',');
      const edgeIds = (edgesRef.current || []).map((e) => String(e.id)).sort().join(',');
      const structFp = `N:${nodeIds}|E:${edgeIds}`;

      if (lastStructureFingerprintRef.current !== structFp) {
        lastStructureFingerprintRef.current = structFp;
        try {
          // Trigger an immediate layout for structural changes (not debounced).
          void doLayout(nodesRef.current, edgesRef.current, false);
        } catch (_) { /* ignore layout scheduling */ }
      }
    } catch (_) { /* ignore fingerprint failures */ }
  // Depend on lengths so this runs when structure changes; positions changes won't retrigger unnecessarily.
  }, [nodes.length, edges.length, config && (config as any).autoApplyLayout, doLayout]);

  // Trigger layout when viewMode changes (if auto layout enabled)
  useEffect(() => {
    try {
      const auto = !!(config && (config as any).autoApplyLayout);
      if (!auto) return;
      try {
        void doLayout(nodesRef.current, edgesRef.current, false);
      } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
  }, [viewMode, config && (config as any).autoApplyLayout, doLayout]);

  // Toolbar callbacks
  const handleToggleLegend = useCallback(() => {
    const newValue = !showLegend;
    setShowLegendState(newValue);
    setShowLegend(newValue);
  }, [showLegend, setShowLegend]);

  const handleViewModeChange = useCallback(
    (mode: "abox" | "tbox") => {
      setViewMode(mode);
      setPersistedViewMode(mode);
    },
    [setPersistedViewMode, canvasActions],
  );

  // Export handler (reuses existing exportGraph)
  const handleExport = useCallback(
    async (format: "turtle" | "owl-xml" | "json-ld") => {
      try {
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
      } catch (e) {
        toast.error("Export failed");
        try {
          warn("reactflow.export.failed", {
            error: e && (e as Error).message ? (e as Error).message : String(e),
          });
        } catch (_) {
          /* ignore */
        }
      }
    },
    [exportGraph],
  );

  // File load handler
  const onLoadFile = useCallback(
    async (file: File | any) => {
      canvasActions.setLoading(true, 10, "Reading file...");
      try {
        let text: string;
        if (file.type === "url" || typeof file === "string" || file.url) {
          const url = file.url || file;
          canvasActions.setLoading(true, 10, "Fetching from URL...");
          const response = await fetch(url);
          if (!response.ok)
            throw new Error(`Failed to fetch: ${response.statusText}`);
          text = await response.text();
        } else {
          text = await file.text();
        }
        canvasActions.setLoading(true, 30, "Parsing RDF...");
        try {
          // mark that a programmatic load started so the next mapping pass knows to force a layout
          try { loadTriggerRef.current = true; } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }
        await loadKnowledgeGraph(text, {
          onProgress: (progress: number, message: string) => {
            canvasActions.setLoading(true, Math.max(progress, 30), message);
          },
        });
        toast.success("Knowledge graph loaded successfully");
        try {
          // Force layout after a short delay to ensure mapping (if any) has updated React state.
          // Some RDF manager implementations do not emit subject-change events synchronously,
          // so we attempt a forced layout using the latest refs as a fallback.
          setTimeout(() => {
            try {
              console.debug('[VG] onLoadFile: scheduled forced layout (refs)');
              void doLayout(nodesRef.current, edgesRef.current, true);
            } catch (_) { /* ignore */ }
          }, 300);
          // Also attempt an immediate forced layout as a best-effort (may be no-op if nodes not present yet).
          try {
            console.debug('[VG] onLoadFile: immediate forced layout attempt (refs)');
            void doLayout(nodesRef.current, edgesRef.current, true);
          } catch (_) { /* ignore */ }
        } catch (_) { /* ignore scheduling */ }
      } catch (e) {
        try {
          fallback(
            "reactflow.onLoadFile.failed",
            {
              error:
                e && (e as Error).message ? (e as Error).message : String(e),
            },
            { level: "warn" },
          );
        } catch (_) {
          /* ignore */
        }
        toast.error("Failed to load file");
      } finally {
        canvasActions.setLoading(false, 0, "");
      }
    },
    [loadKnowledgeGraph, canvasActions],
  );
  // Basic layout handler: computes deterministic positions and updates nodes.
  const handleLayoutChange = useCallback(
    async (layoutType: string, force = false, options?: { nodeSpacing?: number }) => {
      try {
        try {
          console.debug("[VG] handleLayoutChange invoked", { layoutType, force: !!force, options });
        } catch (_) { /* ignore debug */ }

        // Persist selected layout
        try {
          setCurrentLayout(String(layoutType || ""));
          setCurrentLayoutState(String(layoutType || ""));
        } catch (_) { /* ignore */ }

        // If caller provided spacing, persist it
        try {
          if (options && typeof options.nodeSpacing === "number") {
            useAppConfigStore.getState().setLayoutSpacing(Math.max(50, Math.min(500, options.nodeSpacing)));
          }
        } catch (_) { /* ignore */ }

        // Always attempt layout; allow doLayout to short-circuit when not appropriate unless forced.
        await doLayout(nodesRef.current, edgesRef.current, !!force);
      } catch (_) {
        /* ignore layout failures */
      }
    },
    [setCurrentLayout, setCurrentLayoutState, layoutEnabled, config.layoutSpacing, viewMode, doLayout, nodes, edges],
  );
  // React Flow init

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
    try {
      if (typeof window !== "undefined") (window as any).__VG_RF_INSTANCE = instance;
    } catch (_) {
      /* ignore test exposure failures */
    }
    if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug("[VG] KnowledgeCanvas onInit", { hasInstance: !!instance });
    }
  }, []);

  useEffect(() => {
    const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
    if (!mgr) return;

    let mounted = true;
    let debounceTimer: number | null = null;
    let subjectsCallback: ((subs?: string[] | undefined, quads?: any[] | undefined) => void) | null = null;

    // Accumulator for incremental quad updates emitted by rdfManager.
    let pendingQuads: any[] = [];

      // Use the centralized pure mapper directly and consult the predicate classifier so
      // annotation properties (owl:AnnotationProperty) are preserved as node annotations.
      const translateQuadsToDiagram = (quads: any[]) => {
        return mapQuadsToDiagram(quads, { predicateKind: predicateClassifier });
      };

    const runMapping = () => {
      if (!mounted) return;
      let diagram: any;
      // If there are no accumulated quads, do nothing
      if (!pendingQuads || pendingQuads.length === 0) {
        return;
      }

      // Partition incoming quads into data quads (eligible for canvas mapping)
      // and ontology quads (persisted into ontology graphs, which we should not
      // translate into canvas nodes). Ontology quads will update the fat map.
      const dataQuads: any[] = [];
      const ontologyQuads: any[] = [];

      const isOntologyGraph = (q: any) => {
        try {
          if (!q) return false;
          const g = q.graph;
          const graphVal = g ? (g.value || g.id || (typeof g === "string" ? g : undefined)) : undefined;
          if (typeof graphVal === "undefined") return false;
          const gstr = String(graphVal || "");
          if (!gstr) return false;
          if (gstr.includes("urn:vg:ontologies")) return true;
          if (/^https?:\/\/(www\.)?w3.org/i.test(gstr)) return true;
          return false;
        } catch (_) {
          return false;
        }
      };

      try {
        // Diagnostic: log sample count for debugging
        try {
          const sampleSubjects = Array.from(new Set((pendingQuads || []).map((q: any) => (q && q.subject && q.subject.value) || ""))).slice(0, 20);
          console.debug("[VG_DEBUG] KnowledgeCanvas.runMapping incrementalQuads", { total: (pendingQuads || []).length, subjectsSample: sampleSubjects });
        } catch (_) { /* ignore */ }

        for (const q of pendingQuads || []) {
          try {
            if (isOntologyGraph(q)) ontologyQuads.push(q);
            else dataQuads.push(q);
          } catch (_) {
            // conservative: treat as dataQuad on error
            dataQuads.push(q);
          }
        }

        // Clear accumulator now that we've partitioned
        pendingQuads = [];

        // Process ontology quads by reconciling into the ontology store (updates fat map)
        try {
          if (ontologyQuads.length > 0) {
            try {
              const os = useOntologyStore.getState();
              if (os && typeof os.reconcileQuads === "function") {
                try { os.reconcileQuads(ontologyQuads); } catch (_) { /* ignore per-call */ }
              }
            } catch (_) { /* ignore reconcile failures */ }
          }
        } catch (_) { /* ignore */ }

        // Map only data quads to diagram nodes/edges
        if (!dataQuads || dataQuads.length === 0) {
          // Nothing to map: keep existing canvas state (do not wipe)
          // Use an empty diagram to simplify downstream code paths.
          diagram = { nodes: [], edges: [] };
        } else {
          try {
            diagram = translateQuadsToDiagram(dataQuads);
          } catch (e) {
            try { console.error("[VG] KnowledgeCanvas: incremental quad mapping failed", e); } catch (_) {}
            diagram = { nodes: [], edges: [] };
          }
        }
      } catch (err) {
        try { console.error("[VG] KnowledgeCanvas: incremental quad partitioning failed", err); } catch (_) {}
        // ensure accumulator cleared on catastrophic failure
        try { pendingQuads = []; } catch (_) {}
        diagram = { nodes: [], edges: [] };
      }

      const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
      const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges) || [];
      try {
        console.debug('[VG] runMapping produced', { mappedNodeCount: Array.isArray(mappedNodes) ? mappedNodes.length : 0, mappedEdgeCount: Array.isArray(mappedEdges) ? mappedEdges.length : 0 });
      } catch (_) { /* ignore debug */ }

        // Enrich nodes and edges with display/palette information so first-render shows
        // type-driven colors and fat-map labels. computeTermDisplay is authoritative here.
        let enrichedNodes = mappedNodes;
        let enrichedEdges = mappedEdges;
      try {
        // Build quick lookup for availableProperties (fat map) to speed up per-edge resolution.
        const propMap = new Map<string, any>();
        try {
          if (Array.isArray(availableProperties)) {
            for (const p of availableProperties) {
              try {
                const iriKey = String((p && (p as any).iri) || "").trim();
                if (iriKey) propMap.set(iriKey, p);
              } catch (_) { /* ignore per-entry */ }
            }
          }
        } catch (_) { /* ignore propMap build */ }

        enrichedNodes = (mappedNodes || []).map((n) => {
          try {
            const primary =
              Array.isArray(n.data?.rdfTypes) && n.data.rdfTypes.find((t: any) => t && !/NamedIndividual/i.test(String(t))) ||
              n.data?.classType ||
              n.data?.displayType ||
              undefined;
            let td: any = undefined;
            try {
              if (primary && mgr) td = computeTermDisplay(String(primary), mgr as any, palette, { availableProperties, availableClasses });
            } catch (_) {
              td = undefined;
            }
            const paletteColor = td?.color || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
            const displayPrefixed = td?.prefixed || (td && td.label) || n.data?.displayPrefixed || (n.data && (n.data.label || n.data.classType)) || undefined;
            const displayShort = td?.short || n.data?.displayShort || undefined;
            const updatedData = { ...(n.data as NodeData), classType: (td && td.iri) || n.data?.classType, namespace: td?.namespace || n.data?.namespace, displayPrefixed, displayShort, typeNamespace: td?.namespace || n.data?.typeNamespace, paletteColor, label: n.data?.label || td?.label } as NodeData;
            return { ...n, data: updatedData } as RFNode<NodeData>;
          } catch (_) {
            return n;
          }
        });

        enrichedEdges = (mappedEdges || []).map((e) => {
          try {
            const pred = String((e && e.data && ((e.data as any).propertyUri || (e.data as any).propertyType || (e.data as any).predicate)) || "");
            let td: any = undefined;
            try {
              if (pred && mgr) td = computeTermDisplay(pred, mgr as any, palette, { availableProperties });
            } catch (_) {
              td = undefined;
            }
            const fromFat = propMap.get(pred);
            const labelFromProps = fromFat && fromFat.label ? String(fromFat.label) : undefined;
            const newLabel = labelFromProps || td?.label || td?.prefixed || td?.short || String(pred);
            const newColor = td?.color || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
            const updatedEdgeData = { ...(e.data as LinkData), label: newLabel, paletteColor: newColor } as LinkData;
            return { ...e, data: updatedEdgeData } as RFEdge<LinkData>;
          } catch (_) {
            return e;
          }
        });
      } catch (_) {
        // if enrichment fails, fall back to the raw mapped arrays
        enrichedNodes = mappedNodes;
        enrichedEdges = mappedEdges;
      }

      // Apply blacklist filtering so reserved/core RDF terms are not rendered as nodes.
      try {
        if (!ignoreBlacklistRef.current) {
          enrichedNodes = (enrichedNodes || []).filter((n) => {
            try {
              const iri = (n && n.data && (n.data.iri || n.id)) ? String((n.data && (n.data.iri || n.id))) : "";
              return !isBlacklistedIri(iri);
            } catch (_) {
              return true;
            }
          });
        } else {
          // Dev mode: blacklist is temporarily disabled — keep all nodes.
          try { console.debug("[VG] Ignoring blacklist for this autoload/mapping pass"); } catch (_) {}
        }
      } catch (_) {
        // ignore blacklist filter failures
      }

      // If this is the first meaningful mapping after mount / autoload (previous node count was 0)
      // and we have nodes now, attempt a forced layout so autoloads reposition nodes automatically.
      let forceLayoutDueToAutoload = false;
      try {
        const prevCount = typeof prevNodeCountRef !== "undefined" ? prevNodeCountRef.current : 0;
        const hasNewNodes = Array.isArray(mappedNodes) && mappedNodes.length > 0;
        if (!loadTriggerRef.current && prevCount === 0 && hasNewNodes) {
          forceLayoutDueToAutoload = true;
          // mark loadTrigger so repeated mapping passes don't repeatedly force layout
          try { loadTriggerRef.current = true; } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }

      // Merge positions and runtime flags from current nodes state using upsert semantics
      // (preserve existing nodes not mentioned in this incremental mapping).
      setNodes((prev) => {
        try {
          const byId = new Map<string, RFNode<NodeData>>();
          // seed with previous nodes so we preserve any nodes not present in this pass
          (prev || []).forEach((n) => {
            try { byId.set(String(n.id), n); } catch (_) { /* ignore */ }
          });

          // Upsert enriched nodes: update existing entries or add new ones.
          for (const m of (enrichedNodes || [])) {
            try {
              const id = String(m.id);
              const existing = byId.get(id);
              if (existing) {
                // preserve runtime flags & previous position if present
                const mergedNode: RFNode<NodeData> = {
                  ...existing,
                  ...m,
                  position: existing.position || m.position || { x: 0, y: 0 },
                } as RFNode<NodeData>;
                if ((existing as any).__rf) (mergedNode as any).__rf = (existing as any).__rf;
                if ((existing as any).selected) (mergedNode as any).selected = true;
                byId.set(id, mergedNode);
              } else {
                // Ensure newly-added nodes always have a position (React Flow requires it).
                const nodeToSet = (m && (m as any).position) ? m : { ...m, position: { x: 0, y: 0 } };
                byId.set(id, nodeToSet);
              }
            } catch (_) {
              try {
                const fallbackNode = (m && (m as any).position) ? m : { ...(m || {}), position: { x: 0, y: 0 } };
                byId.set(String((m as any).id || ""), fallbackNode);
              } catch (_) { /* ignore per-item */ }
            }
          }

          return Array.from(byId.values()).filter(Boolean) as RFNode<NodeData>[];
        } catch (e) {
          try { console.warn("[VG] KnowledgeCanvas: upsert merge failed, falling back to previous nodes", e); } catch (_) {}
          return prev || [];
        }
      });

      // Replace/update edges: remove edges whose source is an updated node in this pass,
      // then add the newly mapped edges. Dedupe by edge id to avoid duplicates.
      setEdges((prev) => {
        try {
          const mappedIds = new Set<string>((enrichedNodes || []).map((n) => String(n.id)));
          // If there are no previous edges, just return enrichedEdges (no-op merge)
          if (!Array.isArray(prev) || prev.length === 0) {
            // dedupe enrichedEdges by id before returning
            const byId = new Map<string, RFEdge<LinkData>>();
            for (const e of enrichedEdges || []) {
              try { byId.set(String(e.id), e); } catch (_) { /* ignore per-edge */ }
            }
            return Array.from(byId.values());
          }

          // Keep edges whose source is NOT one of the updated nodes.
          // This preserves incoming edges (where updated node is the target).
          const kept: RFEdge<LinkData>[] = [];
          for (const e of prev || []) {
            try {
              const s = String(e.source);
              if (!mappedIds.has(s)) {
                kept.push(e);
              }
            } catch (_) { /* ignore per-edge */ }
          }

          // Merge: start with kept edges, then add enrichedEdges (new edges replace old ones by id)
          const byId = new Map<string, RFEdge<LinkData>>();
          for (const e of kept) {
            try { byId.set(String(e.id), e); } catch (_) { /* ignore per-edge */ }
          }
          for (const e of enrichedEdges || []) {
            try { byId.set(String(e.id), e); } catch (_) { /* ignore per-edge */ }
          }

          const result = Array.from(byId.values());

          // If nothing changed structurally, return prev to avoid unnecessary state updates.
          try {
            if (
              prev.length === result.length &&
              prev.every((p, idx) => p.id === result[idx].id && p.source === result[idx].source && p.target === result[idx].target)
            ) {
              return prev;
            }
          } catch (_) { /* ignore compare errors */ }

          return result;
        } catch (_) {
          // On error, fall back to replacing with enrichedEdges
          const byId = new Map<string, RFEdge<LinkData>>();
          for (const e of enrichedEdges || []) {
            try { byId.set(String(e.id), e); } catch (_) { /* ignore */ }
          }
          return Array.from(byId.values());
        }
      });

      // Trigger layout (async) only when structure changed or when a programmatic load forced it.
      // Compute a structural fingerprint (node ids + edge ids) and compare with lastStructureFingerprintRef.
      try {
        try {
          const nodeIds = (Array.isArray(mappedNodes) ? mappedNodes.map((n) => String(n.id)) : []).sort().join(',');
          const edgeIds = (Array.isArray(mappedEdges) ? mappedEdges.map((e) => String(e.id)) : []).sort().join(',');
          const newStructFp = `N:${nodeIds}|E:${edgeIds}`;

          const forced = !!loadTriggerRef.current;
          if (forced) {
            try { loadTriggerRef.current = false; } catch (_) { /* ignore */ }
          }

          // If structure changed OR this was a forced load, run layout. Otherwise skip.
          if (forced || lastStructureFingerprintRef.current !== newStructFp) {
            lastStructureFingerprintRef.current = newStructFp;
            try {
              void doLayout(mappedNodes, mappedEdges, !!forced);
            } catch (_) { /* ignore scheduled layout errors */ }
          }
        } catch (_) {
          // fallback: best-effort direct layout if fingerprinting fails
          try { void doLayout(mappedNodes, mappedEdges, !!loadTriggerRef.current); } catch (_) { /* ignore */ }
          try { loadTriggerRef.current = false; } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    };

    // Initial run: do nothing (we rely on emitted quads only)
    if (!initialMapRef.current) {
      // If initial map desired, we could request a full dataset emission from RDF manager.
      // Per instructions we avoid store lookups here.
      // runMapping();
    } else {
      initialMapRef.current = false;
    }

    // Subscribe to RDF manager change notifications (will pass quads as second arg)
    try {
      // scheduleRunMapping will coalesce bursts of RDF notifications into a single mapping pass.
      const scheduleRunMapping = () => {
        try {
          if (debounceTimer) {
            try { window.clearTimeout(debounceTimer); } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
        try {
          debounceTimer = window.setTimeout(() => {
            try {
              runMapping();
            } catch (_) { /* ignore */ }
            try { debounceTimer = null; } catch (_) { /* ignore */ }
          }, 100);
        } catch (_) { /* ignore */ }
      };

      // subjectsCallback expects (subjects, quads). We rely only on quads.
      subjectsCallback = (subs?: string[] | undefined, quads?: any[] | undefined) => {
        try {
          if (Array.isArray(quads) && quads.length > 0) {
            for (const q of quads) {
              try {
                if (q) pendingQuads.push(q);
              } catch (_) { /* ignore per-quad */ }
            }
          }
        } catch (_) { /* ignore accumulation errors */ }
        try { scheduleRunMapping(); } catch (_) { /* ignore */ }
      };

      if (typeof mgr.onSubjectsChange === "function" && subjectsCallback) {
        try { mgr.onSubjectsChange(subjectsCallback as any); } catch (_) { /* ignore */ }
      }

      // Subscribe to manager-level changes (namespaces/palette etc.) so we can re-enrich node/edge
      // display fields when prefixes or global RDF state change. We intentionally keep this
      // debounced & targeted to avoid full-store rebuilds on every minor change.
      try {
        if (typeof mgr.onChange === "function") {
          const mgrChangeHandler = (countOrMeta?: any, meta?: any) => {
            try {
              const payload = (meta && typeof meta === "object") ? meta : (countOrMeta && typeof countOrMeta === "object" ? countOrMeta : undefined);

              // If this is a namespaces change we may receive { kind: 'namespaces', prefixes: [...] }
              const isNsChange = payload && payload.kind === "namespaces";
              const changedPrefixes: string[] = isNsChange && Array.isArray(payload.prefixes) ? payload.prefixes.slice() : [];

              // Fast path: re-enrich visible nodes/edges immediately using current palette
              try {
                setNodes((prev) => {
                  try {
                    return (prev || []).map((n) => {
                      try {
                        const primary =
                          Array.isArray(n.data?.rdfTypes) && n.data.rdfTypes.find((t: any) => t && !/NamedIndividual/i.test(String(t))) ||
                          n.data?.classType ||
                          n.data?.displayType ||
                          undefined;
                        let td;
                        try {
                          if (primary && mgr) td = computeTermDisplay(String(primary), mgr as any, palette);
                        } catch (_) {
                          td = undefined;
                        }
                        const newColor = (td && td.color) || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
                        if (String(n.data?.paletteColor || "") !== String(newColor || "")) {
                          const updatedData = { ...(n.data as NodeData), paletteColor: newColor, displayPrefixed: td?.prefixed || n.data?.displayPrefixed, displayShort: td?.short || n.data?.displayShort } as NodeData;
                          return { ...n, data: updatedData } as RFNode<NodeData>;
                        }
                      } catch (_) { /* ignore per-node */ }
                      return n;
                    });
                  } catch (_) {
                    return prev || [];
                  }
                });
              } catch (_) { /* ignore visible update failures */ }

              // Targeted background pass: if payload lists prefixes, update nodes/edges that reference them.
              // Schedule a debounced targeted update to avoid bursts.
              try {
                if (isNsChange && changedPrefixes.length > 0) {
                  // Debounce using window timeout stored on manager object (best-effort)
                  try {
                    const schedule = () => {
                      try {
                        setTimeout(() => {
                          try {
                            // Update nodes that reference the changed prefixes
                            setNodes((prev) => {
                              try {
                                return (prev || []).map((n) => {
                                  try {
                                    const dp = String(n.data?.displayPrefixed || "");
                                    const ns = String(n.data?.typeNamespace || "");
                                    const matches = dp && changedPrefixes.some((p) => dp.startsWith(p + ":")) || ns && changedPrefixes.includes(ns);
                                    if (matches) {
                                      const primary =
                                        Array.isArray(n.data?.rdfTypes) && n.data.rdfTypes.find((t: any) => t && !/NamedIndividual/i.test(String(t))) ||
                                        n.data?.classType ||
                                        n.data?.displayType ||
                                        undefined;
                                      let td;
                                      try { if (primary && mgr) td = computeTermDisplay(String(primary), mgr as any, palette); } catch (_) { td = undefined; }
                                      const newColor = (td && td.color) || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
                                      if (String(n.data?.paletteColor || "") !== String(newColor || "")) {
                                        const updatedData = { ...(n.data as NodeData), paletteColor: newColor, displayPrefixed: td?.prefixed || n.data?.displayPrefixed, displayShort: td?.short || n.data?.displayShort } as NodeData;
                                        return { ...n, data: updatedData } as RFNode<NodeData>;
                                      }
                                    }
                                  } catch (_) { /* ignore per-node */ }
                                  return n;
                                });
                              } catch (_) { return prev || []; }
                            });

                            // Update edges similarly (labels/colors)
                            setEdges((prev) => {
                              try {
                                const props = Array.isArray(availableProperties) ? availableProperties : [];
                                return (prev || []).map((e) => {
                                  try {
                                    const pred = String((e && e.data && (e.data.propertyUri || e.data.propertyType)) || "");
                                    const td = (mgr && pred) ? computeTermDisplay(pred, mgr as any, palette) : undefined;
                                    const labelFromProps = props.find((p: any) => String(p.iri) === pred)?.label;
                                    const newLabel = labelFromProps || (td ? (td.prefixed || td.short || String(pred)) : String(pred));
                                    const newColor = (td && td.color) || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
                                    if (String(e.data?.label || "") !== String(newLabel || "") || String(e.data?.paletteColor || "") !== String(newColor || "")) {
                                      const updatedEdgeData = { ...(e.data as LinkData), label: newLabel, paletteColor: newColor } as LinkData;
                                      return { ...e, data: updatedEdgeData } as RFEdge<LinkData>;
                                    }
                                  } catch (_) { /* ignore per-edge */ }
                                  return e;
                                });
                              } catch (_) { return prev || []; }
                            });
                          } catch (_) { /* ignore scheduled update errors */ }
                        }, 120);
                      } catch (_) { /* ignore schedule errors */ }
                    };
                    schedule();
                  } catch (_) { /* ignore debounce errors */ }
                }
              } catch (_) { /* ignore targeted update errors */ }
            } catch (_) { /* ignore overall handler errors */ }
          };

          try { mgr.onChange(mgrChangeHandler); } catch (_) { /* ignore subscribe errors */ }

          // ensure we remove onChange during cleanup -- stored on local variable via closure
          (subjectsCallback as any).__mgrChangeHandler = mgrChangeHandler;
        }
      } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }

    // Cleanup
    return () => {
      mounted = false;
      try {
        if (debounceTimer) {
          try { window.clearTimeout(debounceTimer); } catch (_) { /* ignore */ }
          debounceTimer = null;
        }
      } catch (_) { /* ignore */ }
      try {
        if (typeof mgr.offSubjectsChange === "function" && subjectsCallback) {
          try { mgr.offSubjectsChange(subjectsCallback as any); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    };
  }, [getRdfManager, setNodes, setEdges]);

  // Expose a ready flag for integration tests / tooling
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;
    return () => {
      try { delete (window as any).__VG_KNOWLEDGE_CANVAS_READY; } catch (_) { void 0; }
    };
  }, []);
  
  // Autoloading is now handled explicitly by the app initializer (__VG_INIT_APP).
  // The mount-time automatic autoload was removed to avoid race conditions with startup data loads.
  // If you relied on automatic autoload previously, call window.__VG_INIT_APP() to trigger autoload explicitly.
  // Expose a small initializer to mirror ReactFlowCanvas behavior for tests/dev tooling.
  // This initializer now handles explicit autoloading of configured ontologies,
  // then loads any startup RDF URL. Autoload is no longer performed automatically on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__VG_INIT_APP = async (opts?: { force?: boolean }) => {
      try {
        // Mark that the initializer executed so tests and diagnostics can observe autoload runs.
        try { (window as any).__VG_INIT_APP_RAN = true; } catch (_) { /* ignore */ }

        const cfg =
          (useAppConfigStore as any).getState
            ? (useAppConfigStore as any).getState().config
            : config;
        const additional = Array.isArray(cfg?.additionalOntologies)
          ? cfg.additionalOntologies.filter(Boolean)
          : [];

        // Pull startup URL from query string (support legacy 'url' param used in tests)
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

        // 1) Load configured ontologies first (if any)
        if (additional && additional.length > 0 && typeof loadAdditionalOntologies === "function") {
          try {
            canvasActions.setLoading(true, 5, "Loading configured ontologies...");
          } catch (_) {}
          try {
            await loadAdditionalOntologies(additional, (progress: number, message: string) => {
              try {
                canvasActions.setLoading(true, Math.max(progress * 0.5, 5), message);
              } catch (_) { /* ignore */ }
            });
            try { toast.success("Configured ontologies loaded"); } catch (_) {}
            // slight delay before re-enabling blacklist to allow debug visibility in dev
            try { setTimeout(() => { try { ignoreBlacklistRef.current = false; } catch (_) {} }, 3000); } catch (_) {}
          } catch (e) {
            try { toast.error("Failed to autoload configured ontologies"); } catch (_) {}
            try { console.warn("[VG] autoload configured ontologies failed", e); } catch (_) {}
          } finally {
            try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
          }
        }

        // 2) Now load startup RDF (if present)
        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          try {
            canvasActions.setLoading(true, 50, "Loading startup file...");
          } catch (_) {}
          try {
            await loadKnowledgeGraph(startupUrl, {
              onProgress: (progress: number, message: string) => {
                try {
                  canvasActions.setLoading(true, Math.max(progress * 0.5 + 50, 50), message);
                } catch (_) { /* ignore */ }
              },
            });
            try { toast.success("Startup knowledge graph loaded"); } catch (_) {}
            try { loadTriggerRef.current = true; } catch (_) {}
          } catch (e) {
            try { toast.error("Failed to load startup graph"); } catch (_) {}
            try { console.warn("[VG] loadKnowledgeGraph(startupUrl) failed", e); } catch (_) {}
          } finally {
            try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
          }
        }
      } catch (e) {
        try { console.warn("[VG] __VG_INIT_APP in KnowledgeCanvas failed", e); } catch (_) { void 0; }
      }
    };

    // Auto-run the initializer so configured ontologies are always autoloaded on mount.
    try {
      if (typeof (window as any).__VG_INIT_APP === "function") {
        (window as any).__VG_INIT_APP({ force: true });
      }
    } catch (_) { /* ignore */ }
    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) { void 0; }
    };
  }, [loadKnowledgeGraph]);

  // Fallback: when the ontology store registers new loaded ontologies we may not
  // always receive subject-change events from the RDF manager. As a robust
  // fallback, watch loadedOntologies / ontologiesVersion and run a one-off
  // mapping pass from the RDF store contents so the canvas always reflects
  // autoloaded ontologies.
  useEffect(() => {
    try {
      const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
      if (!mgr || typeof mgr.getStore !== "function") return;

      (async () => {
        try {
          // Read all quads from the store and run the same mapping/enrichment pipeline
          // used by the subject-level handler. This is best-effort and will not replace
          // the incremental subject-based flow, but guarantees visibility after autoload.
          const store = mgr.getStore();
          const quads = (store && typeof store.getQuads === "function") ? store.getQuads(null, null, null, null) : [];
          if (!Array.isArray(quads) || quads.length === 0) return;

          let diagram;
          try {
            diagram = mapQuadsToDiagram(quads, { predicateKind: predicateClassifier });
          } catch (_) {
            diagram = { nodes: [], edges: [] };
          }
          const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
          const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges) || [];

          // Enrich nodes/edges similar to runMapping
          let enrichedNodes = mappedNodes;
          let enrichedEdges = mappedEdges;
          try {
            const propMap = new Map<string, any>();
            try {
              if (Array.isArray(availableProperties)) {
                for (const p of availableProperties) {
                  try {
                    const iriKey = String((p && (p as any).iri) || "").trim();
                    if (iriKey) propMap.set(iriKey, p);
                  } catch (_) { /* ignore per-entry */ }
                }
              }
            } catch (_) { /* ignore */ }

            enrichedNodes = (mappedNodes || []).map((n) => {
              try {
                const primary =
                  Array.isArray(n.data?.rdfTypes) && n.data.rdfTypes.find((t: any) => t && !/NamedIndividual/i.test(String(t))) ||
                  n.data?.classType ||
                  n.data?.displayType ||
                  undefined;
                let td: any = undefined;
                try {
                  if (primary && mgr) td = computeTermDisplay(String(primary), mgr as any, palette, { availableProperties, availableClasses });
                } catch (_) {
                  td = undefined;
                }
                const paletteColor = td?.color || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
                const displayPrefixed = td?.prefixed || (td && td.label) || n.data?.displayPrefixed || (n.data && (n.data.label || n.data.classType)) || undefined;
                const displayShort = td?.short || n.data?.displayShort || undefined;
                const updatedData = { ...(n.data as NodeData), classType: (td && td.iri) || n.data?.classType, namespace: td?.namespace || n.data?.namespace, displayPrefixed, displayShort, typeNamespace: td?.namespace || n.data?.typeNamespace, paletteColor, label: n.data?.label || td?.label } as NodeData;
                return { ...n, data: updatedData } as RFNode<NodeData>;
              } catch (_) {
                return n;
              }
            });

            enrichedEdges = (mappedEdges || []).map((e) => {
              try {
                const pred = String((e && e.data && ((e.data as any).propertyUri || (e.data as any).propertyType || (e.data as any).predicate)) || "");
                let td: any = undefined;
                try {
                  if (pred && mgr) td = computeTermDisplay(pred, mgr as any, palette, { availableProperties });
                } catch (_) {
                  td = undefined;
                }
                const fromFat = propMap.get(pred);
                const labelFromProps = fromFat && fromFat.label ? String(fromFat.label) : undefined;
                const newLabel = labelFromProps || td?.label || td?.prefixed || td?.short || String(pred);
                const newColor = td?.color || (td && td.namespace && palette ? (palette as any)[td.namespace] : undefined);
                const updatedEdgeData = { ...(e.data as LinkData), label: newLabel, paletteColor: newColor } as LinkData;
                return { ...e, data: updatedEdgeData } as RFEdge<LinkData>;
              } catch (_) {
                return e;
              }
            });
          } catch (_) {
            enrichedNodes = mappedNodes;
            enrichedEdges = mappedEdges;
          }

          // Merge positions/runtime flags conservatively (preserve previous positions)
          setNodes((prev) => {
            try {
              const prevById = new Map<string, RFNode<NodeData>>();
              (prev || []).forEach((n) => prevById.set(String(n.id), n));
              const merged = enrichedNodes.map((m) => {
                const prevNode = prevById.get(String(m.id));
                try {
                  // Preserve previous position if present; otherwise ensure a default position so React Flow doesn't crash.
                  m.position = (prevNode && (prevNode.position as any)) || (m && (m as any).position) || { x: 0, y: 0 };
                  if (prevNode) {
                    if ((prevNode as any).__rf) (m as any).__rf = (prevNode as any).__rf;
                    if ((prevNode as any).selected) (m as any).selected = true;
                  }
                } catch (_) {
                  // best-effort: ensure position exists
                  try { m.position = m && (m as any).position ? (m as any).position : { x: 0, y: 0 }; } catch (_) { /* ignore */ }
                }
                return m;
              });
              return merged;
            } catch (_) {
              return mappedNodes;
            }
          });

          setEdges((prev) => {
            try {
              if (
                Array.isArray(prev) &&
                prev.length === enrichedEdges.length &&
                prev.every((p, idx) => p.id === enrichedEdges[idx].id && p.source === enrichedEdges[idx].source && p.target === enrichedEdges[idx].target)
              ) {
                return prev;
              }
            } catch (_) { /* fall through */ }
            return enrichedEdges;
          });

          // Force layout once after this fallback mapping so autoloaded ontologies are visible.
          try {
            loadTriggerRef.current = true;
          } catch (_) {}
          try {
            const nodeIds = (Array.isArray(mappedNodes) ? mappedNodes.map((n) => String(n.id)) : []).sort().join(',');
            const edgeIds = (Array.isArray(mappedEdges) ? mappedEdges.map((e) => String(e.id)) : []).sort().join(',');
            const newStructFp = `N:${nodeIds}|E:${edgeIds}`;
            if (lastStructureFingerprintRef.current !== newStructFp) {
              lastStructureFingerprintRef.current = newStructFp;
              try { void doLayout(mappedNodes, mappedEdges, true); } catch (_) {}
            }
          } catch (_) { /* ignore layout scheduling */ }
        } catch (_) {
          /* ignore overall fallback errors */
        }
      })();
    } catch (_) { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedOntologies, ontologiesVersion]);

  // Simple debug counters
  const displayedNodesCount = useMemo(() => (nodes || []).length, [nodes]);
  const displayedEdgesCount = useMemo(() => (edges || []).length, [edges]);

  // Minimal ABox/TBox visibility filter using React Flow native hidden flags.
  // We update node.hidden / edge.hidden so React Flow preserves node identity and internals.
  useEffect(() => {
    try {
      const nodeHiddenById = new Map<string, boolean>();

      // Update nodes' hidden flag according to viewMode and explicit visible flag
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

      // Update edges' hidden flag when either endpoint is hidden or endpoints disagree on domain
      setEdges((prev) =>
        (prev || []).map((e) => {
          try {
            const s = String(e.source);
            const t = String(e.target);
            const sHidden = nodeHiddenById.get(s) || false;
            const tHidden = nodeHiddenById.get(t) || false;

            // If either endpoint is hidden, hide the edge.
            let hidden = !!sHidden || !!tHidden;

            // Additionally, if both endpoints present, hide if their isTBox flags differ or don't match viewMode.
            if (!hidden) {
              try {
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
              } catch (_) {
                hidden = !!hidden;
              }
            }

            return hidden === !!(e as any).hidden ? e : { ...e, hidden };
          } catch (_) {
            return e;
          }
        }),
      );
    } catch (_) {
      /* ignore visibility sync failures */
    }
  }, [viewMode, nodes.length, edges.length, setNodes, setEdges]);

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
      <CanvasToolbar
        onAddNode={(payload: any) => {
          try {
            // Minimal add-node implementation: accept either an object with .iri or a plain string.
            let normalizedUri = String(payload && (payload.iri || payload) ? (payload.iri || payload) : "");
            try {
              if (!/^https?:\/\//i.test(normalizedUri)) {
                const mgr = typeof getRdfManager === "function" ? getRdfManager() : undefined;
                if (mgr && typeof (mgr as any).expandPrefix === "function") {
                  try {
                    const expanded = (mgr as any).expandPrefix(normalizedUri);
                    if (expanded && typeof expanded === "string") normalizedUri = expanded;
                  } catch (_) { /* ignore expansion failures */ }
                }
              }
            } catch (_) { /* ignore */ }

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
          } catch (_) {
            /* ignore add failures */
          }
        }}
        onToggleLegend={handleToggleLegend}
        showLegend={showLegend}
        onExport={handleExport}
        onLoadFile={onLoadFile}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onLayoutChange={handleLayoutChange}
        currentLayout={currentLayout}
        // pass layoutEnabled state and setter so the toolbar toggle is wired to canvas state
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
    </div>
  );
};

export default KnowledgeCanvas;
