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
let NodePropertyEditor: any = () => null;
try {
  // Resolve NodePropertyEditor at module load time using CommonJS require so vitest's vi.mock
  // can provide either a default export or a named export. Doing this at module scope ensures
  // the mocked module is observed when tests call vi.mock before importing KnowledgeCanvas.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
  const _mod = (require as any)("./NodePropertyEditor");
  NodePropertyEditor = (_mod && (_mod.NodePropertyEditor || _mod.default)) || (() => null);
} catch (_) {
  NodePropertyEditor = () => null;
}
let LinkPropertyEditor: any = () => null;
try {
  // Resolve LinkPropertyEditor at module load time using CommonJS require so vitest's vi.mock
  // can provide either a default export or a named export. This mirrors the handling done for NodePropertyEditor.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
  const _linkMod = (require as any)("./LinkPropertyEditor");
  LinkPropertyEditor = (_linkMod && (_linkMod.LinkPropertyEditor || _linkMod.default)) || (() => null);
} catch (_) {
  LinkPropertyEditor = () => null;
}
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
    const mod = (require as any)("./NodePropertyEditor");
    NodePropertyEditor = (mod && (mod.NodePropertyEditor || mod.default)) || (() => null);
  } catch (_) {
    NodePropertyEditor = () => null;
  }
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


  // Debug local visibility changes so we can confirm whether local state flips when events fire.

  // Expose namedNode factory for synchronous store queries in the local classifier.
  // termForIri helper (handles blank nodes like "_:b0")
  const termForIri = (iri: string) => {
    try {
      if (typeof iri === "string" && iri.startsWith("_:")) {
        return DataFactory.blankNode(iri.slice(2));
      }
    } catch (_) {
      /* ignore */
    }
    return namedNode(String(iri));
  };

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

  // Snapshot of availableProperties passed into the pure mapper to avoid races.
  // Use ontologiesVersion so snapshot updates when the fat-map changes.
  const availablePropertiesSnapshot = useMemo(() => {
    try {
      return Array.isArray(availableProperties) ? (availableProperties as any[]).slice() : [];
    } catch (_) {
      return [];
    }
  }, [availableProperties, ontologiesVersion]);

  const initialMapRef = useRef(true);
  // When a programmatic "load" occurs we mark this ref so the next mapping pass can
  // perform a forced layout once the updated nodes/edges are available.
  const loadTriggerRef = useRef(false);
  // When a programmatic load requests a fit-to-view after mapping/layout, this ref is set.
  const loadFitRef = useRef(false);

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
              ? positioned
                  .map((p) => {
                    const id = String(p && (p.id || p.key || (p.data && (p.data.key || p.data.id))) || "");
                    if (!id) return null;
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
                  .filter((x): x is RFNode<NodeData> => x !== null)
              : [];
            // update positionsRef after successful merge
            try { positionsRef.current = newPosMap; } catch (_) { /* ignore */ }
            return merged as RFNode<NodeData>[];
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
  const lastStructureFingerprintRef = useRef<string | null>(null);
  const positionsRef = useRef<Record<string, string>>({});
  // Dev helper: allow temporarily disabling blacklist during autoload so core vocabularies
  // (owl/rdf/rdfs) can be visible while debugging. This is intentionally a transient flag.
  const ignoreBlacklistRef = useRef<boolean>(false);

  // Interaction refs for editors and connect flow
  const linkSourceRef = useRef<NodeData | null>(null);
  const linkTargetRef = useRef<NodeData | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const getRdfManagerRef = useRef(getRdfManager);

  useEffect(() => {
    nodesRef.current = nodes;
    try { prevNodeCountRef.current = Array.isArray(nodes) ? nodes.length : 0; } catch (_) { /* ignore */ }
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Ensure React Flow instance internal node list stays in sync immediately after state updates.
  // Some tests (and integration code) read window.__VG_RF_INSTANCE.getNodes() directly and expect
  // it to reflect the latest nodes without waiting for another render tick. Calling the instance
  // setNodes method defensively here keeps the instance consistent with state.
  useEffect(() => {
    try {
      const inst = reactFlowInstance.current;
      if (inst && typeof inst.setNodes === "function") {
        try {
          inst.setNodes(nodes || []);
        } catch (_) {
          // ignore instance sync failures
        }
      }
    } catch (_) {
      // ignore overall sync errors
    }
  }, [nodes]);

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

  // Trigger layout on structural changes (node/edge additions/removals).
  useEffect(() => {
    try {
      const auto = !!(config && (config as any).autoApplyLayout);
      if (!auto) return;

      const nodeIds = (nodesRef.current || []).map((n) => String(n.id)).sort().join(',');
      const edgeIds = (edgesRef.current || []).map((e) => String(e.id)).sort().join(',');
      const structFp = `N:${nodeIds}|E:${edgeIds}`;

      if (lastLayoutFingerprintRef.current !== structFp) {
        lastLayoutFingerprintRef.current = structFp;
        try {
          // Trigger an immediate layout for structural changes (not debounced).
          void doLayout(nodesRef.current, edgesRef.current, false);
        } catch (_) { /* ignore layout scheduling */ }
      }
    } catch (_) { /* ignore fingerprint failures */ }
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
          console.warn("knowledgecanvas.export.failed", {
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
          try { loadFitRef.current = true; } catch (_) { /* ignore */ }
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
    [loadKnowledgeGraph, canvasActions, doLayout],
  );
  // Basic layout handler: computes deterministic positions and updates nodes.
  const handleLayoutChange = useCallback(
    async (layoutType: string, force = false, options?: { nodeSpacing?: number }) => {
      try {
        try {
          console.debug("[VG] handleLayoutChange invoked", { layoutType, force: !!force, options });
        } catch (_) { /* ignore */ }

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
    const pendingQuads: any[] = [];

      // Use the centralized pure mapper directly and consult the predicate classifier so
      // annotation properties (owl:AnnotationProperty) are preserved as node annotations.
      const translateQuadsToDiagram = (quads: any[]) => {
        return mapQuadsToDiagram(quads, { predicateKind: predicateClassifier, availableProperties: availablePropertiesSnapshot });
      };

    const runMapping = async () => {
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
          return false;
        } catch (_) {
          return false;
        }
      };

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
      
      const mappedNodes: RFNode<NodeData>[] = (diagram && diagram.nodes) || [];
      const mappedEdges: RFEdge<LinkData>[] = (diagram && diagram.edges) || [];
      try {
        console.debug('[VG] runMapping produced', { mappedNodeCount: Array.isArray(mappedNodes) ? mappedNodes.length : 0, mappedEdgeCount: Array.isArray(mappedEdges) ? mappedEdges.length : 0 });
      } catch (_) { /* ignore debug */ }

      let enrichedNodes = mappedNodes;
      const enrichedEdges = mappedEdges;

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

      // Replace node.data wholesale for mapped nodes while preserving position & runtime flags.
      // Preserve any previous nodes that are not part of this mapping batch.
      // Ensure enrichedNodes have positions to avoid React Flow runtime errors (position.x/y undefined).
      try {
        const missing = (enrichedNodes || []).filter((n) => {
          try {
            return !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number";
          } catch (_) {
            return true;
          }
        });
        if (missing.length > 0) {
          try {
            console.debug("[VG] runMapping - defaulting positions for nodes missing position", { count: missing.length, sampleIds: missing.slice(0, 10).map((x) => String(x.id)) });
          } catch (_) { /* ignore logging failures */ }
        }
        enrichedNodes = (enrichedNodes || []).map((n) => {
          try {
            if (!n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number") {
              try { (n as any).position = { x: 0, y: 0 }; } catch (_) {}
              try { (n.data as any) = { ...(n.data as any), __needsInitialLayout: true }; } catch (_) {}
            }
          } catch (_) { /* ignore per-node */ }
          return n;
        });
      } catch (_) { /* ignore overall */ }

      setNodes((prev) => {
        try {
          const prevById = new Map<string, RFNode<NodeData>>();
          (prev || []).forEach((n) => {
            try { prevById.set(String(n.id), n); } catch (_) {}
          });

          // Start result map with all previous nodes preserved.
          const resultById = new Map<string, RFNode<NodeData>>(prevById);

          // For each mapped/enriched node, replace node.data while preserving position and runtime flags.
          for (const m of (enrichedNodes || [])) {
            try {
              const id = String((m && m.id) || "");
              if (!id) continue;
              const existing = prevById.get(id);
              if (existing) {
                // Replace data completely, but keep position & runtime flags.
                const replaced: RFNode<NodeData> = {
                  ...existing,
                  // keep existing top-level fields (position, selected, hidden, __rf)
                  position: existing.position,
                  id: existing.id,
                  type: m.type || existing.type || "ontology",
                  data: (m && m.data) ? (m.data as NodeData) : (existing.data as NodeData),
                } as RFNode<NodeData>;
                try { if ((existing as any).__rf) (replaced as any).__rf = (existing as any).__rf; } catch (_) {}
                try { if ((existing as any).selected) (replaced as any).selected = true; } catch (_) {}
                try { if ((existing as any).hidden) (replaced as any).hidden = (existing as any).hidden; } catch (_) {}
                resultById.set(id, replaced);
              } else {
                // New node: add as-is but do not assign or modify position (leave m.position if present).
                const newNode = { ...(m as RFNode<NodeData>) };
                // Ensure id and type are present
                newNode.id = id;
                newNode.type = newNode.type || "ontology";
                resultById.set(id, newNode as RFNode<NodeData>);
              }
            } catch (_) {
              // ignore per-item failures
            }
          }

          return Array.from(resultById.values()).filter(Boolean) as RFNode<NodeData>[];
        } catch (e) {
          try { console.warn("[VG] KnowledgeCanvas: replace-node-data failed, falling back to previous nodes", e); } catch (_) {}
          return prev || [];
        }
      });

      // Replace outgoing edges for subjects that emitted in this mapping pass.
      setEdges((prev) => {
        try {
          const prevEdges = Array.isArray(prev) ? prev.slice() : [];
          // Collect subjects present in this mapping batch (mapped/enriched nodes)
          const subjects = new Set<string>((enrichedNodes || []).map((n) => String(n.id)).filter(Boolean));

          // Filter out all previous edges whose source is one of the emitted subjects.
          const kept = prevEdges.filter((e) => {
            try {
              const src = String(e.source || "");
              return !subjects.has(src);
            } catch (_) { return true; }
          });

          // Add all enrichedEdges (they include edges for the emitted subjects).
          const merged = [...kept, ...(enrichedEdges || [])];

          // Deduplicate by id preserving the last occurrence (enriched edges override)
          const byId = new Map<string, RFEdge<LinkData>>();
          for (const e of merged) {
            try { byId.set(String(e.id), e); } catch (_) {}
          }
          const result = Array.from(byId.values());

          // If structurally identical to prev, return prev to avoid updates
          try {
            if (
              prevEdges.length === result.length &&
              prevEdges.every((p, idx) => p.id === result[idx].id && p.source === result[idx].source && p.target === result[idx].target)
            ) {
              return prev;
            }
          } catch (_) { /* ignore compare errors */ }

          return result;
        } catch (_) {
          // fallback: return enrichedEdges
          const byId = new Map<string, RFEdge<LinkData>>();
          for (const e of enrichedEdges || []) {
            try { byId.set(String(e.id), e); } catch (_) {}
          }
          return Array.from(byId.values());
        }
      });

      // Node/edge enrichment removed from KnowledgeCanvas — mappingHelpers and editors are authoritative.
      // Trigger layout (async) only when structure changed or when a programmatic load forced it.
      // Compute a structural fingerprint (node ids + edge ids) and compare with lastStructureFingerprintRef.
      try {
        try {
          const nodeIds = (Array.isArray(mappedNodes) ? mappedNodes.map((n) => String(n.id)) : []).sort().join(',');
          const edgeIds = (Array.isArray(mappedEdges) ? mappedEdges.map((e) => String(e.id)) : []).sort().join(',');
          const newStructFp = `N:${nodeIds}|E:${edgeIds}`;

          const forced = !!loadTriggerRef.current;
          const requestedFit = !!loadFitRef.current;
          // clear trigger if set
          if (forced) {
            try { loadTriggerRef.current = false; } catch (_) { /* ignore */ }
          }

          // Decide whether to run layout: structure changed, forced load, or explicit fit requested.
          const shouldRunLayout = forced || lastStructureFingerprintRef.current !== newStructFp || requestedFit;
          if (shouldRunLayout) {
            lastStructureFingerprintRef.current = newStructFp;
            try {
              // If a fit was requested, force layout even if auto layout disabled,
              // await layout completion and then call fitView.
              if (requestedFit) {
                try {
                  await doLayout(mappedNodes, mappedEdges, true);
                } catch (_) { /* ignore layout errors */ }
                // Wait a small fixed delay to allow RF internal updates and animations to settle
                try { await new Promise((r) => setTimeout(r, 200)); } catch (_) {}
                try {
                  if (reactFlowInstance.current && typeof reactFlowInstance.current.fitView === "function") {
                    try {
                      const _fitStart = Date.now();
                      try { console.debug('[VG] performing fitView after layout', { ts: new Date(_fitStart).toISOString() }); } catch (_) {}
                      reactFlowInstance.current.fitView({ padding: 0.12 });
                      const _fitEnd = Date.now();
                      try { console.debug('[VG] fitView called', { durationMs: (_fitEnd - _fitStart), ts: new Date(_fitEnd).toISOString() }); } catch (_) {}
                      try { console.debug('[VG] canvas.layout.settled', { fitCompletedAt: new Date(_fitEnd).toISOString() }); } catch (_) {}
                    } catch (err) {
                      try { console.warn('[VG] fitView failed', err); } catch (_) {}
                    }
                  }
                } catch (_) { /* ignore fit errors */ }
                try { loadFitRef.current = false; } catch (_) { /* ignore */ }
              } else {
                try {
                  void doLayout(mappedNodes, mappedEdges, !!forced);
                } catch (_) { /* ignore scheduled layout errors */ }
              }
            } catch (_) { /* ignore overall scheduling errors */ }
          }
        } catch (_) {
          // fallback: best-effort direct layout if fingerprinting fails
          try { void doLayout(mappedNodes, mappedEdges, !!loadTriggerRef.current); } catch (_) { /* ignore */ }
          try { loadTriggerRef.current = false; } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      try { console.debug('[VG] canvas.rebuild.end'); } catch (_) {}
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
                          if (primary && mgr) td = undefined;
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
                                      try { if (primary && mgr) td = undefined; } catch (_) { td = undefined; }
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
                                    const td = undefined;
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
  }, [getRdfManager, setNodes, setEdges, availableProperties, availableClasses]);

  // Expose a ready flag for integration tests / tooling and install a mounted apply-layout hook.
  // This will also drain any queued apply requests that arrived before mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;

    try {
      // Drain any pending queued requests that were added by the stub before mount.
      try {
        const pending = (window as any).__VG_APPLY_LAYOUT_PENDING;
        if (Array.isArray(pending) && pending.length > 0) {
          (async () => {
            // Process queued requests sequentially
            for (const req of pending.splice(0)) {
              try {
                const _layoutStart = Date.now();
                try { console.debug('[VG] canvas.layout.apply.start', { layoutKey: req && req.layoutKey ? req.layoutKey : 'unknown', ts: new Date(_layoutStart).toISOString() }); } catch (_) {}
                await doLayout(nodesRef.current, edgesRef.current, true);
                // Wait a short period to allow RF internal state and any animations to settle
                try { await new Promise((r) => setTimeout(r, 200)); } catch (_) {}
                const _layoutEnd = Date.now();
                try { console.debug('[VG] canvas.layout.apply.end', { layoutKey: req && req.layoutKey ? req.layoutKey : 'unknown', durationMs: (_layoutEnd - _layoutStart), ts: new Date(_layoutEnd).toISOString() }); } catch (_) {}
                try { req.resolve(true); } catch (_) {}
              } catch (err) {
                try { console.warn('[VG] queued.__VG_APPLY_LAYOUT failed', err && (err.stack || err.message) ? (err.stack || err.message) : err); } catch (_) {}
                try { req.resolve(false); } catch (_) {}
              }
            }
          })();
        }
      } catch (_) { /* ignore drain errors */ }

      // Replace stub with real implementation that triggers layout immediately.
      (window as any).__VG_APPLY_LAYOUT = async (layoutKey?: string) => {
        const _layoutStart = Date.now();
        try {
          try { console.debug('[VG] canvas.layout.apply.start', { layoutKey: layoutKey || 'unknown', ts: new Date(_layoutStart).toISOString() }); } catch (_) {}
          await doLayout(nodesRef.current, edgesRef.current, true);
          // Allow RF and animations to settle before reporting completion
          try { await new Promise((r) => setTimeout(r, 200)); } catch (_) {}
          const _layoutEnd = Date.now();
          try { console.debug('[VG] canvas.layout.apply.end', { layoutKey: layoutKey || 'unknown', durationMs: (_layoutEnd - _layoutStart), ts: new Date(_layoutEnd).toISOString() }); } catch (_) {}
          try { console.debug('[VG] canvas.layout.apply.completed', layoutKey || 'unknown'); } catch (_) {}
          return true;
        } catch (err) {
          try { console.warn('[VG] __VG_APPLY_LAYOUT failed', err && (err.stack || err.message) ? (err.stack || err.message) : err); } catch (_) {}
          return false;
        }
      };
    } catch (_) { /* ignore expose failures */ }
 
    return () => {
      try { delete (window as any).__VG_KNOWLEDGE_CANVAS_READY; } catch (_) { void 0; }
      try { delete (window as any).__VG_APPLY_LAYOUT; } catch (_) { void 0; }
    };
  }, []);
  
  // Debug: detect any nodes arriving without a numeric position (logs sample ids)
  useEffect(() => {
    try {
      const missing = (nodes || []).filter((n) => {
        try {
          return !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number";
        } catch (_) {
          return true;
        }
      });
      if (missing.length > 0) {
        try {
          console.warn("[VG] nodes missing position on render", {
            count: missing.length,
            sampleIds: missing.slice(0, 20).map((n) => String(n.id)),
          });
        } catch (_) { /* ignore logging failure */ }
      }
    } catch (_) { /* ignore */ }
  }, [nodes]);
  
  // Autoloading initializer (keeps previous behaviour)
  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__VG_INIT_APP = async (opts?: { force?: boolean }) => {
      try {
        try { (window as any).__VG_INIT_APP_RAN = true; } catch (_) { /* ignore */ }

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

        // If a startup URL was provided via query param (rdfUrl / url / vg_url),
        // attempt to load it immediately. This mirrors the onLoadFile flow and
        // ensures the canvas populates when a page is opened with ?rdfUrl=...
        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          try {
            try { canvasActions.setLoading(true, 5, "Loading startup graph..."); } catch (_) {}
            await loadKnowledgeGraph(startupUrl, {
              onProgress: (progress: number, message: string) => {
                try { canvasActions.setLoading(true, Math.max(progress, 5), message); } catch (_) {}
              },
              timeout: 30000,
            });
            try { toast.success("Startup knowledge graph loaded"); } catch (_) {}
            try { loadTriggerRef.current = true; } catch (_) {}
            try { loadFitRef.current = true; } catch (_) {}
          } catch (e) {
            try { toast.error("Failed to load startup graph"); } catch (_) {}
            try { console.warn("[VG] loadKnowledgeGraph(startupUrl) failed", e); } catch (_) {}
          } finally {
            try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
          }
        }

        if (additional && additional.length > 0 && typeof loadAdditionalOntologies === "function") {
            try {
              const mgrLocal = typeof getRdfManager === "function" ? getRdfManager() : undefined;
              const labeledEdges = (((edgesRef && edgesRef.current) || (edges || [])) as RFEdge<LinkData>[]).map((e: any) => {
                try {
                  const pred =
                    (e &&
                      e.data &&
                      (e.data.propertyUri || e.data.propertyType)) ||
                    "";
                  let label = "";
                  if (mgrLocal && pred) {
                    try {
                      const td = undefined;
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

    try {
      if (typeof (window as any).__VG_INIT_APP === "function") {
        (window as any).__VG_INIT_APP({ force: true });
      }
    } catch (_) { /* ignore */ }
    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) { void 0; }
    };
  }, [loadKnowledgeGraph]);

  

  // Minimal ABox/TBox visibility filter using React Flow native hidden flags.
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

  // --------------------
  // Interaction handlers
  // --------------------

  // Reasoning trigger helper (manual trigger from UI).
  // Mirrors ReactFlowCanvas behavior: build small payloads and call startReasoning(store)
  // if available, then update hasReasoningError flags on nodes and edges.
  const triggerReasoning = useCallback(
    async (ns: RFNode<NodeData>[], es: RFEdge<LinkData>[], force = false) => {
      try {
        if (!startReasoning || (!settings?.autoReasoning && !force)) return;
        try {
          const nodesPayload = (ns || []).map((n) =>
            n.data && n.data.iri ? { iri: n.data.iri, key: n.id } : { key: n.id },
          );
          const edgesPayload = (es || []).map((e) => ({ id: e.id, source: e.source, target: e.target }));
          const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
          const result = await startReasoning(nodesPayload as any, edgesPayload as any, mgr && mgr.getStore && mgr.getStore());
          // Apply reasoning error flags
          try {
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
          } catch (_) { /* ignore apply errors */ }
        } catch (err) {
          try { console.warn('[VG] triggerReasoning failed', err); } catch (_) {}
        }
      } catch (_) { /* ignore outer */ }
    },
    [setNodes, setEdges, startReasoning, settings],
  );

  const onNodeDoubleClick = useCallback(
    (event: any, node: any) => {
      // Pass the full React Flow node object to the editor so it can use runtime fields
      // and the canonical node.data without doing any store lookups here.
      canvasActions.setSelectedNode(node as any, true);
    },
    [canvasActions],
  );

  const onEdgeDoubleClick = useCallback(
    (event: any, edge: any) => {
      try {
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
        const foundPropEdge =
          (availableProperties || []).find((p: any) => String(p.iri) === String(propUriFromEdge)) ||
          (loadedOntologies || []).flatMap((o: any) => o.properties || []).find((p: any) => String(p.iri) === String(propUriFromEdge));
        let propLabelFromEdge = "";
        try {
          if (edgeData.label) {
            propLabelFromEdge = String(edgeData.label);
          } else if (foundPropEdge && (foundPropEdge.label || foundPropEdge.name)) {
            propLabelFromEdge = String(foundPropEdge.label || foundPropEdge.name);
          } else {
            const mgrLocal = getRdfManagerRef.current && getRdfManagerRef.current();
            if (mgrLocal && propUriFromEdge) {
              try {
                const td = undefined;
                propLabelFromEdge = String(td.prefixed || td.short || "");
              } catch (_) {
                propLabelFromEdge = "";
              }
            } else {
              propLabelFromEdge = "";
            }
          }
        } catch (_) {
          propLabelFromEdge = edgeData.label || "";
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

        try {
          console.debug("[VG] KnowledgeCanvas.onEdgeDoubleClick selectedLinkPayload", {
            selectedLinkPayload,
            edge,
            nodesCount: nodes.length,
          });
        } catch (_) { /* ignore */ }

        try {
          canvasActions.setSelectedLink(selectedLinkPayload as any, true);
        } catch (_) {
          canvasActions.setSelectedLink(edge as any, true);
        }
      } catch (e) {
        try {
          canvasActions.setSelectedLink(edge.data || edge, true);
        } catch (_) { /* ignore */ }
      }
    },
    [canvasActions, nodes, availableProperties, loadedOntologies],
  );

  const onConnect = useCallback(
    (params: any) => {
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

      // Normalize params
      const claimedSource = String(params.source);
      const claimedTarget = String(params.target);

      // Choose predicate candidate
      let predCandidate: string | null = null;
      try {
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
            try {
              const domain = Array.isArray(p.domain) ? p.domain : [];
              const range = Array.isArray(p.range) ? p.range : [];
              const domainMatch = domain.length === 0 || !srcClass || domain.includes(srcClass);
              const rangeMatch = range.length === 0 || !tgtClass || range.includes(tgtClass);
              return domainMatch && rangeMatch;
            } catch (_) {
              return false;
            }
          });

          predCandidate = compatible
            ? (compatible.iri || (compatible as any).key || "")
            : (availableProperties[0].iri || (availableProperties[0] as any).key);
        }
      } catch (_) {
        predCandidate = availableProperties && availableProperties.length > 0 ? (availableProperties[0].iri || (availableProperties[0] as any).key) : null;
      }

      const predFallback = predCandidate || "http://www.w3.org/2002/07/owl#topObjectProperty";
      const predUriToUse = predCandidate || predFallback;

      // Compute label
      let predLabel = "";
      try {
        const mgrLocal = getRdfManagerRef.current && getRdfManagerRef.current();
        if (mgrLocal && predUriToUse) {
          const td = undefined;
          predLabel = String(td.prefixed || td.short || "");
        }
      } catch (_) {
        predLabel = "";
      }

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

      canvasActions.setSelectedLink(selectedEdgeForEditor as any, true);
    },
    [nodes, canvasActions, availableProperties, loadedOntologies],
  );

  const onEdgeUpdate = useCallback(
    (oldEdge: RFEdge<LinkData>, connection: any) => {
      try {
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

        // Persist change: remove old triple and add new triple using RDF manager
        try {
          const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
          if (mgr && typeof mgr.getStore === "function") {
            const store = mgr.getStore();
            const oldData =
              oldEdge && oldEdge.data ? (oldEdge.data as LinkData) : undefined;
            const oldPredCandidate =
              oldData && (oldData.propertyUri || oldData.propertyType)
                ? oldData.propertyUri || oldData.propertyType
                : availableProperties && availableProperties.length > 0
                  ? availableProperties[0].iri ||
                    (availableProperties[0] as any).key
                  : "http://www.w3.org/2000/01/rdf-schema#seeAlso";
            const oldPredFull =
              mgr.expandPrefix && typeof mgr.expandPrefix === "function"
                ? mgr.expandPrefix(oldPredCandidate)
                : oldPredCandidate;
            const oldSubj = oldEdge.source;
            const oldObj = oldEdge.target;

            // remove matching quads
            try {
              const oldSubjTerm = termForIri(String(oldSubj));
              const oldObjTerm = termForIri(String(oldObj));
              const g = namedNode("urn:vg:data");
              const found =
                store.getQuads(
                  oldSubjTerm,
                  namedNode(oldPredFull),
                  oldObjTerm,
                  g,
                ) || [];
              found.forEach((q: any) => {
                try {
                  store.removeQuad(q);
                } catch (_) {
                  /* ignore */
                }
              });
            } catch (_) {
              /* ignore */
            }

            // add new quad (use connection.source/target and previous predicate)
            try {
              const subjIri =
                (sourceNode.data && (sourceNode.data as NodeData).iri) ||
                sourceNode.id;
              const objIri =
                (targetNode.data && (targetNode.data as NodeData).iri) ||
                targetNode.id;
              const subjTerm = termForIri(String(subjIri));
              const objTerm = termForIri(String(objIri));
              const predTerm2 = namedNode(oldPredFull);
              const g = namedNode("urn:vg:data");
              const exists =
                store.getQuads(
                  subjTerm,
                  predTerm2,
                  objTerm,
                  g,
                ) || [];
              if (exists.length === 0) {
                store.addQuad(DataFactory.quad(subjTerm, predTerm2, objTerm, g));
              }
            } catch (_) {
              /* ignore add errors */
            }
          }
        } catch (e) {
          try {
            console.warn("knowledgecanvas.persistEdgeUpdate.failed", {
              error: e && (e as Error).message ? (e as Error).message : String(e),
            });
          } catch (_) { /* ignore */ }
        }

        setEdges((eds) =>
          eds.map((e) =>
            e.id === oldEdge.id
              ? { ...e, source: connection.source!, target: connection.target! }
              : e,
          ),
        );
      } catch (e) {
        /* ignore handler failure */
      }
    },
    [nodes, setEdges, availableProperties],
  );

  const onEdgeUpdateEnd = useCallback(() => {
    // no-op
  }, []);

  // Save handlers used by the editors — persist to urn:vg:data
  const handleSaveNodeProperties = useCallback(
    async (properties: any[]) => {
      if (!canvasState.selectedNode) return;
      const entityUri =
        (canvasState.selectedNode as any)?.iri ||
        (canvasState.selectedNode as any)?.iri ||
        (canvasState.selectedNode as any)?.key;
      if (!entityUri) return;
      const annotationProperties = (properties || []).map((p: any) => ({
        property: p.key || p.property,
        value: p.value,
        datatype: p.type || "xsd:string",
      }));
      try {
        updateNode(entityUri, { annotationProperties });
        // Update node locally
        setNodes((nds) =>
          nds.map((n) => {
            if (n.id === (canvasState.selectedNode as any)?.key) {
              return {
                ...n,
                data: {
                  ...(n.data as NodeData),
                  annotationProperties,
                } as NodeData,
              };
            }
            return n;
          }),
        );

        // Also persist annotation quads into urn:vg:data using rdfManager (best-effort)
        try {
          const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
          if (mgr && typeof mgr.getStore === "function") {
            const store = mgr.getStore();
            const g = namedNode("urn:vg:data");
            const subjTerm = termForIri(String(entityUri));
            for (const ap of annotationProperties) {
              try {
                const predFull = mgr.expandPrefix && typeof mgr.expandPrefix === "function"
                  ? mgr.expandPrefix(ap.property)
                  : ap.property;
                const predTerm = namedNode(predFull);
                const objTerm = typeof ap.value === "string" ? DataFactory.literal(String(ap.value)) : DataFactory.literal(String(ap.value));
                const exists = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
                if (!exists || exists.length === 0) {
                  store.addQuad(DataFactory.quad(subjTerm, predTerm, objTerm, g));
                }
              } catch (_) { /* ignore per-quad */ }
            }
          }
        } catch (_) { /* ignore persistence */ }
      } catch (e) {
        try {
          console.warn("knowledgecanvas.saveNode.failed", {
            error: e && (e as Error).message ? (e as Error).message : String(e),
          });
        } catch (_) { /* ignore */ }
      }
    },
    [canvasState.selectedNode, updateNode, setNodes],
  );

  const handleSaveLinkProperty = useCallback(
    (propertyUri: string, label: string) => {
      const selected = canvasState.selectedLink;
      if (!selected) return;

      // Update edge UI state: set both propertyUri and propertyType (legacy) and label
      setEdges((eds) =>
        eds.map((e) => {
          const keyMatch =
            e.id === (selected as any).key || e.id === (selected as any).id;
          if (keyMatch) {
            const newData: LinkData = {
              ...(e.data as LinkData),
              propertyType: propertyUri, // keep legacy field populated
              propertyUri,
              label,
            };
            return { ...e, data: newData };
          }
          return e;
        }),
      );

      // Persist predicate change to RDF store: replace old predicate quad with new one where possible
      try {
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

            // Remove quads that used the previous predicate (if any)
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
              try {
                const g = namedNode("urn:vg:data");
                const found =
                  store.getQuads(
                    subjTerm,
                    namedNode(oldPredFull),
                    objTerm,
                    g,
                  ) || [];
                found.forEach((q: any) => {
                  try {
                    store.removeQuad(q);
                  } catch (_) {
                    /* ignore */
                  }
                });
              } catch (_) {
                /* ignore removal errors */
              }
            }

            // Add the new predicate quad
            try {
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
            } catch (_) {
              /* ignore add errors */
            }
          }
        }
      } catch (_) {
        /* ignore persistence errors */
      }
    },
    [canvasState.selectedLink, setEdges],
  );

  // --------------------
  // Render
  // --------------------

  const safeNodes = useMemo(() => {
    try {
      return (nodes || []).map((n) => {
        try {
          if (!n || !n.position || typeof (n.position as any).x !== "number" || typeof (n.position as any).y !== "number") {
            return { ...(n || {}), position: { x: 0, y: 0 } } as RFNode<NodeData>;
          }
        } catch (_) {
          return { ...(n || {}), position: { x: 0, y: 0 } } as RFNode<NodeData>;
        }
        return n;
      });
    } catch (_) {
      return nodes || [];
    }
  }, [nodes]);

  const rfProps: any = {
    nodes: safeNodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onInit,
    onNodeDoubleClick,
    onEdgeDoubleClick,
    onConnect,
    onEdgeUpdate,
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
          try {
            // Keep node creation minimal per your instructions: existing implementation assumed working.
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
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onConnect={onConnect}
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

      {/* Render editors so dialogs can persist triples into urn:vg:data */}
      {(() => {
        try {
          console.debug('[VG] Render editors', {
            showNodeEditor: canvasState.showNodeEditor,
            selectedNode: canvasState.selectedNode && ((canvasState.selectedNode as any).key || (canvasState.selectedNode as any).id) ? ((canvasState.selectedNode as any).key || (canvasState.selectedNode as any).id) : canvasState.selectedNode,
            showLinkEditor: canvasState.showLinkEditor,
            selectedLink: canvasState.selectedLink && ((canvasState.selectedLink as any).id || (canvasState.selectedLink as any).key) ? ((canvasState.selectedLink as any).id || (canvasState.selectedLink as any).key) : canvasState.selectedLink,
          });
        } catch (_) { /* ignore */ }
        return null;
      })()}

      <ReasoningIndicator
        onOpenReport={() => canvasActions.toggleReasoningReport(true)}
        onRunReason={() => {
          try {
            console.debug('[VG] Manual reasoning requested (forced)');
            void triggerReasoning(nodes, edges, true);
          } catch (e) {
            try { console.warn('manual reasoning trigger failed', e); } catch (_) { /* ignore */ }
          }
        }}
      />

      <ReasoningReportModal
        open={canvasState.showReasoningReport}
        onOpenChange={canvasActions.toggleReasoningReport}
      />

      <NodePropertyEditor
        open={canvasState.showNodeEditor}
        onOpenChange={(open) => {
          try { canvasActions.toggleNodeEditor(Boolean(open)); } catch (_) {}
        }}
        nodeData={canvasState.selectedNode}
        availableEntities={allEntities}
        onSave={(props: any[]) => {
          try { handleSaveNodeProperties(props); } catch (_) {}
          try { canvasActions.toggleNodeEditor(false); } catch (_) {}
        }}
      />

      <LinkPropertyEditor
        open={canvasState.showLinkEditor}
        onOpenChange={(open) => {
          try { canvasActions.toggleLinkEditor(Boolean(open)); } catch (_) {}
        }}
        linkData={canvasState.selectedLink}
        sourceNode={linkSourceRef.current}
        targetNode={linkTargetRef.current}
        onSave={(propertyUri: string, label: string) => {
          try { handleSaveLinkProperty(propertyUri, label); } catch (_) {}
          try { canvasActions.toggleLinkEditor(false); } catch (_) {}
        }}
      />
    </div>
  );
};

export default KnowledgeCanvas;
