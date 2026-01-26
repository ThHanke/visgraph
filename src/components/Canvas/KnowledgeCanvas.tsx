/* eslint-disable @typescript-eslint/no-unused-expressions, no-useless-catch, react-hooks/exhaustive-deps, no-empty */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useSettingsStore } from "../../stores/settingsStore";
import { useAppConfigStore } from "../../stores/appConfigStore";
import { CanvasToolbar } from "./CanvasToolbar";
import { ResizableNamespaceLegend } from "./ResizableNamespaceLegend";
import { ReasoningIndicator } from "./ReasoningIndicator";
import { ReasoningReportModal } from "./ReasoningReportModal";
import ModalStatus from "./ModalStatus";
import { Progress } from "../ui/progress";
import type { ReactFlowInstance } from "@xyflow/react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { NodeData, LinkData } from "../../types/canvas";
import mapQuadsToDiagram from "./core/mappingHelpers";
import { RDFNode as OntologyNode } from "./RDFNode";
import ObjectPropertyEdge from "./ObjectPropertyEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";
import { generateEdgeId } from "./core/edgeHelpers";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { expandPrefixed, toPrefixed } from "../../utils/termUtils";
import { exportSvgFull, exportPngFull } from "./core/downloadHelpers";
import { getNamespaceRegistry } from "../../utils/storeHelpers";
import { applyDiagramChangeSmart } from "./core/diagramChangeHelpers";

const LAYOUT_META_REASONS = new Set<string>([
  "syncBatch",
  "syncLoad",
  "importSerialized",
  "loadFromUrl",
  "removeGraph",
  "removeAllQuadsForIri",
  "removeQuadsByNamespace",
  "purgeNamespace",
  "reasoning",
  "clear",
]);
import {
  exportViewportSvgMinimal,
  exportViewportPngMinimal,
} from "./core/exportHelpers";
import { useCanvasState } from "../../hooks/useCanvasState";
import { toast } from "sonner";
import { LayoutManager } from "./LayoutManager";
import { NodePropertyEditor } from "./NodePropertyEditor";
import { projectClient } from "./core/viewportUtils";
import type { ReasoningResult } from "../../utils/rdfManager";
import { useShallow } from "zustand/react/shallow";
import * as LinkPropertyEditorModule from "./LinkPropertyEditor";
const LinkPropertyEditor: any = (() => {
  const mod = LinkPropertyEditorModule as any;
  if (mod && typeof mod === "object") {
    if ((mod as any).LinkPropertyEditor) return (mod as any).LinkPropertyEditor;
    if ((mod as any).default) return (mod as any).default;
  }
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

/**
 * Provide a race-safe stub for external test runners that may call window.__VG_APPLY_LAYOUT
 * before the React component mounts. Only install the stub in browser-like environments
 * where `window` is defined. In non-browser (test/node) environments we skip defining it
 * to avoid ReferenceError.
 */
if (typeof window !== "undefined") {
  if (!(window as any).__VG_APPLY_LAYOUT) {
    (window as any).__VG_APPLY_LAYOUT = (layoutKey?: string) => {
      if (!(window as any).__VG_APPLY_LAYOUT_PENDING)
        (window as any).__VG_APPLY_LAYOUT_PENDING = [];
      return new Promise((resolve) => {
        try {
          (window as any).__VG_APPLY_LAYOUT_PENDING.push({
            layoutKey,
            resolve,
          });
        } catch (e) {
          try {
            resolve(false);
          } catch (_) {
            // intentionally ignore resolve failures
          }
        }
      }).catch(() => Promise.resolve(false));
    };
  }
}

const KnowledgeCanvas: React.FC = () => {
  // Resolve NodePropertyEditor at runtime using require so test-level vi.mock
  // values that export either a named export or a default export are supported.
  const [nodes, setNodes] = useNodesState<RFNode<NodeData>>([]);
  const [edges, setEdges] = useEdgesState<RFEdge<LinkData>>([]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<{ x: number; y: number; zoom: number }>({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const skipNextAutoLayoutRef = useRef(false);
  const updateViewportRef = useCallback(
    (viewport?: { x: number; y: number; zoom: number }) => {
      if (
        viewport &&
        typeof viewport.x === "number" &&
        typeof viewport.y === "number" &&
        typeof viewport.zoom === "number" &&
        viewport.zoom !== 0 &&
        Number.isFinite(viewport.x) &&
        Number.isFinite(viewport.y) &&
        Number.isFinite(viewport.zoom)
      ) {
        viewportRef.current = {
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        };
      }
    },
    [],
  );
  const { state: canvasState, actions: canvasActions } = useCanvasState();

  const {
    loadedOntologies,
    availableClasses,
    availableProperties,
    ontologiesVersion,
    loadKnowledgeGraph,
    exportGraph,
    loadAdditionalOntologies,
    getRdfManager,
  } = useOntologyStore(
    useShallow((state) => ({
      loadedOntologies: state.loadedOntologies ?? [],
      availableClasses: state.availableClasses ?? [],
      availableProperties: state.availableProperties ?? [],
      ontologiesVersion: state.ontologiesVersion ?? 0,
      loadKnowledgeGraph: state.loadKnowledgeGraph,
      exportGraph: state.exportGraph,
      loadAdditionalOntologies: state.loadAdditionalOntologies,
      getRdfManager: state.getRdfManager,
    })),
  );

  // Safe getter for the RDF manager: prefer the selector-provided function but fall back to the store's getState accessor.
  // Some test mocks replace the store-level getter, so this helper ensures we find the manager reliably.
  const getRdfManagerSafe = useCallback(() => {
    if (typeof getRdfManager === "function") {
      const manager = getRdfManager();
      if (manager) return manager;
    }
    const getter =
      typeof (useOntologyStore as any).getState === "function"
        ? (useOntologyStore as any).getState().getRdfManager
        : undefined;
    return typeof getter === "function" ? getter() : undefined;
  }, [getRdfManager]);

  const settings = useSettingsStore((s) => s.settings);
  const config = useAppConfigStore((s) => s.config);
  const setCurrentLayout = useAppConfigStore((s) => s.setCurrentLayout);
  const setShowLegend = useAppConfigStore((s) => s.setShowLegend);
  const setPersistedViewMode = useAppConfigStore((s) => s.setViewMode);

  const [currentReasoning, setCurrentReasoning] = useState<ReasoningResult | null>(null);
  const [reasoningHistory, setReasoningHistory] = useState<ReasoningResult[]>([]);
  const [isReasoning, setIsReasoning] = useState(false);
  const reasoningInFlightRef = useRef(false);

  const [viewMode, setViewMode] = useState(config.viewMode);
  const [showLegend, setShowLegendState] = useState(config.showLegend);
  const [currentLayout, setCurrentLayoutState] = useState(config.currentLayout);
  // Layout toggle initialized from persisted config
  const [layoutEnabled, setLayoutEnabled] = useState(
    () => !!(config && config.autoApplyLayout),
  );

  // Separate viewport state for ABox and TBox views
  const aboxViewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const tboxViewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });

  // Palette from RDF manager — used to compute colors without rebuilding palettes.
  const palette = usePaletteFromRdfManager();
  const paletteRef = useRef(palette);
  useEffect(() => {
    paletteRef.current = palette;
  }, [palette]);


  // Local editor state driven by React Flow events (node/edge payloads come from RF state).
  const [nodeEditorOpen, setNodeEditorOpen] = useState<boolean>(false);
  const [linkEditorOpen, setLinkEditorOpen] = useState<boolean>(false);
  const [selectedNodePayload, setSelectedNodePayload] = useState<any | null>(
    null,
  );
  const [selectedLinkPayload, setSelectedLinkPayload] = useState<any | null>(
    null,
  );

  const handleToggleLayoutEnabled = useCallback((enabled: boolean) => {
    setLayoutEnabled(Boolean(enabled));
    useAppConfigStore.getState().setAutoApplyLayout(Boolean(enabled));
  }, []);

  useEffect(() => {
    setViewMode(config.viewMode);
    setShowLegendState(config.showLegend);
    setCurrentLayoutState(config.currentLayout);
    setLayoutEnabled(Boolean(config.autoApplyLayout));
  }, [
    config.viewMode,
    config.showLegend,
    config.currentLayout,
    config.autoApplyLayout,
  ]);

  const allEntities = useMemo(() => {
    const list = Array.isArray(loadedOntologies) ? loadedOntologies : [];
    return list.flatMap((ontology) => [
      ...(Array.isArray(ontology?.classes) ? ontology.classes : []).map(
        (cls: any) => ({
          iri: cls.iri,
          label: cls.label,
          namespace: cls.namespace,
          rdfType: "owl:Class" as const,
          description: `Class from ${ontology.name}`,
        }),
      ),
      ...(Array.isArray(ontology?.properties) ? ontology.properties : []).map(
        (prop: any) => ({
          iri: prop.iri,
          label: prop.label,
          namespace: prop.namespace,
          rdfType: String(prop.iri || "").includes("ObjectProperty")
            ? "owl:ObjectProperty"
            : ("owl:AnnotationProperty" as const),
          description: `Property from ${ontology.name}`,
        }),
      ),
    ]);
  }, [ontologiesVersion, loadedOntologies]);

  const availablePropertiesSnapshot = useMemo(() => {
    return Array.isArray(availableProperties)
      ? (availableProperties as any[]).slice()
      : [];
  }, [availableProperties, ontologiesVersion]);

  // Predicate-kind lookup snapshot (derived from availablePropertiesSnapshot).
  // The pure mapper can use this lookup synchronously and deterministically.
  const predicateKindLookup = useMemo(() => {
    const m = new Map<
      string,
      "annotation" | "object" | "datatype" | "unknown"
    >();
    const arr = Array.isArray(availablePropertiesSnapshot)
      ? availablePropertiesSnapshot
      : [];
    for (const p of arr) {
      const iri = p && (p.iri || p.key) ? String(p.iri || p.key) : "";
      if (!iri) continue;
      const kindRaw = (p && (p.propertyKind || p.kind || p.type)) || undefined;
      if (
        kindRaw === "object" ||
        (Array.isArray(p.range) && p.range.length > 0)
      ) {
        m.set(iri, "object");
        continue;
      }
      if (
        kindRaw === "datatype" ||
        (Array.isArray(p.range) &&
          p.range.length === 0 &&
          Array.isArray(p.domain) &&
          p.domain.length === 0)
      ) {
        m.set(iri, "datatype");
        continue;
      }
      if (kindRaw === "annotation") {
        m.set(iri, "annotation");
        continue;
      }
      // fallback unknown
      if (!m.has(iri)) m.set(iri, "unknown");
    }

    return m;
  }, [availablePropertiesSnapshot, ontologiesVersion]);

  const predicateClassifier = useCallback(
    (predicateIri: string) =>
      predicateKindLookup.get(String(predicateIri)) ?? "unknown",
    [predicateKindLookup],
  );
  const predicateClassifierRef = useRef(predicateClassifier);
  useEffect(() => {
    predicateClassifierRef.current = predicateClassifier;
  }, [predicateClassifier]);

  // Snapshot of available classes derived from the ontology store so we pass
  // stable references to the mapper/worker and avoid triggering unnecessary work.
  const availableClassesSnapshot = useMemo(() => {
    try {
      return Array.isArray(availableClasses)
        ? (availableClasses as any[]).slice()
        : [];
    } catch (_) {
      return [];
    }
  }, [availableClasses, ontologiesVersion]);
  const availableClassesRef = useRef(availableClassesSnapshot);
  useEffect(() => {
    availableClassesRef.current = availableClassesSnapshot;
  }, [availableClassesSnapshot]);

  const availablePropertiesRef = useRef(availablePropertiesSnapshot);
  useEffect(() => {
    availablePropertiesRef.current = availablePropertiesSnapshot;
  }, [availablePropertiesSnapshot]);

  // Namespace registry snapshot used by the mapper. Use ontologiesVersion as a
  // cheap and reliable signal that the registry may have changed.
  const registrySnapshot = useMemo(() => {
    try {
      const st =
        (useOntologyStore as any).getState &&
        (useOntologyStore as any).getState();
      const reg =
        st && Array.isArray(st.namespaceRegistry)
          ? st.namespaceRegistry.slice()
          : [];
      return reg;
    } catch (_) {
      return [];
    }
  }, [ontologiesVersion]);

  // Mounted ref to help guard async callbacks that may run after unmount.
  const mountedRef = useRef<boolean>(true);

  // Track timeouts scheduled by this component so they can be cleared on unmount.
  // Some timers are created in many callbacks (double-click guards, deferred layout, etc.)
  // and can fire after the component unmounts during tests — causing "document" errors.
  // Use setTrackedTimeout(...) instead of setTimeout(...) where appropriate.
  const timeoutsRef = useRef<number[]>([]);
  const setTrackedTimeout = useCallback((fn: any, delay = 0) => {
    try {
      if (typeof window === "undefined") {
        // In non-browser test envs, preserve async ordering by scheduling as microtask.
        Promise.resolve().then(fn);
        return -1;
      }
      const id = window.setTimeout(fn, delay);
      try {
        timeoutsRef.current.push(id);
      } catch (_) {
        // ignore tracking failures
      }
      return id;
    } catch (_) {
      try {
        Promise.resolve().then(fn);
      } catch (_) {
        /* ignore */
      }
      return -1;
    }
  }, []);

  const clearAllTrackedTimeouts = useCallback(() => {
    try {
      for (const id of timeoutsRef.current || []) {
        try {
          window.clearTimeout(id);
        } catch (_) {/* noop */}
      }
      timeoutsRef.current = [];
    } catch (_) {
      /* ignore */
    }
  }, []);

  // Ensure all tracked timers are cleared when the component unmounts.
  useEffect(() => {
    return () => {
      try {
        clearAllTrackedTimeouts();
      } catch (_) {
        /* ignore */
      }
    };
  }, [clearAllTrackedTimeouts]);

  const mapQuadsWithWorker = useCallback(
    (quads: any[], opts: Parameters<typeof mapQuadsToDiagram>[1]) => {
      try {
        console.debug("[KnowledgeCanvas] mapQuadsToDiagram.input", {
          quadCount: Array.isArray(quads) ? quads.length : 0,
          sample: (quads || []).slice(0, 5),
        });
      } catch (_) {
        /* ignore logging failures */
      }
      const result = mapQuadsToDiagram(quads, opts);
      try {
        console.debug("[KnowledgeCanvas] mapQuadsToDiagram.output", {
          nodeCount: Array.isArray(result?.nodes) ? result.nodes.length : 0,
          edgeCount: Array.isArray(result?.edges) ? result.edges.length : 0,
          sampleNodes: (result?.nodes || []).slice(0, 5),
          sampleEdges: (result?.edges || []).slice(0, 5),
        });
      } catch (_) {
        /* ignore logging failures */
      }
      return result;
    },
    [],
  );
  const loadTriggerRef = useRef(false);
  const loadFitRef = useRef(false);

  // Removed legacy diagramRef/positionsRef shim: LayoutManager is now pure and returns node changes.
  const layoutManagerRef = useRef<LayoutManager | null>(new LayoutManager());

  const layoutInProgressRef = useRef<boolean>(false);
  const lastLayoutFingerprintRef = useRef<string | null>(null);
  const suppressSelectionRef = useRef<boolean>(false);
  const lastDragStopRef = useRef<number | null>(null);
  // Time window (ms) during which selection/clicks after a drag are ignored
  const RECENT_DRAG_MS = 500;

  // Track the pointer-down snapshot for the most recent pointer interaction.
  // This lets us deterministically know whether the node was selected at the
  // moment the user pressed down, which avoids selection-then-drag races.
  const lastPointerDownRef = useRef<{
    pointerId: any;
    nodeId: any;
    wasSelectedAtDown: boolean;
  } | null>(null);

  // Pointer id that started a drag — used to cancel click-open when a drag occurred.
  const dragStartedPointerRef = useRef<any | null>(null);

  // One-shot capture-phase mouseup handler ref used to intercept the native mouseup
  // event that fires at the end of a node drag. This helps avoid timing races where
  // a mouseup propagates and triggers click/double-click handlers that open editors.
  const nodeDragMouseUpHandlerRef = useRef<any>(null);

  const linkSourceRef = useRef<NodeData | null>(null);
  const linkTargetRef = useRef<NodeData | null>(null);
  const getRdfManagerRef = useRef(getRdfManager);
  const shouldLayoutForMeta = useCallback((meta?: Record<string, unknown> | null) => {
    if (!meta || typeof meta !== "object") return false;
    const numericKeys = [
      "added",
      "removed",
      "addedCount",
      "removedSubjects",
      "removedObjects",
    ];
    for (const key of numericKeys) {
      const value = (meta as Record<string, unknown>)[key];
      if (typeof value === "number" && value > 0) return true;
    }
    const reason =
      typeof (meta as Record<string, unknown>).reason === "string"
        ? String((meta as Record<string, unknown>).reason)
        : "";
    if (!reason) return false;
    return LAYOUT_META_REASONS.has(reason);
  }, []);

  // Small control refs for layout coordination
  const mappingInProgressRef = useRef<boolean>(false);
  const applyRequestedRef = useRef<boolean>(false);
  // One-shot flag to force layout after the next successful mapping run (used by loaders)
  const forceLayoutNextMappingRef = useRef<boolean>(false);
  const layoutPendingRef = useRef<boolean>(false);
  const lastLayoutMetaRef = useRef<Record<string, unknown> | null>(null);
  // Track which views have been laid out so we know when to clear the pending flag
  const layoutedViewsRef = useRef<Set<'abox' | 'tbox'>>(new Set());
  // Suppress layout during chunked updates
  const suppressLayoutDuringChunksRef = useRef<boolean>(false);

  // Keep refs in sync with state so other callbacks can read the latest snapshot synchronously.


  const doLayout = useCallback(
    async (
      candidateNodes: RFNode<NodeData>[],
      candidateEdges: RFEdge<LinkData>[],
      force = false,
      layoutTypeOverride?: string,
    ) => {
      // Skip layout if suppressed during chunked update
      if (suppressLayoutDuringChunksRef.current && !force) {
        return;
      }

      if (!force && (!layoutEnabled || !(config && config.autoApplyLayout)))
        return;
      if (layoutInProgressRef.current) {
        if (!force) return;
        return;
      }

    const lm = layoutManagerRef.current;
    if (!lm) return;
    // If we have a live React Flow instance, wire it into the LayoutManager so
    // the manager can read runtime measurement metadata (e.g. __rf.width/height).
    if (
      reactFlowInstance &&
      reactFlowInstance.current &&
      typeof lm.setDiagram === "function"
    ) {
      lm.setDiagram(reactFlowInstance.current);
    }

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
    const fingerprint = fingerprintParts.join(";");

    if (!force && lastLayoutFingerprintRef.current === fingerprint) return;

    layoutInProgressRef.current = true;
    try {
      const layoutType =
        layoutTypeOverride ||
        (config && config.currentLayout) ||
        lm.suggestOptimalLayout();

      // React Flow now handles node measurements automatically via __rf metadata
      // since all visible nodes are rendered to the DOM
      const nodeChanges = await lm.applyLayout(
        layoutType as any,
        {
          nodeSpacing: (config && (config.layoutSpacing as any)) || undefined,
        },
        {
          nodes: candidateNodes || [],
          edges: candidateEdges || [],
        },
      );
      if (Array.isArray(nodeChanges) && nodeChanges.length > 0) {
        // Apply position changes using proper React Flow position change format
        setNodes((prev = []) => {
          const changes = (nodeChanges || []).map((nc: any) => {
            const id = String(nc.id);
            const pos = nc.position || { x: 0, y: 0 };
            // Use proper React Flow position change type
            return { 
              id, 
              type: "position", 
              position: pos,
              dragging: false
            };
          });
          return applyNodeChanges(changes as any, prev || []);
        });
      }
    } catch (err) {
      layoutInProgressRef.current = false;
      throw err;
    } finally {
      const raf = () =>
        new Promise((resolve) => {
          try {
            requestAnimationFrame(resolve);
          } catch (_) {
            setTrackedTimeout(resolve, 16);
          }
        });
      await raf();
      await raf();
      lastLayoutFingerprintRef.current = fingerprint;
      layoutInProgressRef.current = false;
    }
  },
  [layoutEnabled, config, setNodes, setTrackedTimeout],
);

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
          delete (copy as any).selected;
          return copy;
        }),
      );

      setEdges((prev) =>
        (prev || []).map((e) => {
          const copy = { ...(e as RFEdge<LinkData>) } as RFEdge<LinkData>;
          delete (copy as any).selected;
          return copy;
        }),
      );
      // Instrumentation: signal that a mapping run completed so tests can wait deterministically.
      if (typeof window !== "undefined")
        (window as any).__VG_LAST_MAPPING_RUN = Date.now();
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

  const exportSvg = useCallback(async () => {
    {
      canvasActions.setLoading(true, 10, "Preparing SVG export...");
    }
      try {
        // exportSvgFull does not accept a reactFlowContainerSelector option;
        // call with no options and let the helper choose the viewport.
        await exportSvgFull();
        toast.success("SVG exported (full)");
      } catch (err) {
        console.error(err);
        toast.error("SVG export failed");
      } finally {
        {
          canvasActions.setLoading(false, 0, "");
        }
      }
  }, [canvasActions]);

  const exportPng = useCallback(
    async (scale = 2) => {
      {
        canvasActions.setLoading(true, 10, "Preparing PNG export...");
      }
        try {
          // exportPngFull accepts only filename and scale; pass scale directly.
          await exportPngFull({ scale });
          toast.success("PNG exported (full)");
        } catch (err) {
          console.error(err);
          toast.error("PNG export failed");
        } finally {
          {
            canvasActions.setLoading(false, 0, "");
          }
        }
    },
    [canvasActions],
  );

  const onLoadFile = useCallback(
    async (file: File | any) => {
      canvasActions.setLoading(true, 10, "Reading file...");
      try {
        let text: string;
        if (file.type === "url" || typeof file === "string" || file.url) {
          // Delegate fetch+parse to loadKnowledgeGraph which centralizes URL handling.
          const url = file.url || file;
          canvasActions.setLoading(true, 10, "Loading from URL...");
          try {
            // loadKnowledgeGraph accepts a URL and will fetch/parse via rdfManager.
            await loadKnowledgeGraph(String(url), {
              onProgress: (progress: number, message: string) => {
                try {
                  canvasActions.setLoading(true, Math.max(progress, 30), message);
                } catch (_) { /* ignore canvas update failures */ }
              },
              timeout: 30000,
            });
            // Signal success to follow the same path as the file/text branch.
            toast.success("Knowledge graph loaded successfully");
          } catch (err) {
            // Re-throw so outer handler deals with error reporting
            throw err;
          }
      } else {
        // Inline file content -> read and parse via existing loadKnowledgeGraph path
        text = await file.text();
        canvasActions.setLoading(true, 30, "Parsing RDF...");

        loadTriggerRef.current = true;
        loadFitRef.current = true;

        // Ensure the next mapping run performs layout for this user-initiated load
        forceLayoutNextMappingRef.current = true;

        // Pass the filename so RDF parser can determine content type
        await loadKnowledgeGraph(text, {
          onProgress: (progress: number, message: string) => {
            canvasActions.setLoading(true, Math.max(progress, 30), message);
          },
          timeout: 30000,
          filename: file.name || undefined,
        });
        toast.success("Knowledge graph loaded successfully");

        setTrackedTimeout(() => {
          void doLayout(nodes, edges, true);
        }, 300);
        void doLayout(nodes, edges, true);
      }
      } finally {
        canvasActions.setLoading(false, 0, "");
      }
    },
    [loadKnowledgeGraph, canvasActions, doLayout],
  );

  const handleLayoutChange = useCallback(
    async (
      layoutType: string,
      force = false,
      options?: { nodeSpacing?: number },
    ) => {
      setCurrentLayout(String(layoutType || ""));
      setCurrentLayoutState(String(layoutType || ""));

      if (options && typeof options.nodeSpacing === "number") {
        useAppConfigStore
          .getState()
          .setLayoutSpacing(Math.max(50, Math.min(500, options.nodeSpacing)));
      }

      await doLayout(nodes, edges, !!force, layoutType);
    },
    [setCurrentLayout, setCurrentLayoutState, doLayout, nodes, edges],
  );

  const computeCanvasCenter = useCallback(() => {
    const fallback = () => {
      try {
        if (typeof window !== "undefined") {
          const projected = projectClient(
            window.innerWidth / 2,
            window.innerHeight / 2,
          );
          if (
            projected &&
            typeof projected.x === "number" &&
            typeof projected.y === "number"
          ) {
            return projected;
          }
        }
      } catch (_) {
        // ignore fallback failures
      }
      return { x: 100, y: 100 };
    };

    try {
      const inst = reactFlowInstance.current;
      if (!inst) return fallback();

      const wrapper = flowWrapperRef.current;
      const width = wrapper?.clientWidth ?? 0;
      const height = wrapper?.clientHeight ?? 0;
      const { x: tx, y: ty, zoom } = viewportRef.current;

      if (
        width > 0 &&
        height > 0 &&
        zoom &&
        Number.isFinite(zoom)
      ) {
        const centerX = (width / 2 - tx) / zoom;
        const centerY = (height / 2 - ty) / zoom;
        if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
          return { x: centerX, y: centerY };
        }
      }

      const container =
        wrapper ||
        (typeof document !== "undefined"
          ? (document.querySelector(".react-flow") as HTMLElement | null)
          : null);

      const rect = container?.getBoundingClientRect();

      const screenCenter = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : typeof window !== "undefined"
        ? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        : null;

      if (
        screenCenter &&
        typeof (inst as any).screenToFlowPosition === "function"
      ) {
        const projected = (inst as any).screenToFlowPosition(screenCenter);
        if (
          projected &&
          typeof projected.x === "number" &&
          typeof projected.y === "number"
        ) {
          return projected;
        }
      }

      if (rect && typeof (inst as any).project === "function") {
        const projected = (inst as any).project({
          x: rect.width / 2,
          y: rect.height / 2,
        });
        if (
          projected &&
          typeof projected.x === "number" &&
          typeof projected.y === "number"
        ) {
          return projected;
        }
      }

      if (rect && typeof (inst as any).getViewport === "function") {
        const viewport = (inst as any).getViewport();
        if (
          viewport &&
          typeof viewport.x === "number" &&
          typeof viewport.y === "number" &&
          typeof viewport.zoom === "number" &&
          viewport.zoom !== 0
        ) {
          const localWidth = rect.width || width || 0;
          const localHeight = rect.height || height || 0;
          if (localWidth > 0 && localHeight > 0) {
            const centerX = (localWidth / 2 - viewport.x) / viewport.zoom;
            const centerY = (localHeight / 2 - viewport.y) / viewport.zoom;
            if (Number.isFinite(centerX) && Number.isFinite(centerY)) {
              return { x: centerX, y: centerY };
            }
          }
        }
      }
    } catch (_) {
      // ignore and use fallback
    }

    return fallback();
  }, []);

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
    // Ensure the LayoutManager has access to the React Flow instance so it can
    // obtain DOM-measured node sizes before computing layouts.
    const lm = layoutManagerRef.current;
    if (lm && typeof (lm as any).setDiagram === "function") {
      (lm as any).setDiagram(instance);
    }
    if (typeof window !== "undefined")
      (window as any).__VG_RF_INSTANCE = instance;
    try {
      if (typeof (instance as any).getViewport === "function") {
        updateViewportRef((instance as any).getViewport());
      }
    } catch (_) {
      // ignore viewport bootstrap failures
    }
  }, [updateViewportRef]);

  const onSelectionChange = useCallback(
    (selection: { nodes?: any[]; edges?: any[] } = {}) => {
      // If a double-click handler recently set a guard we suppress processing
      // of the selection-change event to avoid races where selection-change
      // would immediately close an editor opened by double-click.
      if (suppressSelectionRef.current) {
        return;
      }

      // Ignore selection events that arrive immediately after a node drag stop.
      // This prevents late-arriving selection/click events from opening editors.
      try {
        const last = lastDragStopRef.current;
        if (typeof last === "number" && Date.now() - last < RECENT_DRAG_MS) {
          return;
        }
      } catch (_) {
        // ignore guard failures
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
    },
    [],
  );


  // One-time initialization: emit all subjects once on mount
  useEffect(() => {
    const mgr = getRdfManagerSafe();
    if (mgr && typeof (mgr as any).emitAllSubjects === "function") {
      void (mgr as any).emitAllSubjects("urn:vg:data").catch((e: any) => {
        console.warn("KnowledgeCanvas initial emitAllSubjects failed", e);
      });
    }
  }, [getRdfManagerSafe]);

  useEffect(() => {
    const mgr =
      typeof getRdfManagerSafe === "function" ? getRdfManagerSafe() : undefined;
    if (!mgr) return;

    let mounted = true;
    let debounceTimer: number | null = null;
    mountedRef.current = true;
    // If a mapping run returns an empty result while we still have a previous snapshot,
    // it's likely a transient race. We schedule a single quick retry and skip applying
    // the empty result to avoid clearing the canvas unexpectedly.
    let subjectsCallback:
      | ((
          subs?: string[] | undefined,
          quads?: any[] | undefined,
          snapshot?: any[] | undefined,
          meta?: Record<string, unknown> | null,
        ) => Promise<void>)
      | null = null;

    const pendingQuads: any[] = [];
    const pendingSubjects: Set<string> = new Set<string>();

    const translateQuadsToDiagram = async (quads: any[]) => {
      const state =
        typeof useOntologyStore === "function" &&
        typeof (useOntologyStore as any).getState === "function"
          ? (useOntologyStore as any).getState()
          : null;
      const liveAvailableProps =
        state && Array.isArray(state.availableProperties)
          ? state.availableProperties
          : availablePropertiesRef.current;
      const liveAvailableClasses =
        state && Array.isArray(state.availableClasses)
          ? state.availableClasses
          : availableClassesRef.current;
      const registry = state && Array.isArray(state.namespaceRegistry)
        ? state.namespaceRegistry
        : [];

      const opts = {
        predicateKind:
          typeof predicateClassifierRef.current === "function"
            ? predicateClassifierRef.current
            : predicateClassifier,
        availableProperties: Array.isArray(liveAvailableProps)
          ? liveAvailableProps.slice()
          : [],
        availableClasses: Array.isArray(liveAvailableClasses)
          ? liveAvailableClasses.slice()
          : Array.isArray(availableClassesRef.current)
            ? (availableClassesRef.current as any[]).slice()
            : [],
        registry,
        palette: paletteRef.current as any,
      };

      return mapQuadsWithWorker(quads, opts);
    };

    const waitForNextFrame = async () => {
      await new Promise<void>((resolve) => setTrackedTimeout(resolve, 0));
    };

    const runMapping = async () => {
      if (!mounted) return;
      const hasPendingQuads = Array.isArray(pendingQuads) && pendingQuads.length > 0;
      const layoutOrForceRequested =
        layoutPendingRef.current ||
        forceLayoutNextMappingRef.current ||
        applyRequestedRef.current;
      if (!hasPendingQuads && !layoutOrForceRequested) return;

      mappingInProgressRef.current = true;
      try {
        if (hasPendingQuads) {
          const dataQuads: any[] = pendingQuads.splice(0, pendingQuads.length);
          // Track which subjects were updated so we can reconcile their edges
          const updatedSubjects = new Set(pendingSubjects);
          pendingSubjects.clear();
          const diagram = await translateQuadsToDiagram(dataQuads);
          const mappedNodes: RFNode<NodeData>[] = diagram?.nodes ?? [];
          const mappedEdges: RFEdge<LinkData>[] = diagram?.edges ?? [];
          await applyDiagrammChange(mappedNodes, mappedEdges, updatedSubjects);
        }

        await waitForNextFrame();
        await waitForNextFrame();

        const rfInst = reactFlowInstance?.current ?? null;
        
        const forceLayoutRequested = forceLayoutNextMappingRef.current;
        const applyLayoutRequested = applyRequestedRef.current;
        const autoLayoutRequested =
          !!config?.autoApplyLayout &&
          layoutPendingRef.current &&
          !skipNextAutoLayoutRef.current;

        const shouldRunLayout =
          forceLayoutRequested || applyLayoutRequested || autoLayoutRequested;

        // Always use measured nodes from React Flow - only rendered nodes have measurements
        // The layout pending flag will ensure both views get laid out when they're rendered
        const nodesForLayout =
          rfInst && typeof (rfInst as any).getNodes === "function"
            ? (rfInst as any).getNodes()
            : [];
        
        const edgesForLayout =
          rfInst && typeof (rfInst as any).getEdges === "function"
            ? (rfInst as any).getEdges()
            : [];

        if (skipNextAutoLayoutRef.current && layoutPendingRef.current) {
          layoutPendingRef.current = false;
          lastLayoutMetaRef.current = null;
        }

        if (shouldRunLayout) {
          forceLayoutNextMappingRef.current = false;
          applyRequestedRef.current = false;
          // Don't clear layoutPendingRef yet - keep it active until both views are laid out
          const meta = lastLayoutMetaRef.current;
          lastLayoutMetaRef.current = null;
          try {
            console.debug("[KnowledgeCanvas] layout.run", {
              forceLayoutRequested,
              applyLayoutRequested,
              autoLayoutRequested,
              meta,
            });
          } catch (_) {
            /* ignore logging failures */
          }

          // Layout currently visible nodes
          // Note: We can only layout nodes that are rendered to DOM (React Flow can measure them)
          await doLayout(nodesForLayout as any, edgesForLayout as any, true);

          if (
            forceLayoutRequested &&
            mountedRef.current &&
            rfInst &&
            typeof (rfInst as any).fitView === "function"
          ) {
            await new Promise((resolve) => setTrackedTimeout(resolve, 50));
            await waitForNextFrame();
            try {
              (rfInst as any).fitView({ padding: 0.1 });
            } catch (_) {
              /* ignore fitView failures */
            }
          }
        } else {
          layoutPendingRef.current = false;
          lastLayoutMetaRef.current = null;
        }

        if (skipNextAutoLayoutRef.current) {
          skipNextAutoLayoutRef.current = false;
        }
      } finally {
        mappingInProgressRef.current = false;
      }
    };

    const scheduleRunMapping = () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = setTrackedTimeout(() => {
        runMapping();
        debounceTimer = null;
      }, 100);
    };

    subjectsCallback = async (
      subs?: string[] | undefined,
      quads?: any[] | undefined,
      _snapshot?: any[] | undefined,
      meta?: Record<string, unknown> | null,
    ) => {
      const incomingSubjects = Array.isArray(subs)
        ? subs.map((value) => String(value))
        : [];
      for (const subject of incomingSubjects) {
        pendingSubjects.add(subject);
      }

      if (Array.isArray(quads) && quads.length > 0) {
        for (const quad of quads) {
          pendingQuads.push(quad);
        }
      }

      try {
        console.debug("[KnowledgeCanvas] subjectsCallback.received", {
          subjectCount: incomingSubjects.length,
          quadCount: Array.isArray(quads) ? quads.length : 0,
          meta,
        });
      } catch (_) {
        /* ignore logging failures */
      }

      if (meta && shouldLayoutForMeta(meta)) {
        layoutPendingRef.current = true;
        lastLayoutMetaRef.current = { ...meta };
      } else if (!meta && config?.autoApplyLayout && Array.isArray(quads) && quads.length > 0) {
        layoutPendingRef.current = true;
        lastLayoutMetaRef.current = null;
      }

      scheduleRunMapping();
    };

    // Subscribe to subject-level incremental notifications when available.
    if (typeof mgr.onSubjectsChange === "function" && subjectsCallback) {
      try {
        mgr.onSubjectsChange(subjectsCallback as any);
      } catch (err) {
        console.warn("KnowledgeCanvas subject subscription failed", err);
      }
    } else {
      console.warn(
        "KnowledgeCanvas subject notifications unavailable; falling back to queued mapping",
      );
    }


    // Also subscribe to the generic change counter as a robust fallback for
    // environments where subject-level notifications are not delivered.
    // The onChange handler will request a full store snapshot and schedule a mapping run.
    // NOTE: removed full-store onChange fallback. Canvas now relies solely on
    // subject-level incremental notifications (mgr.onSubjectsChange) and explicit
    // initial snapshot seeding. The full-store fallback caused large mapping runs
    // for localized edits and has been intentionally removed.

    return () => {
      mounted = false;
      mountedRef.current = false;
      if (debounceTimer) {
        try {
          window.clearTimeout(debounceTimer);
        } catch (_) {/* noop */}
        debounceTimer = null;
      }
      // Clear any tracked timeouts scheduled via the component-level tracker
      try {
        clearAllTrackedTimeouts();
      } catch (_) {
        // ignore clearing failures
      }
      if (typeof mgr.offSubjectsChange === "function" && subjectsCallback) {
        try {
          mgr.offSubjectsChange(subjectsCallback as any);
        } catch (_) {/* noop */}
      }
    };
  }, [getRdfManagerSafe, setNodes, setEdges, config]);

  useEffect(() => {
    if (!config?.autoApplyLayout) return;
    if (skipNextAutoLayoutRef.current) {
      return;
    }
    layoutPendingRef.current = false;
    lastLayoutMetaRef.current = null;
    const rfInst = reactFlowInstance?.current ?? null;
    const nodesForLayout =
      rfInst && typeof (rfInst as any).getNodes === "function"
        ? (rfInst as any).getNodes()
        : [];
    const edgesForLayout =
      rfInst && typeof (rfInst as any).getEdges === "function"
        ? (rfInst as any).getEdges()
        : [];
    if (!Array.isArray(nodesForLayout) || nodesForLayout.length === 0) return;
    void doLayout(nodesForLayout as any, edgesForLayout as any, true);
  }, [config?.autoApplyLayout, viewMode, doLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;

    // Expose a helper so other UI components can request that the next mapping run triggers layout.
    (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING = () => {
      forceLayoutNextMappingRef.current = true;
    };

    // Persisted-layout helper: process queued apply layout requests that arrived before mount.
    const pending = (window as any).__VG_APPLY_LAYOUT_PENDING;
    if (Array.isArray(pending) && pending.length > 0) {
      void Promise.resolve().then(async () => {
        for (const req of pending.splice(0)) {
            try {
            await doLayout(nodes, edges, true);
            await new Promise((r) => setTrackedTimeout(r, 200));
            req.resolve(true);
          } catch (err) {
            req.resolve(false);
          }
        }
      });
    }

    (window as any).__VG_APPLY_LAYOUT = async (layoutKey?: string) => {
      try {
        await doLayout(nodes, edges, true);
        await new Promise((r) => setTrackedTimeout(r, 200));
        return true;
      } catch {
        return false;
      }
    };

    // Programmatic export hooks for automated tests
    (window as any).__VG_EXPORT_SVG_FULL = async () => {
      const svgString = await exportViewportSvgMinimal();
      return svgString;
    };

    (window as any).__VG_EXPORT_PNG_FULL = async (scale?: number) => {
      const dataUrl = await exportViewportPngMinimal(scale || 2);
      return dataUrl;
    };

    // Immediate persistence helper: update the React Flow edges state with a new shift value.
    // This is a small runtime helper used by the edge component to ensure the UI observes
    // the updated shift immediately on pointerUp. It intentionally only updates the in-memory
    // React Flow state (does not persist to external stores).
    (window as any).__VG_PERSIST_EDGE_SHIFT = (edgeId: string, shift: number) => {
      try {
        setEdges((prev = []) =>
          (prev || []).map((e) =>
            String(e.id) === String(edgeId)
              ? { ...(e as any), data: { ...(e as any).data, shift } }
              : e,
          ),
        );
      } catch (_) {
        // ignore persistence failures
      }
    };

    // Expose a global setter so other UI components can toggle the canvas loading modal.
    // Use a function reference rather than accessing canvas actions directly to avoid
    // stale closure issues in other modules.
    try {
      (window as any).__VG_SET_LOADING = (loading: boolean, progress = 0, message = "") => {
        try {
          // Prefer the local canvas actions when available
          try {
            if (canvasActions && typeof canvasActions.setLoading === "function") {
              canvasActions.setLoading(Boolean(loading), Number(progress), String(message));
              return;
            }
          } catch (_) {
            // ignore and fall back to no-op
          }
        } catch (_) {
          // ignore
        }
      };
    } catch (_) {
      // ignore global attach failures
    }





    return () => {
      delete (window as any).__VG_KNOWLEDGE_CANVAS_READY;
      delete (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING;
      delete (window as any).__VG_APPLY_LAYOUT;
      delete (window as any).__VG_EXPORT_SVG_FULL;
      delete (window as any).__VG_EXPORT_PNG_FULL;
    };
  }, [nodes, edges, setEdges, setNodes, doLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__VG_INIT_APP = async (opts?: { force?: boolean }) => {
      {
        (window as any).__VG_INIT_APP_RAN = true;

        const cfg = (useAppConfigStore as any).getState
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
        } catch {
          startupUrl = "";
        }

        // If user configured additional ontologies and persisted autoload is enabled,
        // load them immediately on startup (no gates/fallbacks).
        try {
          const disabledList = Array.isArray(cfg?.disabledAdditionalOntologies)
            ? cfg.disabledAdditionalOntologies
            : [];
          const toLoad = (additional || []).filter(
            (u: any) => u && !disabledList.includes(u),
          );
          if (
            Array.isArray(toLoad) &&
            toLoad.length > 0 &&
            typeof loadAdditionalOntologies === "function" &&
            cfg &&
            cfg.persistedAutoload
          ) {
            canvasActions.setLoading(
              true,
              5,
              "Autoloading configured ontologies...",
            );
            // Mark that the next mapping should trigger layout since these are startup loads
            forceLayoutNextMappingRef.current = true;
            await loadAdditionalOntologies(
              toLoad,
              (progress: number, message: string) => {
                canvasActions.setLoading(
                  true,
                  Math.max(5, progress),
                  message,
                );
              },
            );
            loadTriggerRef.current = true;
            loadFitRef.current = true;
            canvasActions.setLoading(false, 0, "");
          } else {
            // preserve previous trigger behavior when autoload not enabled
            if (
              additional &&
              additional.length > 0 &&
              typeof loadAdditionalOntologies === "function"
            ) {
              loadTriggerRef.current = true;
            }
          }
        } catch (err) {
          console.warn("KnowledgeCanvas autoload failed", err);
          // ensure we don't block init on autoload failures
          if (
            additional &&
            additional.length > 0 &&
            typeof loadAdditionalOntologies === "function"
          ) {
            loadTriggerRef.current = true;
          }
        }

        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          canvasActions.setLoading(true, 5, "Loading startup graph...");
          // Mark that the next mapping should trigger a layout since this is a user-requested startup load
          forceLayoutNextMappingRef.current = true;
          try {
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
      }
    };

    if (typeof (window as any).__VG_INIT_APP === "function") {
      (window as any).__VG_INIT_APP({ force: true });
    }

    return () => {
      delete (window as any).__VG_INIT_APP;
    };
  }, [loadKnowledgeGraph]);

  // Viewport persistence: save viewport when it changes
  const onMoveHandler = useCallback((event: any, viewport: { x: number; y: number; zoom: number }) => {
    updateViewportRef(viewport);
    if (viewMode === 'abox') {
      aboxViewportRef.current = viewport;
    } else {
      tboxViewportRef.current = viewport;
    }
  }, [viewMode, updateViewportRef]);

  // Restore viewport when switching views
  useEffect(() => {
    const viewport = viewMode === 'abox' ? aboxViewportRef.current : tboxViewportRef.current;
    const inst = reactFlowInstance.current;
    if (inst && typeof (inst as any).setViewport === 'function') {
      try {
        (inst as any).setViewport(viewport);
      } catch (_) {
        // ignore viewport restore failures
      }
    }
  }, [viewMode]);

  // Trigger layout on view switch if layout is still pending
  // This ensures both ABox and TBox views get laid out after data loads
  useEffect(() => {
    if (layoutPendingRef.current) {
      const rfInst = reactFlowInstance.current;
      if (rfInst && typeof (rfInst as any).getNodes === 'function') {
        const visibleNodes = (rfInst as any).getNodes();
        const visibleEdges = (rfInst as any).getEdges?.() || [];
        if (visibleNodes.length > 0) {
          // Give React Flow time to render and measure the newly visible nodes
          setTrackedTimeout(() => {
            doLayout(visibleNodes, visibleEdges, true).then(() => {
              // Track that this view has been laid out
              layoutedViewsRef.current.add(viewMode);
              
              // Only clear the pending flag after both views have been laid out
              if (layoutedViewsRef.current.has('abox') && layoutedViewsRef.current.has('tbox')) {
                layoutPendingRef.current = false;
                layoutedViewsRef.current.clear();
              }
            }).catch((err) => {
              console.warn('Layout failed on view switch:', err);
              // On error, still clear to avoid getting stuck
              layoutPendingRef.current = false;
              layoutedViewsRef.current.clear();
            });
          }, 100);
        }
      }
    }
  }, [viewMode, doLayout, setTrackedTimeout]);

  const triggerReasoningStrict = useCallback(
    async (_ns: RFNode<NodeData>[], _es: RFEdge<LinkData>[], force = false) => {
      if (!settings?.autoReasoning && !force) return;
      if (reasoningInFlightRef.current) return;
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (!mgr || typeof (mgr as any).runReasoning !== "function") return;

      reasoningInFlightRef.current = true;
      setIsReasoning(true);
      const runStart = Date.now();

      try {
        // Get configured rulesets from app config
        const cfg = useAppConfigStore.getState().config;
        const rulesets = Array.isArray(cfg?.reasoningRulesets) ? cfg.reasoningRulesets : [];
        
        const result: ReasoningResult | null = await (mgr as any).runReasoning({ rulesets });
        if (result) {
          setCurrentReasoning(result);
          setReasoningHistory((prev) => [result, ...prev].slice(0, 10));
        }
      } catch (err) {
        console.error("[VG_DEBUG] runReasoning failed", err);
        const errorResult: ReasoningResult = {
          id: `reasoning-error-${runStart.toString(36)}`,
          timestamp: runStart,
          status: "error",
          errors: [
            {
              message: err instanceof Error ? err.message : String(err),
              rule: "reasoning",
              severity: "error",
            },
          ],
          warnings: [],
          inferences: [],
          meta: { usedReasoner: false },
        };
        setCurrentReasoning(errorResult);
        setReasoningHistory((prev) => [errorResult, ...prev].slice(0, 10));
      } finally {
        reasoningInFlightRef.current = false;
        setIsReasoning(false);
      }
    },
    [settings?.autoReasoning, getRdfManagerRef],
  );

  // Sync reasoning results into node/edge data so
  // the UI components (CustomOntologyNode / FloatingEdge) can render borders and
  // tooltip messages. This effect listens for updates to the current reasoning
  // result and applies targeted updates only to referenced nodes/edges.
  useEffect(() => {
    if (!currentReasoning) return;

    const result = currentReasoning;
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];

    const nodeErrMap = new Map<string, string[]>();
    const nodeWarnMap = new Map<string, string[]>();
    const edgeErrMap = new Map<string, string[]>();
    const edgeWarnMap = new Map<string, string[]>();

    for (const er of errors) {
      {
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
      }
    }

    for (const w of warnings) {
      {
        if (w && w.nodeId) {
          const a = nodeWarnMap.get(String(w.nodeId)) || [];
          a.push(String(w.message || w));
          nodeWarnMap.set(String(w.nodeId), a);
        }
        if (w && w.edgeId) {
          const a = edgeErrMap.get(String(w.edgeId)) || [];
          a.push(String(w.message || w));
          edgeErrMap.set(String(w.edgeId), a);
        }
      }
    }

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
        } catch {
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
        } catch {
          return e;
        }
      }),
    );

    // After applying reasoning-specific updates, trigger a subject-level emission
    // for all known nodes so consumers (mapper/canvas) receive authoritative quads
    // even if the reasoner wrote inferred triples directly into the raw store.
    const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
    if (mgr && typeof (mgr as any).triggerSubjectUpdate === "function") {
      const allNodeIris = (nodes || []).map((n) =>
        n && n.data && (n.data as any).iri
          ? String((n.data as any).iri)
          : String(n.id),
      );
      // Only trigger the subject update when the canvas has fully initialized.
      // This prevents premature emissions during test renders before providers
      // (e.g. TooltipProvider) are mounted, which would cause provider-required
      // components to throw.
      if (
        typeof window !== "undefined" &&
        (window as any).__VG_KNOWLEDGE_CANVAS_READY
      ) {
        // Fire-and-forget but catch errors to avoid blocking UI
        (mgr as any).triggerSubjectUpdate(allNodeIris).catch((err: any) => {
          console.warn("KnowledgeCanvas triggerSubjectUpdate failed", err);
        });
      } else {
        console.warn("KnowledgeCanvas skipped triggerSubjectUpdate because canvas is not ready");
      }
    } else {
      console.warn("KnowledgeCanvas triggerSubjectUpdate unavailable");
    }
  }, [currentReasoning, setNodes, setEdges]);

  const onNodeDoubleClickStrict = useCallback(
    (event: any, node: any) => {
      event?.stopPropagation && event.stopPropagation();

      // Short suppress guard to avoid selection-change races opening other editors.
      suppressSelectionRef.current = true;
      setTrackedTimeout(() => {
        suppressSelectionRef.current = false;
      }, 0);

      // Defensive: if we just finished a drag, do not open the editor.
      try {
        const last = lastDragStopRef.current;
        if (typeof last === "number" && Date.now() - last < RECENT_DRAG_MS) {
          return;
        }
      } catch (_) {
        // ignore guard failures
      }

      // Open the node editor on double-click without mutating React Flow node state.
      try {
        setSelectedNodePayload(node || null);
        setNodeEditorOpen(true);
      } catch (_) {
        // ignore UI open failures
      }
    },
    [],
  );

  // Record pointer-down snapshot: whether the node was selected at the time the user pressed.
  const onNodeMouseDown = useCallback((event: any, node: any) => {
    try {
      const pid =
        (event && event.pointerId) ||
        (event && event.nativeEvent && (event.nativeEvent as any).pointerId) ||
        "mouse";
      lastPointerDownRef.current = {
        pointerId: pid,
        nodeId: node ? String(node.id) : null,
        wasSelectedAtDown: !!(node && (node as any).selected),
      };
    } catch (_) {
      // ignore
      lastPointerDownRef.current = null;
    }
  }, []);

  const onNodeClickStrict = useCallback((event: any, node: any) => {
    // Respect the suppress guard used for drag/double-click races.
    if (suppressSelectionRef.current) return;

    // If a drag just finished recently, ignore this click as it may be a
    // synthetic/late click that should not open the editor.
    try {
      const last = lastDragStopRef.current;
      if (typeof last === "number" && Date.now() - last < RECENT_DRAG_MS) {
        return;
      }
    } catch (_) {
      // ignore guard failures
    }

    try {
      const pid =
        (event && event.pointerId) ||
        (event && event.nativeEvent && (event.nativeEvent as any).pointerId) ||
        "mouse";

      // Check pointer-down snapshot. If the pointerdown happened on this node and the node
      // was already selected at down AND no drag was started for this pointer, treat as a
      // deliberate click-to-open. If the pointerdown shows the node was not selected at down,
      // then this click was the selection action and should not open the editor.
      const snap = lastPointerDownRef.current;
      if (snap && String(snap.nodeId) === String(node && node.id)) {
        const dragStartedForPointer = dragStartedPointerRef.current === snap.pointerId;
        // Clear snapshot immediately
        lastPointerDownRef.current = null;

        if (snap.wasSelectedAtDown && !dragStartedForPointer) {
          // Deliberate click on an already-selected node -> open editor
          setSelectedNodePayload(node || null);
          setNodeEditorOpen(true);
        }
        return;
      }
    } catch (_) {
      // ignore and fallback
      lastPointerDownRef.current = null;
    }

    // Fallback: preserve previous behavior (open only when node already selected)
    try {
      if (node && (node as any).selected) {
        setSelectedNodePayload(node || null);
        setNodeEditorOpen(true);
      }
    } catch (_) {
      // ignore
    }
  }, []);

  // Drag performance metrics: simple measurement of drag event frequency and derived FPS.
  // Enabled only when the global debugAll flag is active in app config to avoid overhead in production.
  const dragMetricsRef = useRef<{
    start?: number;
    last?: number;
    count: number;
    intervals: number[];
  }>({ count: 0, intervals: [] });

  const isDebugMetricsEnabled = () => {
    try {
      return !!(config && (config as any).debugAll);
    } catch {
      return false;
    }
  };

  const onNodeDragStart = useCallback(
    (event: any, node: any) => {
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();

      // Only update debug metrics when enabled (keep metrics isolated).
      if (isDebugMetricsEnabled()) {
        dragMetricsRef.current.start = now;
        dragMetricsRef.current.last = now;
        dragMetricsRef.current.count = 0;
        dragMetricsRef.current.intervals = [];
        {
          (window as any).__VG_DRAG_METRICS_ACTIVE = true;
        }
      }

      // Mark drag started for the pointer associated with this event so click-open is cancelled.
      try {
        const pid =
          (event && event.pointerId) ||
          (event && event.nativeEvent && (event.nativeEvent as any).pointerId) ||
          lastPointerDownRef.current?.pointerId ||
          "mouse";
        dragStartedPointerRef.current = pid;
      } catch (_) {
        // ignore
      }

      // Install a one-shot capture-phase handler for pointerup + mouseup to intercept
      // the release event fired when the user releases the pointer after dragging.
      // This prevents the native release event from reaching downstream click/selection
      // handlers that may open editors due to timing races. We register both pointerup
      // and mouseup for broader compatibility. Handlers are registered with { once: true, capture: true }.
      try {
        const handler = (ev: Event) => {
          try {
            const target = (ev as any).target as Node | null;
            const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
            if (viewport && target && viewport.contains(target as Node)) {
              try {
                // Stop propagation as early as possible (capture phase) so downstream handlers do not receive this release.
                if (typeof (ev as any).stopImmediatePropagation === "function") {
                  (ev as any).stopImmediatePropagation();
                }
              } catch (_) {/* noop */}
              try {
                if (typeof (ev as any).stopPropagation === "function") (ev as any).stopPropagation();
              } catch (_) {/* noop */}
              // avoid preventDefault to not interfere with native behaviors
            }
          } catch (_) {
            // ignore
          }
        };

        nodeDragMouseUpHandlerRef.current = handler;

        try {
          // Modern addEventListener with options (capture + once)
          window.addEventListener("pointerup", handler as any, { capture: true, once: true } as any);
          window.addEventListener("mouseup", handler as any, { capture: true, once: true } as any);
        } catch (_) {
          // Fallback older signature (capture boolean)
          try {
            (window as any).addEventListener("pointerup", handler as any, true);
          } catch (_) {/* noop */}
          try {
            (window as any).addEventListener("mouseup", handler as any, true);
          } catch (_) {/* noop */}
        }
      } catch (_) {
        // ignore registration failures
      }
    },
    [config],
  );

  const onNodeDrag = useCallback(
    (event: any, node: any) => {
      if (!isDebugMetricsEnabled()) return;
      const now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      const last = dragMetricsRef.current.last || now;
      const delta = now - last;
      dragMetricsRef.current.intervals.push(delta);
      dragMetricsRef.current.last = now;
      dragMetricsRef.current.count = (dragMetricsRef.current.count || 0) + 1;
    },
    [config],
  );

  const onNodeDragStop = useCallback(
    (event: any, node: any) => {
      // Debug metrics (unchanged)
      try {
        if (isDebugMetricsEnabled()) {
          const intervals = dragMetricsRef.current.intervals || [];
          (window as any).__VG_DRAG_METRICS_ACTIVE = false;
          if (intervals.length > 0) {
            const sum = intervals.reduce((a, b) => a + b, 0);
            const avg = sum / intervals.length;
            const fps = avg > 0 ? 1000 / avg : 0;
            const count = dragMetricsRef.current.count || intervals.length;
            (window as any).__VG_LAST_DRAG_METRICS = {
              count,
              avgMs: Number(avg.toFixed(2)),
              fps: Math.round(fps),
            };
          }
        }
      } catch (_) {
        /* ignore debug errors */
      }

      // Unselect-on-drag-stop disabled — rely on the RECENT_DRAG_MS guard to suppress
      // late selection/click events instead. If you want selection to be re-applied
      // after a deliberate click, we can add that behavior separately.

      // Record last drag stop timestamp to suppress the click that often follows dragend.
      try {
        lastDragStopRef.current = Date.now();

        // Also clear/consume the dragStarted marker for the pointer related to this event.
        try {
          const pid =
            (event && event.pointerId) ||
            (event && event.nativeEvent && (event.nativeEvent as any).pointerId) ||
            lastPointerDownRef.current?.pointerId ||
            "mouse";
          if (dragStartedPointerRef.current === pid) dragStartedPointerRef.current = null;
        } catch (_) {
          // ignore
        }

        // Install a one-shot capture-phase click handler that discards the next click
        // event if it arrives immediately after dragstop. This defends against the
        // browser dispatching a synthetic click after a drag sequence.
        const stopClick = (ev: Event) => {
          try {
            const last = lastDragStopRef.current;
            if (typeof last === "number" && Date.now() - last < 500) {
              try {
                if (typeof (ev as any).stopImmediatePropagation === "function")
                  (ev as any).stopImmediatePropagation();
              } catch (_) {/* noop */}
              try {
                if (typeof (ev as any).stopPropagation === "function")
                  (ev as any).stopPropagation();
              } catch (_) {/* noop */}
              try {
                if (typeof (ev as any).preventDefault === "function")
                  (ev as any).preventDefault();
              } catch (_) {/* noop */}
            }
          } catch (_) {
            // ignore
          }
        };
        try {
          window.addEventListener("click", stopClick as any, { capture: true, once: true } as any);
        } catch (_) {
          try {
            (window as any).addEventListener("click", stopClick as any, true);
          } catch (_) {/* noop */}
        }
      } catch (_) {
        // ignore
      }

      // Remove any installed capture-phase handlers (defensive)
      try {
        const h = nodeDragMouseUpHandlerRef.current;
        if (h) {
          try {
            window.removeEventListener("pointerup", h, true);
          } catch (_) {
            try {
              (window as any).removeEventListener("pointerup", h as any, { capture: true } as any);
            } catch (_) {/* noop */}
          }
          try {
            window.removeEventListener("mouseup", h as any, true);
          } catch (_) {
            try {
              (window as any).removeEventListener("mouseup", h as any, { capture: true } as any);
            } catch (_) {/* noop */}
          }
          nodeDragMouseUpHandlerRef.current = null;
        }
      } catch (_) {
        // ignore
      }

      // Defensive stop on the synthetic React event to prevent any propagation that might
      // trigger selection/click handlers when the drag ends.
      try {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (event && event.nativeEvent && typeof event.nativeEvent.stopImmediatePropagation === "function") {
          event.nativeEvent.stopImmediatePropagation();
        }
      } catch (_) {
        // ignore
      }

      // Prevent the immediate selection-change/click handlers from opening editors
      // when the user finishes dragging a node. This mirrors the double-click guard
      // and avoids the editor opening on mouse-up after drag.
      suppressSelectionRef.current = true;
      setTrackedTimeout(() => {
        suppressSelectionRef.current = false;
      }, 0);

      // Force React Flow to recalculate edge paths after node movement
      try {
        const movedId = node && node.id ? String(node.id) : null;
        if (movedId) {

          setEdges((prev = []) => {
            // Identify affected edges and replace them to force React Flow to re-render them.
            const affected = new Set<string>();
            for (const e of prev || []) {
              try {
                if (String(e.source) === movedId || String(e.target) === movedId) {
                  affected.add(String(e.id));
                }
              } catch {
                // ignore per-edge
              }
            }
            if (affected.size === 0) return prev;
            const newEdges = (prev || []).map((e) =>
              affected.has(String(e.id)) ? { ...e } : e,
            );

            // Optional notification hook
            try {
              const affectedArr = Array.from(affected);
              if (typeof (window as any).__VG_ON_EDGES_NODE_MOVE === "function") {
                (window as any).__VG_ON_EDGES_NODE_MOVE([movedId], affectedArr);
              }
            } catch (_) {
              // ignore
            }

            return newEdges;
          });
        }
      } catch (_) {
        // ignore
      }
    },
    [setEdges, config],
  );


  const onEdgeDoubleClickStrict = useCallback(
    (event: any, edge: any) => {
      // Mirror node double-click: stop propagation and use a short suppress guard.
      event?.stopPropagation && event.stopPropagation();

      suppressSelectionRef.current = true;
      setTrackedTimeout(() => {
        suppressSelectionRef.current = false;
      }, 0);

      const srcId =
        edge.source || edge.from || (edge.data && edge.data.from) || "";
      const tgtId = edge.target || edge.to || (edge.data && edge.data.to) || "";

      const edgeId = edge.id || edge.key || `${srcId}-${tgtId}`;

      linkSourceRef.current = nodes.find((n) => String(n.id) === String(srcId))?.data as any;
      linkTargetRef.current = nodes.find((n) => String(n.id) === String(tgtId))?.data as any;

      const payload = {
        id: edgeId,
        key: edgeId,
        source: srcId,
        target: tgtId,
        data: edge.data || {},
        operation: "edit",
      };

      // Determine selection from current RF state (edges array).
      const existing = (edges || []).find((ee) => String(ee.id) === String(edgeId));
      const wasSelected = !!(existing && ((existing as any).selected as boolean));

      setSelectedLinkPayload(payload);
      if (wasSelected) {
        setLinkEditorOpen(true);
      } else {
        // Mark edge selected via RF state so selected prop flows to edge component.
        try {
          setEdges((prev = []) =>
            (prev || []).map((e) => ({ ...e, selected: String(e.id) === String(edgeId) })),
          );
        } catch (_) {
          // ignore
        }
      }
    },
    [nodes, edges, setEdges],
  );

  const onConnectStrict = useCallback(
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
      const sourceIsTBox = !!(
        sourceNode.data && (sourceNode.data as any).isTBox
      );
      const targetIsTBox = !!(
        targetNode.data && (targetNode.data as any).isTBox
      );
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
          const domainMatch =
            domain.length === 0 || !srcClass || domain.includes(srcClass);
          const rangeMatch =
            range.length === 0 || !tgtClass || range.includes(tgtClass);
          return domainMatch && rangeMatch;
        });

        predCandidate = compatible
          ? compatible.iri || (compatible as any).key || ""
          : availableProperties[0].iri || (availableProperties[0] as any).key;
      }

      const predFallback =
        predCandidate || "http://www.w3.org/2002/07/owl#topObjectProperty";
      const predUriToUse = predCandidate || predFallback;

      let predLabel = "";
      const mgrLocal = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgrLocal && predUriToUse) predLabel = String(predUriToUse);

      linkSourceRef.current = sourceNode ? (sourceNode.data as any) : null;
      linkTargetRef.current = targetNode ? (targetNode.data as any) : null;

      // Generate a deterministic edge id based on subject/predicate/object only.
      // Do NOT include handle ids in the id — keep the mapping canonical to IRIs.
      const baseEdgeId = generateEdgeId(
        String(claimedSource),
        String(claimedTarget),
        String(predUriToUse || ""),
      );
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
    },
    [nodes, availableProperties, loadedOntologies],
  );

  const handleSaveNodeProperties = useCallback(
    async (_properties: any[]) => {
      // No-op here: NodePropertyEditor is the authoritative writer and calls mgr.applyBatch.
      // The RDF manager's subject-level notifications will drive mapping updates for the canvas.
      // Keep this callback in place for the onSave contract but do not perform any direct writes
      // or local state coercion here to avoid duplicated/inconsistent updates.
      return;
    },
    [selectedNodePayload],
  );

  const handleSaveLinkProperty = useCallback(
    async (propertyUri: string, label: string) => {
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
      if (!mgr || !selected) return;

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
      if (!subjIri || !objIri) return;

      const expand = (value: string | undefined | null) => {
        if (!value) return "";
        if (typeof mgr.expandPrefix === "function") {
          try {
            const expanded = mgr.expandPrefix(value);
            if (expanded) return String(expanded);
          } catch (_) {
            /* ignore expansion failures */
          }
        }
        return String(value);
      };

      const oldPredRaw =
        (selected as any).data?.propertyUri ||
        (selected as any).data?.propertyType ||
        (selected as any).propertyUri ||
        (selected as any).propertyType ||
        "";

      const previousPredicate = oldPredRaw ? expand(String(oldPredRaw)) : "";
      const nextPredicate = expand(propertyUri);
      const graphName = "urn:vg:data";

      const removes: Array<{ subject: string; predicate: string; object: string }> = [];
      const adds: Array<{ subject: string; predicate: string; object: string }> = [];

      if (previousPredicate && previousPredicate !== nextPredicate) {
        removes.push({
          subject: String(subjIri),
          predicate: previousPredicate,
          object: String(objIri),
        });
      }

      if (!previousPredicate || previousPredicate !== nextPredicate) {
        adds.push({
          subject: String(subjIri),
          predicate: nextPredicate,
          object: String(objIri),
        });
      }

      if (removes.length === 0 && adds.length === 0) return;

      if (typeof mgr.applyBatch === "function") {
        try {
          await mgr.applyBatch({ removes, adds }, graphName);
          return;
        } catch (err) {
          console.error("[KnowledgeCanvas] applyBatch failed for link property update", err);
        }
      }

      if (removes.length && typeof mgr.removeTriple === "function") {
        for (const rem of removes) {
          try { mgr.removeTriple(rem.subject, rem.predicate, rem.object, graphName); } catch (_) { /* ignore */ }
        }
      }
      if (adds.length && typeof mgr.addTriple === "function") {
        for (const add of adds) {
          try { mgr.addTriple(add.subject, add.predicate, add.object, graphName); } catch (_) { /* ignore */ }
        }
      }
    },
    [selectedLinkPayload, setEdges],
  );

  const memoNodeTypes = useMemo(
    () => ({ ontology: OntologyNode }),
    [OntologyNode],
  );
  const memoEdgeTypes = useMemo(
    () => ({ floating: ObjectPropertyEdge }),
    [ObjectPropertyEdge],
  );
  const memoConnectionLine = useMemo(
    () => FloatingConnectionLine,
    [FloatingConnectionLine],
  );

  // Filter nodes by viewMode - only show nodes matching the current view
  const filteredNodes = useMemo(() => {
    return (nodes || []).filter((n) => {
      try {
        const isTBox = !!(n.data && (n.data as any).isTBox);
        const visibleFlag =
          n.data && typeof (n.data as any).visible === "boolean"
            ? (n.data as any).visible
            : true;
        if (!visibleFlag) return false;
        return viewMode === "tbox" ? isTBox : !isTBox;
      } catch {
        return true;
      }
    });
  }, [nodes, viewMode]);

  // Filter edges - only show edges where both endpoints are in the current view
  const filteredEdges = useMemo(() => {
    const nodeIds = new Set(filteredNodes.map((n) => String(n.id)));
    return (edges || []).filter((e) => {
      try {
        return nodeIds.has(String(e.source)) && nodeIds.has(String(e.target));
      } catch {
        return false;
      }
    });
  }, [edges, filteredNodes]);

  const safeNodes = useMemo(() => {
    return (filteredNodes || []).map((n) => {
      if (
        !n ||
        !n.position ||
        typeof (n.position as any).x !== "number" ||
        typeof (n.position as any).y !== "number"
      ) {
        return { ...(n || {}), position: { x: 0, y: 0 } } as RFNode<NodeData>;
      }
      return n;
    });
  }, [filteredNodes]);

  // Memoize edges to provide a stable reference into ReactFlow and avoid
  // unnecessary reprocessing when edge list content hasn't materially changed.
  // Ensure edges are selectable by default so React Flow's native selection can be used.
  const memoEdges = useMemo(() => {
    try {
      return (edges || []).map((e: any) => ({
        ...(e || {}),
        selectable:
          typeof (e as any)?.selectable === "boolean"
            ? (e as any).selectable
            : true,
      }));
    } catch {
      return edges;
    }
  }, [
    (edges || []).length,
    (edges || [])
      .map((e: any) =>
        String(e.id) +
        ":" +
        String((e && e.data && (e.data.label || "")) || "") +
        ":" +
        String((e && e.data && (e.data.propertyUri || "")) || "") +
        ":" +
        String((e && e.data && (e.data.shift || "")) || "")
      )
      .join(","),
  ]);

  // Use React Flow native change handlers so RF manages runtime metadata correctly.
  const onNodesChange = useCallback(
    (changes: any) =>
      setNodes((nodesSnapshot) => applyNodeChanges(changes, nodesSnapshot)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: any) =>
      setEdges((edgesSnapshot) => applyEdgeChanges(changes, edgesSnapshot)),
    [setEdges],
  );

  // Centralized helper using optimized chunked processing for large updates
  const applyDiagrammChange = useCallback(
    async (
      incomingNodes?: RFNode<NodeData>[],
      incomingEdges?: RFEdge<LinkData>[],
      updatedSubjects?: Set<string>,
    ) => {
      const nodesList = Array.isArray(incomingNodes) ? incomingNodes : [];
      const edgesList = Array.isArray(incomingEdges) ? incomingEdges : [];

      // Use optimized smart helper (auto-chunks large updates)
      // Create yield function that returns a Promise
      const yieldFn = (ms: number) => new Promise<void>((resolve) => setTrackedTimeout(resolve, ms));

      // Pass suppressLayout function to helper
      const suppressLayoutFn = (suppress: boolean) => {
        suppressLayoutDuringChunksRef.current = suppress;
      };

      const wasChunked = await applyDiagramChangeSmart(
        nodesList,
        edgesList,
        updatedSubjects,
        setNodes,
        setEdges,
        canvasActions,
        yieldFn,
        suppressLayoutFn,
      );

      // After chunked update completes, trigger layout once if it was pending
      if (wasChunked && (layoutPendingRef.current || forceLayoutNextMappingRef.current)) {
        // Yield to allow React Flow to process all node changes first
        await new Promise<void>((resolve) => setTrackedTimeout(resolve, 50));
      }
    },
    [setNodes, setEdges, canvasActions, setTrackedTimeout],
  );

  // Legacy implementation kept below for reference - can be removed after testing
  const applyDiagrammChangeLegacy = useCallback(
    async (
      incomingNodes?: RFNode<NodeData>[],
      incomingEdges?: RFEdge<LinkData>[],
      updatedSubjects?: Set<string>,
    ) => {
      const nodesList = Array.isArray(incomingNodes) ? incomingNodes : [];
      const edgesList = Array.isArray(incomingEdges) ? incomingEdges : [];

      if (nodesList.length > 0 || edgesList.length > 0) {
        const addedNodeIds: string[] = [];
        
        setNodes((prev = []) => {
          const current = prev || [];
          const currentById = new Map(
            current.map((node: any) => [String(node.id), node]),
          );
          const incomingById = new Map(
            nodesList.map((node: any) => [String(node.id), node]),
          );
          const knownIds = new Set<string>([
            ...currentById.keys(),
            ...incomingById.keys(),
          ]);
          const changes: any[] = [];

          const mergeData = (existingData: any, incomingData: any) => {
            const merged = { ...(existingData ?? {}) };
            if (!incomingData || typeof incomingData !== 'object') return merged;
            for (const key of Object.keys(incomingData)) {
              const value = (incomingData as any)[key];
              if (Array.isArray(value)) {
                if (value.length > 0) merged[key] = value;
              } else if (
                value !== null &&
                value !== undefined &&
                !(typeof value === 'string' && value.trim() === '')
              ) {
                merged[key] = value;
              }
            }
            return merged;
          };

          for (const node of nodesList) {
            const id = String(node.id);
            const existing = currentById.get(id);
            if (existing) {
              const mergedNode = {
                ...existing,
                type: (node as any).type ?? existing.type,
                position:
                  existing.position ??
                  (node as any).position ??
                  { x: 0, y: 0 },
                data: mergeData(existing.data, (node as any).data),
              };
              
              // Memory optimization: only create change if data actually changed
              // This prevents unnecessary React Flow diffs and re-renders
              const dataChanged = mergedNode.data !== existing.data;
              if (dataChanged) {
                delete (mergedNode as any).selected;
                changes.push({ id, type: 'replace', item: mergedNode });
              }
              addedNodeIds.push(id);
            } else {
              const newNode = {
                ...(node as any),
                position: (node as any).position ?? { x: 0, y: 0 },
              };
              delete (newNode as any).selected;
              changes.push({ type: 'add', item: newNode });
              knownIds.add(String(newNode.id));
              addedNodeIds.push(String(newNode.id));
            }
          }

          const ensurePlaceholder = (id: string) => {
            if (!id || knownIds.has(id)) return;
            knownIds.add(id);
            changes.push({
              type: 'add',
              item: {
                id,
                type: 'ontology',
                position: { x: 0, y: 0 },
                data: {
                  key: id,
                  iri: id,
                  rdfTypes: [],
                  literalProperties: [],
                  annotationProperties: [],
                  inferredProperties: [],
                  visible: true,
                },
              },
            });
            addedNodeIds.push(id);
          };

          for (const edge of edgesList) {
            ensurePlaceholder(String(edge?.source ?? ''));
            ensurePlaceholder(String(edge?.target ?? ''));
          }

          return applyNodeChanges(changes as any, current);
        });

        // React Flow measurement is now handled by useUpdateNodeInternals hook
        // inside RDFNode component, which triggers when handles visibility changes
      }

      // Process edges with smart reconciliation:
      // - Add/replace incoming edges
      // - Remove edges touching updated subjects that aren't in the new output
      setEdges((prev = []) => {
        const current = prev || [];
        const currentById = new Map(
          current.map((edge: any) => [String(edge.id), edge]),
        );
        const incomingIds = new Set(edgesList.map((e) => String(e.id)));
        const changes: any[] = [];

        // Add or replace incoming edges
        for (const edge of edgesList) {
          const id = String(edge.id);
          const existing = currentById.get(id);
          const mergedEdge = {
            ...(existing ?? {}),
            ...(edge as any),
            data: {
              ...(existing?.data ?? {}),
              ...((edge as any).data ?? {}),
            },
          };
          if (existing) {
            changes.push({ id, type: 'replace', item: mergedEdge });
          } else {
            changes.push({ type: 'add', item: mergedEdge });
          }
        }

        // Remove edges FROM updated subjects that aren't in the mapper output
        // Note: We only check if SOURCE is updated, not target, because the mapper
        // only returns outgoing edges from the subjects being updated. Checking target
        // would incorrectly remove incoming edges from other (non-updated) subjects.
        if (updatedSubjects && updatedSubjects.size > 0) {
          for (const existing of current) {
            const id = String(existing.id);
            const source = String(existing.source);

            // Only remove if this edge's source was updated AND the edge isn't in new output
            const sourceWasUpdated = updatedSubjects.has(source);
            if (sourceWasUpdated && !incomingIds.has(id)) {
              changes.push({ id, type: 'remove' });
            }
          }
        }

        // Apply React Flow changes to get the new edge state
        const newEdgeState = applyEdgeChanges(changes as any, current);

        // Now apply bidirectional offsets to the complete edge set
        // This must happen after reconciliation so we see the full picture
        const BASE_BIDIRECTIONAL_OFFSET = 40;
        const PARALLEL_EDGE_SHIFT_STEP = 60;

        const indexToShift = (index: number) => {
          if (index === 0) return 0;
          const magnitude = Math.ceil(index / 2);
          const direction = index % 2 === 1 ? 1 : -1;
          return direction * magnitude * PARALLEL_EDGE_SHIFT_STEP;
        };

        // Group edges by unordered node pairs to detect bidirectional relationships
        const bidirectionalGroups = new Map<string, typeof newEdgeState>();

        for (const edge of newEdgeState) {
          if (!edge) continue;
          const source = String(edge.source);
          const target = String(edge.target);

          // Create canonical key (alphabetically sorted) to group A→B with B→A
          const canonicalKey = source < target
            ? `${source}||${target}`
            : `${target}||${source}`;

          if (!bidirectionalGroups.has(canonicalKey)) {
            bidirectionalGroups.set(canonicalKey, []);
          }
          bidirectionalGroups.get(canonicalKey)!.push(edge);
        }

        // Process each bidirectional group and apply offsets
        const edgesWithOffsets = newEdgeState.map((edge): RFEdge<LinkData> => {
          const source = String(edge.source);
          const target = String(edge.target);
          const canonicalKey = source < target
            ? `${source}||${target}`
            : `${target}||${source}`;

          const pairEdges = bidirectionalGroups.get(canonicalKey) || [];

          // Split edges by direction
          const directions = new Map<string, typeof pairEdges>();
          for (const e of pairEdges) {
            const dirKey = `${e.source}→${e.target}`;
            if (!directions.has(dirKey)) {
              directions.set(dirKey, []);
            }
            directions.get(dirKey)!.push(e);
          }

          // Get the base shift from mapper (parallel edge offset)
          const baseShift = (edge.data as any)?.shift ?? 0;

          if (directions.size === 2) {
            // Bidirectional case: separate opposite directions into their own ranges
            const dirKey = `${edge.source}→${edge.target}`;
            const dirEdges = directions.get(dirKey) || [];

            // Sort edges to determine index
            const sortedDirEdges = [...dirEdges].sort((a, b) =>
              String(a.id).localeCompare(String(b.id))
            );
            const edgeIndex = sortedDirEdges.findIndex((e) => String(e.id) === String(edge.id));

            // Determine which direction this is (first or second)
            const directionKeys = Array.from(directions.keys()).sort();
            const directionIndex = directionKeys.indexOf(dirKey);

            // Both directions use positive offsets (right side of edge direction)
            // Direction 0: +40, +100, +160, +220, +280...
            // Direction 1: +40, +100, +160, +220, +280, +340...
            const baseOffset = BASE_BIDIRECTIONAL_OFFSET;

            // Apply parallel spacing WITHIN the direction
            // Multiple edges in same direction spread out: 0, 60, 120, 180...
            const parallelOffset = edgeIndex * PARALLEL_EDGE_SHIFT_STEP;

            // Combine: base offset + parallel spacing (always positive)
            const finalShift = baseOffset + parallelOffset;

            return {
              ...edge,
              data: {
                ...edge.data,
                shift: finalShift,
              },
            } as RFEdge<LinkData>;
          }

          // Unidirectional: keep the shift from mapper
          return edge;
        });

        return edgesWithOffsets;
      });

      await new Promise<void>((resolve) => {
        setTrackedTimeout(resolve, 0);
      });

      // Debug: Log first node's measurements after applying changes
      try {
        const firstNode = nodes[0];
        if (firstNode) {
          console.log('[Canvas Debug] First node after mapping:', {
            id: firstNode.id,
            __rf: (firstNode as any).__rf,
            width: (firstNode as any).__rf?.width,
            height: (firstNode as any).__rf?.height
          });
        }
      } catch (err) {
        console.warn('[Canvas Debug] Failed to log first node after mapping', err);
      }
    },
    [setNodes, setEdges, setTrackedTimeout, nodes],
  );

  return (
    <div className="h-lvh h-lvw h-screen bg-canvas-bg relative">
      <CanvasToolbar
        onAddNode={(payload: any) => {
          let normalizedUri = String(
            payload && (payload.iri || payload) ? payload.iri || payload : "",
          );
          if (!/^https?:\/\//i.test(normalizedUri)) {
            const mgr =
              typeof getRdfManager === "function" ? getRdfManager() : undefined;
            if (mgr && typeof (mgr as any).expandPrefix === "function") {
              const expanded = (mgr as any).expandPrefix(normalizedUri);
              if (expanded && typeof expanded === "string") {
                normalizedUri = expanded;
              }
            }
          }

          if (!/^https?:\/\//i.test(normalizedUri)) {
            try {
              const registry = getNamespaceRegistry();
              const expanded = expandPrefixed(normalizedUri, registry);
              if (expanded && /^https?:\/\//i.test(expanded)) {
                normalizedUri = expanded;
              }
            } catch (_) {
              /* ignore registry expansion failures */
            }
          }

          if (!normalizedUri || !/^https?:\/\//i.test(normalizedUri)) return;

          const id = String(normalizedUri);

          const startPos = computeCanvasCenter();
          skipNextAutoLayoutRef.current = true;

          // Preserve any rdfTypes / classCandidate / annotationProperties passed from the editor payload
          const rdfTypes = Array.isArray(payload && payload.rdfTypes) ? payload.rdfTypes.slice() : (payload && payload.classCandidate ? [payload.classCandidate] : []);
          const namespace = payload?.namespace ? String(payload.namespace) : "";

          const displayLabel = (() => {
            try {
              const pref = toPrefixed(normalizedUri, registrySnapshot as any);
              return pref && pref.trim().length > 0 ? pref : normalizedUri;
            } catch (_) {
              return normalizedUri;
            }
          })();

          setNodes((nds) => {
            const existing = Array.isArray(nds) ? nds : [];
            const filtered = existing.filter(
              (node) =>
                String(node.id) !== id &&
                String(node.id) !== displayLabel,
            );
            return [
              ...filtered,
              {
                id,
                type: "ontology",
                position: startPos,
                data: {
                  key: id,
                  iri: normalizedUri,
                  displayPrefixed: displayLabel,
                  rdfTypes: rdfTypes || [],
                  literalProperties: [],
                  annotationProperties: payload?.annotationProperties || [],
                  visible: true,
                  hasReasoningError: false,
                  namespace,
                  label: displayLabel,
                } as NodeData,
              },
            ];
          });
          setTrackedTimeout(() => {
            skipNextAutoLayoutRef.current = false;
          }, 0);
        }}
        onToggleLegend={handleToggleLegend}
        showLegend={showLegend}
        onExport={handleExport}
        onExportSvg={exportSvg}
        onExportPng={exportPng}
        onLoadFile={onLoadFile}
        onClearData={() => {
          try {
            // Clear react-flow nodes/edges and selection immediately
            setNodes([]);
            setEdges([]);
            setSelectedNodePayload(null);
            setSelectedLinkPayload(null);
            // Try to fit view to avoid awkward viewport state
            try {
              const inst = reactFlowInstance && reactFlowInstance.current;
              if (inst && typeof (inst as any).fitView === "function") {
                (inst as any).fitView({ padding: 0.1 });
              }
            } catch (_) { /* ignore */ }
          } catch (_) {
            /* ignore UI clear failures */
          }
        }}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
          onLayoutChange={handleLayoutChange}
        currentLayout={currentLayout}
        layoutEnabled={layoutEnabled}
        onToggleLayoutEnabled={handleToggleLayoutEnabled}
        canvasActions={canvasActions}
        availableEntities={allEntities}
      />
      {showLegend ? (
        <ResizableNamespaceLegend onClose={() => handleToggleLegend()} />
      ) : null}


      <div
        className="w-full h-full pb-[5.5rem] md:pb-[4.5rem]"
        ref={flowWrapperRef}
      >
          <ReactFlow
          nodes={safeNodes}
          edges={filteredEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={onInit}
          onNodeDoubleClick={onNodeDoubleClickStrict}
          onNodeClick={onNodeClickStrict}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onEdgeDoubleClick={onEdgeDoubleClickStrict}
          onConnect={onConnectStrict}
          onSelectionChange={onSelectionChange}
          onMove={onMoveHandler}
          onMoveEnd={onMoveHandler}
          nodeTypes={memoNodeTypes}
          edgeTypes={memoEdgeTypes}
          connectionLineComponent={memoConnectionLine}
          connectOnClick={false}
          minZoom={0.1}
          nodeOrigin={[0.5, 0.5]}
          onlyRenderVisibleElements={true}
          className="knowledge-graph-canvas bg-canvas-bg"
        >
          <Controls
            position="bottom-left"
            showInteractive={true}
            showZoom={true}
            showFitView={true}
            className="bg-muted/50"
          />
          <MiniMap nodeStrokeWidth={3} pannable={true} />
          <Background gap={16} color="var(--grid-color, rgba(0,0,0,0.03))" />
        </ReactFlow>
      </div>

      <ModalStatus>
        <ReasoningIndicator
          onOpenReport={() => canvasActions.toggleReasoningReport(true)}
          onRunReason={() => {
            void triggerReasoningStrict(nodes, edges, true);
          }}
          currentReasoning={currentReasoning}
          isReasoning={isReasoning}
        />
      </ModalStatus>

      <ReasoningReportModal
        open={canvasState.showReasoningReport}
        onOpenChange={canvasActions.toggleReasoningReport}
        currentReasoning={currentReasoning}
        reasoningHistory={reasoningHistory}
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
          {
            const id = String(iriOrId);
            // Remove node from RF state by id or by node.data.iri match
            try {
              setNodes((prev = []) =>
                (prev || []).filter((n) => {
                  try {
                    const nid = String(n.id);
                    const iri =
                      n && (n as any).data && (n as any).data.iri
                        ? String((n as any).data.iri)
                        : "";
                    return nid !== id && iri !== id;
                  } catch {
                    return true;
                  }
                }),
              );
            } catch {
              // ignore
            }
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
            } catch {
              // ignore
            }
            // Best-effort: ask react-flow instance to delete elements if supported
            try {
              const inst = reactFlowInstance && reactFlowInstance.current;
              if (inst && typeof (inst as any).deleteElements === "function") {
                (inst as any).deleteElements([{ id }]);
              }
            } catch {
              // ignore
            }
          }
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
