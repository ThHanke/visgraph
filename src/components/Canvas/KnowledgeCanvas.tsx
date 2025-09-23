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
  // Enable programmatic/layout toggle on by default per user request.
  const [layoutEnabled, setLayoutEnabled] = useState(true);

  // Palette from RDF manager — used to compute colors without rebuilding palettes.
  const palette = usePaletteFromRdfManager();

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

  useEffect(() => {
    setViewMode(config.viewMode);
    setShowLegendState(config.showLegend);
    setCurrentLayoutState(config.currentLayout);
  }, [config.viewMode, config.showLegend, config.currentLayout]);

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
        setNodes((prev) => {
          try {
            const prevById = new Map<string, RFNode<NodeData>>();
            (prev || []).forEach((n) => prevById.set(String(n.id), n));
            const merged = Array.isArray(positioned)
              ? positioned.map((p) => {
                  const id = String(p && (p.id || p.key || p.data && p.data.key));
                  const pos = p && p.position ? p.position : { x: 0, y: 0 };
                  const prevNode = prevById.get(id);
                  // Preserve runtime flags and data where possible
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
                  // preserve __rf and selected flags if present on previous node
                  if (prevNode) {
                    if ((prevNode as any).__rf) (mergedNode as any).__rf = (prevNode as any).__rf;
                    if ((prevNode as any).selected) (mergedNode as any).selected = true;
                  }
                  return mergedNode;
                })
              : [];
            return merged;
          } catch (_) {
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
        const lm = layoutManagerRef.current;
        if (!lm) return;
        // Prepare lightweight nodes/edges for layout
        diagramRef.current.nodes = (candidateNodes || []).map((n) => ({ id: String(n.id), position: n.position, data: n.data }));
        diagramRef.current.edges = (candidateEdges || []).map((e) => ({ id: String(e.id), source: String(e.source), target: String(e.target), data: e.data }));
        // call layout manager with suggested layout type or config.currentLayout if present
        const layoutType = (config && (config.currentLayout)) || lm.suggestOptimalLayout();
        await lm.applyLayout(layoutType as any, { nodeSpacing: (config && (config.layoutSpacing as any)) || undefined });
      } catch (_) {
        // ignore layout failures
      }
    },
    [layoutEnabled, config, nodes],
  );

  // Debounced re-layout on user-driven node/edge changes
  const layoutDebounceRef = useRef<number | null>(null);
  useEffect(() => {
    try {
      if (!layoutEnabled || !(config && config.autoApplyLayout)) return;
      if (layoutDebounceRef.current) {
        try { window.clearTimeout(layoutDebounceRef.current); } catch (_) {}
      }
      layoutDebounceRef.current = window.setTimeout(() => {
        try {
          void doLayout(nodesRef.current, edgesRef.current);
        } catch (_) {}
        try { layoutDebounceRef.current = null; } catch (_) {}
      }, 300);
    } catch (_) { /* ignore */ }

    return () => {
      try {
        if (layoutDebounceRef.current) {
          try { window.clearTimeout(layoutDebounceRef.current); } catch (_) {}
          layoutDebounceRef.current = null;
        }
      } catch (_) { /* ignore */ }
    };
  }, [nodes, edges, layoutEnabled, doLayout]);

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

    // Use the centralized pure mapper directly.
    const translateQuadsToDiagram = (quads: any[]) => {
      return mapQuadsToDiagram(quads);
    };

    const runMapping = () => {
      if (!mounted) return;
      // If there are no accumulated quads, do nothing
      if (!pendingQuads || pendingQuads.length === 0) {
        return;
      }

      let diagram;
      try {
        // Diagnostic: log sample count for debugging
        try {
          const sampleSubjects = Array.from(new Set((pendingQuads || []).map((q: any) => (q && q.subject && q.subject.value) || ""))).slice(0, 20);
          console.debug("[VG_DEBUG] KnowledgeCanvas.runMapping incrementalQuads", { total: (pendingQuads || []).length, subjectsSample: sampleSubjects });
        } catch (_) { /* ignore */ }

        diagram = translateQuadsToDiagram(pendingQuads);
      } catch (err) {
        try { console.error("[VG] KnowledgeCanvas: incremental quad mapping failed", err); } catch (_) {}
        diagram = { nodes: [], edges: [] };
      } finally {
        // drain accumulator
        try { pendingQuads = []; } catch (_) {}
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
            const updatedData = { ...(n.data as NodeData), classType: (td && td.iri) || n.data?.classType, displayPrefixed, displayShort, typeNamespace: td?.namespace || n.data?.typeNamespace, paletteColor, label: n.data?.label || td?.label } as NodeData;
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

      // Merge positions and runtime flags from current nodes state
      setNodes((prev) => {
        try {
          const prevById = new Map<string, RFNode<NodeData>>();
          (prev || []).forEach((n) => prevById.set(String(n.id), n));
          const merged = enrichedNodes.map((m) => {
            const prevNode = prevById.get(String(m.id));
            if (prevNode) {
              if (prevNode.position) m.position = prevNode.position;
              if ((prevNode as any).__rf) (m as any).__rf = (prevNode as any).__rf;
              if ((prevNode as any).selected) (m as any).selected = true;
            }
            return m;
          });
          return merged;
        } catch (e) {
          try { console.warn("[VG] KnowledgeCanvas: merge failed, falling back to mappedNodes", e); } catch (_) {}
          return mappedNodes;
        }
      });

      // Replace edges
      setEdges((prev) => {
        try {
        if (
          Array.isArray(prev) &&
          prev.length === enrichedEdges.length &&
          prev.every((p, idx) => p.id === enrichedEdges[idx].id && p.source === enrichedEdges[idx].source && p.target === enrichedEdges[idx].target)
        ) {
          return prev;
        }
      } catch (_) { /* fall through to replace */ }
      return enrichedEdges;
      });

      // Trigger layout (async). If a programmatic load triggered this mapping, force layout once.
      try {
        if (loadTriggerRef.current) {
          try { loadTriggerRef.current = false; } catch (_) { /* ignore */ }
          void doLayout(mappedNodes, mappedEdges, true);
        } else {
          void doLayout(mappedNodes, mappedEdges, false);
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
      try { delete (window as any).__VG_KNOWLEDGE_CANVAS_READY; } catch (_) {}
    };
  }, []);

  // Expose a small initializer to mirror ReactFlowCanvas behavior for tests/dev tooling.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__VG_INIT_APP = async (opts?: { force?: boolean }) => {
      try {
        // honour test/dev flag for persisted autoload (tests set this flag)
        const allowAutoLoad = !!(window as any).__VG_ALLOW_PERSISTED_AUTOLOAD;
        // Pull startup URL from query string (support legacy 'url' param used in tests)
        let startupUrl = "";
        try {
          const u = new URL(String(window.location.href));
          startupUrl = u.searchParams.get("url") || u.searchParams.get("rdfUrl") || u.searchParams.get("vg_url") || "";
        } catch (_) {
          startupUrl = "";
        }

        if (startupUrl && typeof loadKnowledgeGraph === "function") {
          try {
            await loadKnowledgeGraph(startupUrl, {
              onProgress: (_p: number, _m: string) => {
                // no-op in test
              },
            });
          } catch (e) {
            try { console.warn("[VG] KnowledgeCanvas init load failed", e); } catch (_) { void 0; }
          }
          return;
        }

        if (allowAutoLoad && typeof loadKnowledgeGraph === "function") {
          try {
            // Intentionally no-op; persistent autoloading decision left to higher-level code.
          } catch (e) {
            try { console.warn("[VG] KnowledgeCanvas persisted autoload check failed", e); } catch (_) { void 0; }
          }
        }
      } catch (e) {
        try { console.warn("[VG] __VG_INIT_APP in KnowledgeCanvas failed", e); } catch (_) { void 0; }
      }
    };

      try {
      const win = typeof window !== "undefined" ? window : undefined;
      const maybeUrl = (function () {
        try {
          const u = new URL(String(win && win.location && win.location.href ? win.location.href : ""));
          return u.searchParams.get("rdfUrl") || u.searchParams.get("url") || u.searchParams.get("vg_url") || null;
        } catch (_) {
          return null;
        }
      })();
      // If a startup RDF URL is present, mark loadTrigger so the first mapping will force layout.
      if (maybeUrl) {
        try { loadTriggerRef.current = true; } catch (_) { /* ignore */ }
      }
      if (maybeUrl && typeof (window as any).__VG_INIT_APP === "function") {
        try {
          void (window as any).__VG_INIT_APP({ force: true });
        } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore auto-init */ }

    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) { void 0; }
    };
  }, [loadKnowledgeGraph]);

  

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
