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
import { RDFNode as OntologyNode } from "./RDFNode";
import ObjectPropertyEdge from "./ObjectPropertyEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";
import { generateEdgeId } from "./core/edgeHelpers";
import { usePaletteFromRdfManager } from "./core/namespacePalette";
import { exportSvgFull, exportPngFull } from "./core/downloadHelpers";
import {
  exportViewportSvgMinimal,
  exportViewportPngMinimal,
} from "./core/exportHelpers";
import { useCanvasState } from "../../hooks/useCanvasState";
import { toast } from "sonner";
import { LayoutManager } from "./LayoutManager";
import { NodePropertyEditor } from "./NodePropertyEditor";
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

const { namedNode } = DataFactory;

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
  const { state: canvasState, actions: canvasActions } = useCanvasState();
  // Attempt to use selective selectors for better performance, but fall back to the full store
  // shape when tests/mock implementations return the raw store object (common in unit tests).
  const _os_raw =
    (useOntologyStore as any) && typeof (useOntologyStore as any) === "function"
      ? (useOntologyStore as any)()
      : {};
  const _sel_loadedOntologies = useOntologyStore(
    (s: any) => s.loadedOntologies,
  );
  const loadedOntologies = ((): any[] => {
    if (Array.isArray(_sel_loadedOntologies)) return _sel_loadedOntologies;
    if (
      _sel_loadedOntologies &&
      typeof _sel_loadedOntologies === "object" &&
      Object.prototype.hasOwnProperty.call(
        _sel_loadedOntologies,
        "loadedOntologies",
      )
    )
      return _sel_loadedOntologies.loadedOntologies;
    return _os_raw && Array.isArray(_os_raw.loadedOntologies)
      ? _os_raw.loadedOntologies
      : [];
  })();

  const _sel_availableClasses = useOntologyStore(
    (s: any) => s.availableClasses,
  );
  const availableClasses = ((): any[] => {
    if (Array.isArray(_sel_availableClasses)) return _sel_availableClasses;
    if (
      _sel_availableClasses &&
      typeof _sel_availableClasses === "object" &&
      Object.prototype.hasOwnProperty.call(
        _sel_availableClasses,
        "availableClasses",
      )
    )
      return _sel_availableClasses.availableClasses;
    return _os_raw && Array.isArray(_os_raw.availableClasses)
      ? _os_raw.availableClasses
      : [];
  })();
  const ac = availableClasses;

  const _sel_loadKnowledgeGraph = useOntologyStore(
    (s: any) => s.loadKnowledgeGraph,
  );
  const loadKnowledgeGraph =
    typeof _sel_loadKnowledgeGraph === "function"
      ? _sel_loadKnowledgeGraph
      : _os_raw && typeof _os_raw.loadKnowledgeGraph === "function"
        ? _os_raw.loadKnowledgeGraph
        : undefined;

  const _sel_exportGraph = useOntologyStore((s: any) => s.exportGraph);
  const exportGraph =
    typeof _sel_exportGraph === "function"
      ? _sel_exportGraph
      : _os_raw && typeof _os_raw.exportGraph === "function"
        ? _os_raw.exportGraph
        : undefined;

  const _sel_loadAdditionalOntologies = useOntologyStore(
    (s: any) => s.loadAdditionalOntologies,
  );
  const loadAdditionalOntologies =
    typeof _sel_loadAdditionalOntologies === "function"
      ? _sel_loadAdditionalOntologies
      : _os_raw && typeof _os_raw.loadAdditionalOntologies === "function"
        ? _os_raw.loadAdditionalOntologies
        : undefined;

  const _sel_getRdfManager = useOntologyStore((s: any) => s.getRdfManager);
  const getRdfManager =
    typeof _sel_getRdfManager === "function"
      ? _sel_getRdfManager
      : _os_raw && typeof _os_raw.getRdfManager === "function"
        ? _os_raw.getRdfManager
        : undefined;

  const _sel_availableProperties = useOntologyStore(
    (s: any) => s.availableProperties,
  );
  const availableProperties = ((): any[] => {
    if (Array.isArray(_sel_availableProperties))
      return _sel_availableProperties;
    if (
      _sel_availableProperties &&
      typeof _sel_availableProperties === "object" &&
      Object.prototype.hasOwnProperty.call(
        _sel_availableProperties,
        "availableProperties",
      )
    )
      return _sel_availableProperties.availableProperties;
    return _os_raw && Array.isArray(_os_raw.availableProperties)
      ? _os_raw.availableProperties
      : [];
  })();

  const _sel_ontologiesVersion = useOntologyStore(
    (s: any) => s.ontologiesVersion,
  );
  const ontologiesVersion =
    _sel_ontologiesVersion !== undefined
      ? _sel_ontologiesVersion
      : _os_raw && _os_raw.ontologiesVersion !== undefined
        ? _os_raw.ontologiesVersion
        : undefined;

  // Safe getter for the RDF manager: prefer the selector-provided function but fall back to the store's getState accessor.
  // Some test mocks replace the store-level getter, so this helper ensures we find the manager reliably.
  const getRdfManagerSafe = useCallback(() => {
    {
      const maybe =
        typeof getRdfManager === "function" ? getRdfManager() : undefined;
      if (maybe) return maybe;
      const gs =
        (useOntologyStore as any).getState &&
        (useOntologyStore as any).getState().getRdfManager;
      return typeof gs === "function" ? gs() : undefined;
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
  const [layoutEnabled, setLayoutEnabled] = useState(
    () => !!(config && config.autoApplyLayout),
  );

  // Palette from RDF manager — used to compute colors without rebuilding palettes.
  const palette = usePaletteFromRdfManager();

  // Local editor state driven by React Flow events (node/edge payloads come from RF state).
  const [nodeEditorOpen, setNodeEditorOpen] = useState<boolean>(false);
  const [linkEditorOpen, setLinkEditorOpen] = useState<boolean>(false);
  const [selectedNodePayload, setSelectedNodePayload] = useState<any | null>(
    null,
  );
  const [selectedLinkPayload, setSelectedLinkPayload] = useState<any | null>(
    null,
  );

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
      const found = (availableProperties as any[]).find(
        (p) => String(p.iri) === String(predIri),
      );
      if (found) {
        if (Array.isArray(found.range) && found.range.length > 0)
          return "object";
        if (Array.isArray(found.domain) && found.domain.length > 0)
          return "object";
      }
    }

    // Precise check against RDF store rdf:type triples (authoritative)
    const mgr = getRdfManagerSafe
      ? getRdfManagerSafe()
      : typeof getRdfManager === "function"
        ? getRdfManager()
        : undefined;
    if (!mgr || typeof mgr.getStore !== "function") return "unknown";
    const store = mgr.getStore();
    const rdfTypeIri =
      typeof (mgr as any).expandPrefix === "function"
        ? (mgr as any).expandPrefix("rdf:type")
        : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const quads =
      store.getQuads(namedNode(predIri), namedNode(rdfTypeIri), null, null) ||
      [];
    for (const q of quads) {
      const t =
        q && (q.object as any) && (q.object as any).value
          ? String((q.object as any).value)
          : "";
      if (!t) continue;
      if (t === "http://www.w3.org/2002/07/owl#AnnotationProperty")
        return "annotation";
      if (t === "http://www.w3.org/2002/07/owl#ObjectProperty") return "object";
      if (t === "http://www.w3.org/2002/07/owl#DatatypeProperty")
        return "datatype";
    }
    return "unknown";
  };

  const handleToggleLayoutEnabled = useCallback((enabled: boolean) => {
    setLayoutEnabled(Boolean(enabled));
    useAppConfigStore.getState().setAutoApplyLayout(Boolean(enabled));
  }, []);

  const _blacklistedPrefixes = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
  const _blacklistedUris = [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ];

  function isBlacklistedIri(val?: string | null): boolean {
    if (!val) return false;
    const s = String(val).trim();
    if (!s) return false;
    if (s.includes(":") && !/^https?:\/\//i.test(s)) {
      const prefix = s.split(":", 1)[0];
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

  const predicateKindFn = useCallback(
    (predIri: string) => {
      const k = predicateKindLookup.get(String(predIri));
      return (k as any) || "unknown";
    },
    [predicateKindLookup],
  );

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

  const initialMapRef = useRef(true);

  // In-process mapper wrapper kept for compatibility with earlier worker-based
  // experiments. For now we run the pure mapper synchronously on the main thread.
  // Keeping this wrapper lets us later reintroduce a worker without changing
  // translateQuadsToDiagram call sites.
  const mapQuadsWithWorker = async (quads: any[], opts: any) => {
    return mapQuadsToDiagram(quads, opts);
  };
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

  // Small control refs for layout coordination
  const mappingInProgressRef = useRef<boolean>(false);
  const applyRequestedRef = useRef<boolean>(false);
  // One-shot flag to force layout after the next successful mapping run (used by loaders)
  const forceLayoutNextMappingRef = useRef<boolean>(false);

  // Keep refs in sync with state so other callbacks can read the latest snapshot synchronously.

  const doLayout = useCallback(
    async (
      candidateNodes: RFNode<NodeData>[],
      candidateEdges: RFEdge<LinkData>[],
      force = false,
      layoutTypeOverride?: string,
    ) => {
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
      let appliedLayoutType: string | undefined = undefined;
      try {
        const layoutType =
          layoutTypeOverride ||
          (config && config.currentLayout) ||
          lm.suggestOptimalLayout();
        appliedLayoutType = layoutType;

        // Ask the layout manager to compute node change objects for the provided nodes/edges.
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

        // Apply layout results to React Flow state via applyNodeChanges so RF runtime metadata is preserved.
        if (Array.isArray(nodeChanges) && nodeChanges.length > 0) {
          try {
            setNodes((prev) =>
              applyNodeChanges(nodeChanges as any, prev || []),
            );
          } catch (errApply) {
            // Fallback: if applyNodeChanges fails, attempt a reset-merge using the returned positions
            try {
              setNodes((prev = []) => {
                const prevById = new Map(
                  (prev || []).map((p) => [String(p.id), p]),
                );
                const changes = (nodeChanges || []).map((nc: any) => {
                  const id = String(nc.id);
                  const pos = nc.position ||
                    (nc.item && nc.item.position) || { x: 0, y: 0 };
                  const existing = prevById.get(id);
                  const item = existing
                    ? {
                        ...(existing as any),
                        position: pos,
                        data: {
                          ...(existing as any).data,
                          ...(nc.item && nc.item.data ? nc.item.data : {}),
                        },
                      }
                    : {
                        id,
                        type: "ontology",
                        position: pos,
                        data: (nc.item && nc.item.data) || {},
                      };
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
                  position: nc.position ||
                    (nc.item && nc.item.position) || { x: 0, y: 0 },
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
        // Ensure the React/ReactFlow render has flushed so callers awaiting doLayout
        // observe the updated positions. Await two animation frames as a deterministic
        // post-update hook (fallback to setTimeout if RAF unavailable).
        const raf = () =>
          new Promise((resolve) => {
            try {
              requestAnimationFrame(resolve);
            } catch (_) {
              setTimeout(resolve, 16);
            }
          });
        // Await two frames to allow React and ReactFlow to apply changes.
        // eslint-disable-next-line no-await-in-loop
        await raf();
        // eslint-disable-next-line no-await-in-loop
        await raf();
        {
          console.debug("canvas.layout.apply.completed", appliedLayoutType);
        }
        lastLayoutFingerprintRef.current = fingerprint;
        layoutInProgressRef.current = false;
      }
    },
    [layoutEnabled, config],
  );

  useEffect(() => {
    const auto = !!(config && (config as any).autoApplyLayout);
    if (!auto) return;

    const nodeIds = (nodes || [])
      .map((n) => String(n.id))
      .sort()
      .join(",");
    const edgeIds = (edges || [])
      .map((e) => String(e.id))
      .sort()
      .join(",");
    const structFp = `N:${nodeIds}|E:${edgeIds}`;

    if (lastLayoutFingerprintRef.current !== structFp) {
      lastLayoutFingerprintRef.current = structFp;
      void doLayout(nodes, edges, false);
    }
  }, [
    nodes.length,
    edges.length,
    config && (config as any).autoApplyLayout,
    doLayout,
  ]);

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

        loadTriggerRef.current = true;
        loadFitRef.current = true;

        // Ensure the next mapping run performs layout for this user-initiated load
        forceLayoutNextMappingRef.current = true;

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
  }, []);

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
          console.debug("[VG_DEBUG] selection ignored due to recent drag", {
            ageMs: Date.now() - last,
          });
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

  useEffect(() => {
    // Prefer the store-level getter (works with test mocks) then the selector-provided getter.
    const storeGetter =
      (useOntologyStore as any).getState &&
      (useOntologyStore as any).getState().getRdfManager;
    const mgr =
      (typeof storeGetter === "function" ? storeGetter() : undefined) ||
      (typeof getRdfManager === "function"
        ? getRdfManager()
        : getRdfManagerSafe
          ? getRdfManagerSafe()
          : undefined);
    if (!mgr) return;

    let mounted = true;
    let debounceTimer: number | null = null;
    // If a mapping run returns an empty result while we still have a previous snapshot,
    // it's likely a transient race. We schedule a single quick retry and skip applying
    // the empty result to avoid clearing the canvas unexpectedly.
    let subjectsCallback:
      | ((
          subs?: string[] | undefined,
          quads?: any[] | undefined,
        ) => Promise<void>)
      | null = null;

    const pendingQuads: any[] = [];
    const pendingSubjects: Set<string> = new Set<string>();

    const translateQuadsToDiagram = async (quads: any[]) => {
      let registry: any = undefined;
      if (
        typeof useOntologyStore === "function" &&
        typeof (useOntologyStore as any).getState === "function"
      ) {
        registry = (useOntologyStore as any).getState().namespaceRegistry;
      }
      console.debug("[VG_DEBUG] translateQuadsToDiagram.input", {
        count: Array.isArray(quads) ? quads.length : 0,
        sample: Array.isArray(quads) ? quads.slice(0, 10) : quads,
      });

      const opts = {
        predicateKind: predicateClassifier,
        availableProperties: availablePropertiesSnapshot,
        availableClasses: availableClasses,
        registry,
        palette: palette as any,
      } as any;

      // Prefer worker offload; fallback to in-process mapper on failure.
      const res = await mapQuadsWithWorker(quads, opts);
      return res;
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

      console.debug("[VG_DEBUG] mappingBatch.start", {
        pendingQuads: dataQuads.map((q: any) => ({
          subject: q && q.subject ? (q.subject as any).value : undefined,
          predicate: q && q.predicate ? (q.predicate as any).value : undefined,
          object: q && q.object ? (q.object as any).value : undefined,
          graph: q && q.graph ? (q.graph as any).value : undefined,
        })),
      });

      // Minimal, deterministic mapping: translate quads and apply mapper output
      // directly using React Flow's applyNodeChanges/applyEdgeChanges helper.
      const diagram = await translateQuadsToDiagram(dataQuads);
      const mappedNodes: RFNode<NodeData>[] = diagram && diagram.nodes;
      const mappedEdges: RFEdge<LinkData>[] = diagram && diagram.edges;

      // Build deterministic add/replace change objects so:
      // - mapper-provided positions are applied only for new nodes
      // - existing nodes preserve runtime metadata (position, selected, __rf, etc.)
      mappingInProgressRef.current = true;

      // Apply mapper output via centralized helper (nodes + edges)
      applyDiagrammChange(mappedNodes, mappedEdges);

      // Signal mapping completion for tests
      if (typeof window !== "undefined")
        (window as any).__VG_LAST_MAPPING_RUN = Date.now();

      console.debug("canvas.rebuild.end");

      // Schedule layout and queued-apply processing on next tick (ensures state flushed)
      setTimeout(async () => {
        mappingInProgressRef.current = false;

        const mergedNodes = Array.isArray(mappedNodes)
          ? mappedNodes
          : nodes || [];
        const mergedEdges = Array.isArray(mappedEdges)
          ? mappedEdges
          : edges || [];

        // If loader requested a forced layout for the next mapping, honor it first.
        if (forceLayoutNextMappingRef.current) {
          forceLayoutNextMappingRef.current = false;
          await doLayout(mergedNodes, mergedEdges, true);
          // Give React Flow a moment to apply node changes, then fit the view so the user sees the graph.
          await new Promise((r) => setTimeout(r, 50));

          const inst = reactFlowInstance && reactFlowInstance.current;
          if (inst && typeof (inst as any).fitView === "function") {
            (inst as any).fitView({ padding: 0.1 });
          }
        } else {
          // Otherwise run layout if autoApplyLayout is enabled
          const autoLayoutEnabled = !!(
            config && (config as any).autoApplyLayout
          );
          if (autoLayoutEnabled) {
            await doLayout(mergedNodes, mergedEdges, true);
          }
        }

        // Honor any manual Apply that was queued while mapping was in progress
        if (applyRequestedRef.current) {
          applyRequestedRef.current = false;
          await doLayout(mergedNodes, mergedEdges, true);
        }
      }, 0);
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

    subjectsCallback = async (
      subs?: string[] | undefined,
      quads?: any[] | undefined,
    ) => {
      console.debug("[VG_DEBUG] rdfManager.onSubjectsChange", {
        subjects: Array.isArray(subs) ? subs.slice() : subs,
        quads: Array.isArray(quads)
          ? (quads as any[]).map((q: any) => ({
              subject: q && q.subject ? (q.subject as any).value : undefined,
              predicate:
                q && q.predicate ? (q.predicate as any).value : undefined,
              object: q && q.object ? (q.object as any).value : undefined,
              graph: q && q.graph ? (q.graph as any).value : undefined,
            }))
          : [],
      });

      // Normalize incoming subjects
      const incomingSubjects = Array.isArray(subs)
        ? subs.map((s) => String(s))
        : [];
      if (incomingSubjects.length > 0) {
        for (const s of incomingSubjects) {
          {
            pendingSubjects.add(String(s));
          }
        }
      }

      // If we have quads for this emission attempt, apply the mapper output directly by
      // projecting mapper items into change objects and using applyNodeChanges/applyEdgeChanges.
      if (Array.isArray(quads) && quads.length > 0) {
        try {
          const diagram = await translateQuadsToDiagram(quads || []);
          const mappedNodes: RFNode<NodeData>[] =
            (diagram && diagram.nodes) || [];
          const mappedEdges: RFEdge<LinkData>[] =
            (diagram && diagram.edges) || [];

          const mappedById = new Map(
            (mappedNodes || []).map((m: any) => [String(m.id), m]),
          );
          const mappedEdgeById = new Map(
            (mappedEdges || []).map((e: any) => [String(e.id), e]),
          );

          applyDiagrammChange(mappedNodes, mappedEdges);

          // Signal mapping completion for tests
          if (typeof window !== "undefined")
            (window as any).__VG_LAST_MAPPING_RUN = Date.now();

          console.debug("canvas.rebuild.end");

          // Schedule layout against the merged mapper output (next tick so state flushes).
          setTimeout(async () => {
            try {
              const mergedNodes = Array.isArray(mappedNodes)
                ? mappedNodes
                : nodes || [];
              const mergedEdges = Array.isArray(mappedEdges)
                ? mappedEdges
                : edges || [];

              if (forceLayoutNextMappingRef.current) {
                forceLayoutNextMappingRef.current = false;
                try {
                  await doLayout(mergedNodes, mergedEdges, true);
                  await new Promise((r) => setTimeout(r, 50));
                  const inst =
                    reactFlowInstance && reactFlowInstance.current;
                  if (inst && typeof (inst as any).fitView === "function") {
                    (inst as any).fitView({ padding: 0.1 });
                  }
                } catch {
                  // ignore
                }
              } else {
                const autoLayoutEnabled = !!(
                  config && (config as any).autoApplyLayout
                );
                if (autoLayoutEnabled) {
                  try {
                    await doLayout(mergedNodes, mergedEdges, true);
                  } catch {
                    // ignore
                  }
                }
              }

              if (applyRequestedRef.current) {
                applyRequestedRef.current = false;
                try {
                  await doLayout(mergedNodes, mergedEdges, true);
                } catch {
                  // ignore
                }
              }
            } catch {
              // ignore
            }
          }, 0);

          return;
        } catch (err) {
          console.debug("[VG_DEBUG] subjectsCallback.directMappingFailed", {
            err,
          });
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
      console.debug("[VG_DEBUG] registering mgr.onSubjectsChange");

      try {
        mgr.onSubjectsChange(subjectsCallback as any);
      } catch (err) {
        console.debug(
          "[VG_DEBUG] mgr.onSubjectsChange registration failed",
          err,
        );
      }

      // Safety-net: after registering, request an immediate subject emission for
      // any subjects already present in the store so late subscribers receive a snapshot.
      try {
        if (mgr && typeof (mgr as any).triggerSubjectUpdate === "function" && typeof mgr.getStore === "function") {
          try {
            const dataGraph = namedNode("urn:vg:data");
            const all = mgr.getStore().getQuads(null, null, null, dataGraph) || [];
            const subs = Array.from(new Set((all || []).map((q: any) => {
              try { return q && q.subject && (q.subject as any).value ? String((q.subject as any).value) : null; } catch { return null; }
            }).filter(Boolean)));
            if (subs.length > 0) {
              // Fire-and-forget; do not block init on errors
              (mgr as any).triggerSubjectUpdate(subs).catch((e: any) => {
                console.debug("[VG_DEBUG] triggerSubjectUpdate (post-register) failed", e);
              });
            }
          } catch (e) {
            // ignore any failures here
            console.debug("[VG_DEBUG] post-registration subject replay failed", e);
          }
        }
      } catch (_) {
        /* ignore */
      }
    } else {
      console.debug(
        "[VG_DEBUG] mgr.onSubjectsChange not available, subjectsCallback not registered",
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
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (typeof mgr.offSubjectsChange === "function" && subjectsCallback) {
        mgr.offSubjectsChange(subjectsCallback as any);
      }
    };
  }, [
    getRdfManager,
    setNodes,
    setEdges,
    availableProperties,
    availableClasses,
  ]);

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
            await new Promise((r) => setTimeout(r, 200));
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
        await new Promise((r) => setTimeout(r, 200));
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
        // Debug: log persisted config snapshot so test runs can verify whether
        // persistedAutoload/additionalOntologies were read by the canvas at init time.
        console.debug("[VG_DEBUG] __VG_INIT_APP.config_snapshot", {
          persistedAutoload: !!cfg?.persistedAutoload,
          additionalOntologies: cfg?.additionalOntologies,
        });

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
            console.debug(
              "[VG_DEBUG] Autoload start - configured additionalOntologies:",
              toLoad,
            );
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
                console.debug(
                  `[VG_DEBUG] loadAdditionalOntologies progress ${progress}%: ${message}`,
                );
                canvasActions.setLoading(
                  true,
                  Math.max(5, progress),
                  message,
                );
              },
            );
            console.debug(
              "[VG_DEBUG] Autoload complete - requested ontologies loaded",
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
          console.debug("[VG_DEBUG] Autoload error", err);
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
          const shouldBeVisible =
            visibleFlag && (viewMode === "tbox" ? isTBox : !isTBox);
          const hidden = !shouldBeVisible;
          nodeHiddenById.set(String(n.id), hidden);
          return hidden === !!(n as any).hidden ? n : { ...n, hidden };
        } catch {
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
        } catch {
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
      const edgesPayload = (es || []).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      }));
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      const result = await startReasoning(
        nodesPayload as any,
        edgesPayload as any,
        mgr && mgr.getStore && mgr.getStore(),
      );

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
            const a = edgeWarnMap.get(String(w.edgeId)) || [];
            a.push(String(w.message || w));
            edgeWarnMap.set(String(w.edgeId), a);
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
            const prevWarns =
              (n.data && (n.data as any).reasoningWarnings) || [];
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
            const prevWarns =
              (e.data && (e.data as any).reasoningWarnings) || [];
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
          console.debug("[VG_DEBUG] triggerSubjectUpdate failed", err);
        });
      } else {
        console.debug(
          "[VG_DEBUG] skipping triggerSubjectUpdate: canvas not ready",
        );
      }
    } else {
      console.debug("[VG_DEBUG] triggerSubjectUpdate invocation failed or unavailable");
    }
  }, [currentReasoning, setNodes, setEdges]);

  const onNodeDoubleClickStrict = useCallback(
    (event: any, node: any) => {
      event?.stopPropagation && event.stopPropagation();

      // Short suppress guard to avoid selection-change races opening other editors.
      suppressSelectionRef.current = true;
      setTimeout(() => {
        suppressSelectionRef.current = false;
      }, 0);

      // Defensive: if we just finished a drag, do not open the editor.
      try {
        const last = lastDragStopRef.current;
        if (typeof last === "number" && Date.now() - last < RECENT_DRAG_MS) {
          console.debug("[VG_DEBUG] double-click suppressed due to recent drag", {
            ageMs: Date.now() - last,
          });
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
        console.debug("[VG_DEBUG] click suppressed due to recent drag", {
          ageMs: Date.now() - last,
        });
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
              } catch (_) {}
              try {
                if (typeof (ev as any).stopPropagation === "function") (ev as any).stopPropagation();
              } catch (_) {}
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
          } catch (_) {}
          try {
            (window as any).addEventListener("mouseup", handler as any, true);
          } catch (_) {}
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
          if (intervals.length === 0) {
            console.debug("[VG_DEBUG] drag metrics: no intervals");
          } else {
            const sum = intervals.reduce((a, b) => a + b, 0);
            const avg = sum / intervals.length;
            const fps = avg > 0 ? 1000 / avg : 0;
            const count = dragMetricsRef.current.count || intervals.length;
            const metrics = {
              count,
              avgMs: Number(avg.toFixed(2)),
              fps: Math.round(fps),
            };
            console.debug("[VG_DEBUG] drag metrics", metrics);
            (window as any).__VG_LAST_DRAG_METRICS = metrics;
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
              } catch (_) {}
              try {
                if (typeof (ev as any).stopPropagation === "function")
                  (ev as any).stopPropagation();
              } catch (_) {}
              try {
                if (typeof (ev as any).preventDefault === "function")
                  (ev as any).preventDefault();
              } catch (_) {}
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
          } catch (_) {}
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
            } catch (_) {}
          }
          try {
            window.removeEventListener("mouseup", h as any, true);
          } catch (_) {
            try {
              (window as any).removeEventListener("mouseup", h as any, { capture: true } as any);
            } catch (_) {}
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
      setTimeout(() => {
        suppressSelectionRef.current = false;
      }, 0);

      // Trigger an update for edges attached to the moved node so their custom
      // edge components recompute their control points (using persisted shift).
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
      setTimeout(() => {
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
              store.getQuads(subjTerm, namedNode(oldPredFull), objTerm, g) ||
              [];
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

  const safeNodes = useMemo(() => {
    return (nodes || []).map((n) => {
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
  }, [nodes]);

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
    (edges || []).map((e: any) => String(e.id)).join(","),
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

  // Centralized helper that accepts mapper-style arrays of node and edge instances
  // and turns them into React Flow change objects (add/replace). This preserves
  // runtime metadata for existing nodes (position, __rf, etc.) while applying
  // mapper-provided positions for newly added nodes. Placeholders for missing
  // edge endpoints are also created automatically.
  const applyDiagrammChange = useCallback(
    (incomingNodes?: RFNode<NodeData>[], incomingEdges?: RFEdge<LinkData>[]) => {
      const inNodes = Array.isArray(incomingNodes) ? incomingNodes : [];
      const inEdges = Array.isArray(incomingEdges) ? incomingEdges : [];

      // Apply node changes first so placeholders/new nodes exist before edges are applied.
      if (inNodes.length > 0 || inEdges.length > 0) {
        setNodes((prev = []) => {
          const prevArr = prev || [];
          const prevById = new Map((prevArr || []).map((n: any) => [String(n.id), n]));
          const incomingById = new Map((inNodes || []).map((n: any) => [String(n.id), n]));
          const changes: any[] = [];

          // Convert incoming nodes into add/replace change objects
          for (const m of inNodes || []) {
            try {
              const id = String(m.id);
              const existing = prevById.get(id);
              if (existing) {
                // Preserve runtime metadata for existing nodes; perform a defensive merge
                // so sparse/empty arrays from the mapper do not clobber existing rich data.
                const incomingData = (m && (m as any).data) || {};
                const baseData = { ...(existing.data || {}) } as any;
                const mergedData: any = { ...baseData };

                // Merge keys from incomingData with defensive rules:
                // - If incoming value is an array:
                //    - if non-empty: overwrite
                //    - if empty: skip (preserve existing)
                // - If incoming value is scalar (string/number/boolean):
                //    - if non-empty (not null/undefined/""): overwrite
                //    - otherwise skip
                for (const k of Object.keys(incomingData)) {
                  try {
                    const val = (incomingData as any)[k];
                    if (Array.isArray(val)) {
                      if (val.length > 0) mergedData[k] = val;
                      // empty array -> treat as "no information", preserve existing
                    } else if (val === null || typeof val === "undefined" || (typeof val === "string" && val === "")) {
                      // skip empty scalar -> preserve existing
                    } else {
                      mergedData[k] = val;
                    }
                  } catch {
                    // ignore per-key merge errors
                  }
                }

                const item = {
                  ...existing,
                  type: (m && (m as any).type) || existing.type,
                  position: existing.position || (m && (m as any).position) || { x: 0, y: 0 },
                  data: mergedData,
                } as any;
                // Ensure selection is not preserved from existing metadata.
                delete (item as any).selected;
                changes.push({ id, type: "replace", item });
              } else {
                // New node: accept mapper-provided position and data as-is.
                const item = { ...(m as any), position: m && m.position ? m.position : { x: 0, y: 0 } } as any;
                delete (item as any).selected;
                changes.push({ type: "add", item });
              }
            } catch {
              // per-item ignore
            }
          }

          // Ensure endpoints referenced by incomingEdges exist as placeholders if missing.
          const currentIds = new Set((prevArr || []).map((n: any) => String(n.id)));
          for (const e of inEdges || []) {
            try {
              const s = String(e && e.source);
              const t = String(e && e.target);
              if (s && !currentIds.has(s) && !incomingById.has(s)) {
                currentIds.add(s);
                const placeholder = {
                  id: s,
                  type: "ontology",
                  position: { x: 0, y: 0 },
                  data: {
                    key: s,
                    iri: s,
                    rdfTypes: [],
                    literalProperties: [],
                    annotationProperties: [],
                    visible: true,
                    hasReasoningError: false,
                    namespace: "",
                    label: s,
                  } as NodeData,
                } as RFNode<NodeData>;
                changes.push({ type: "add", item: placeholder });
              }
              if (t && !currentIds.has(t) && !incomingById.has(t)) {
                currentIds.add(t);
                const placeholder = {
                  id: t,
                  type: "ontology",
                  position: { x: 0, y: 0 },
                  data: {
                    key: t,
                    iri: t,
                    rdfTypes: [],
                    literalProperties: [],
                    annotationProperties: [],
                    visible: true,
                    hasReasoningError: false,
                    namespace: "",
                    label: t,
                  } as NodeData,
                } as RFNode<NodeData>;
                changes.push({ type: "add", item: placeholder });
              }
            } catch {
              // ignore
            }
          }

          if (changes.length === 0) return prevArr;
          return applyNodeChanges(changes as any, prevArr);
        });
      }

      // Apply edge changes after nodes so placeholders and new nodes exist.
      if (inEdges.length > 0) {
        setEdges((prev = []) => {
          const prevArr = prev || [];
          const prevById = new Map(prevArr.map((e: any) => [String(e.id), e]));
          const changes: any[] = [];

          // Build map of incoming edges grouped by source -> Set of incoming ids
          const incomingBySource = new Map<string, Set<string>>();
          for (const m of inEdges || []) {
            try {
              const sid = String(m && (m.source || ""));
              const mid = String(m && (m.id || ""));
              if (!sid) continue;
              const sset = incomingBySource.get(sid) || new Set<string>();
              if (mid) sset.add(mid);
              incomingBySource.set(sid, sset);
            } catch {
              // ignore per-item
            }
          }

          // For each source present in incomingBySource, remove all existing edges that originate
          // from that source but are not present in the incoming set. This synchronizes outgoing
          // edges for the subject with the mapper's authoritative outgoing set.
          if (incomingBySource.size > 0) {
            const toRemoveIds = new Set<string>();
            for (const e of prevArr || []) {
              try {
                const src = String(e && (e.source || ""));
                const id = String(e && (e.id || ""));
                if (!src) continue;
                const incomingSet = incomingBySource.get(src);
                if (incomingSet) {
                  // If existing edge id is not present in incomingSet, schedule removal
                  if (!incomingSet.has(id)) {
                    toRemoveIds.add(id);
                  }
                }
              } catch {
                // ignore per-edge
              }
            }
            for (const rid of Array.from(toRemoveIds)) {
              try {
                changes.push({ id: rid, type: "remove" });
              } catch {
                // ignore
              }
            }
          }

          // Now add/replace incoming edges (preserve runtime metadata when ids match)
          for (const m of inEdges || []) {
            try {
              const id = String(m.id);
              const existing = prevById.get(id);
              if (existing) {
                // Preserve existing runtime flags but ensure the edge remains selectable
                const item = {
                  ...existing,
                  source: m && m.source ? m.source : existing.source,
                  target: m && m.target ? m.target : existing.target,
                  data: { ...(existing.data || {}), ...(m && m.data ? m.data : {}) },
                } as any;
                // If selectable wasn't explicitly set on the existing edge, default to true.
                if (typeof (item as any).selectable !== "boolean") {
                  (item as any).selectable = true;
                }

                // Provide an immediate persistence hook so UI updates to shift are visible
                // as soon as the handle drag completes. This is a runtime-only callback and
                // will not be serialized/stored by the mapper.
                try {
                  item.data = item.data || {};
                  (item.data as any).onEdgeUpdate = (payload: { id: string; shift: number }) => {
                    try {
                      setEdges((prev = []) =>
                        (prev || []).map((e) =>
                          String(e.id) === String(id)
                            ? { ...(e as any), data: { ...(e as any).data, shift: payload.shift } }
                            : e,
                        ),
                      );
                    } catch (_) {
                      // ignore
                    }
                  };
                } catch (_) {
                  // ignore
                }

                changes.push({ id, type: "replace", item });
              } else {
                const item = { ...(m as any) } as any;
                // Ensure newly added edges are selectable by default unless caller explicitly disabled it.
                if (typeof (item as any).selectable !== "boolean") {
                  (item as any).selectable = true;
                }

                // Inject onEdgeUpdate callback for newly added edges as well so a label drag
                // persists shift immediately into React Flow state.
                try {
                  item.data = item.data || {};
                  (item.data as any).onEdgeUpdate = (payload: { id: string; shift: number }) => {
                    try {
                      setEdges((prev = []) =>
                        (prev || []).map((e) =>
                          String(e.id) === String(id)
                            ? { ...(e as any), data: { ...(e as any).data, shift: payload.shift } }
                            : e,
                        ),
                      );
                    } catch (_) {
                      // ignore
                    }
                  };
                } catch (_) {
                  // ignore
                }

                changes.push({ type: "add", item });
              }
            } catch {
              // per-item ignore
            }
          }

          if (changes.length === 0) return prevArr;
          return applyEdgeChanges(changes as any, prevArr);
        });
      }
    },
    [setNodes, setEdges],
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
              if (expanded && typeof expanded === "string")
                normalizedUri = expanded;
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
        availableEntities={allEntities}
      />
      {showLegend ? (
        <ResizableNamespaceLegend onClose={() => handleToggleLegend()} />
      ) : null}
      {canvasState.isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-50 bg-card p-4 rounded-lg shadow-lg min-w-96 text-foreground">
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
          onNodeClick={onNodeClickStrict}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onEdgeDoubleClick={onEdgeDoubleClickStrict}
          onConnect={onConnectStrict}
          onSelectionChange={onSelectionChange}
          nodeTypes={memoNodeTypes}
          edgeTypes={memoEdgeTypes}
          connectionLineComponent={memoConnectionLine}
          connectOnClick={false}
          minZoom={0.1}
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
