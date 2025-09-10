import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  Controls,
  Background,
  Connection,
  MarkerType,
} from '@xyflow/react';
import type { Node as RFNode, Edge as RFEdge, ReactFlowInstance as RFInstance } from '@xyflow/react';
import { DataFactory } from 'n3';
const { namedNode, quad } = DataFactory;
import canonicalId from '../../lib/canonicalId';
import { useCanvasState } from '../../hooks/useCanvasState';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useReasoningStore } from '../../stores/reasoningStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { CanvasToolbar } from './CanvasToolbar';
import { ResizableNamespaceLegend } from './ResizableNamespaceLegend';
import { ReasoningIndicator } from './ReasoningIndicator';
import { ReasoningReportModal } from './ReasoningReportModal';
import { NodePropertyEditor } from './NodePropertyEditor';
import { LinkPropertyEditor } from './LinkPropertyEditor';
import { Progress } from '../ui/progress';
import { computeDisplayInfoMemo, computeBadgeText, shortLocalName } from './core/nodeDisplay';
import { buildPaletteForRdfManager } from './core/namespacePalette';
import { resolveKeyForCg } from './helpers/graphMappingHelpers';
import { deriveNamespaceFromInfo, getColorFromPalette } from './helpers/paletteHelpers';
import { buildPaletteMap } from './core/namespacePalette';
import { getNamespaceColorFromPalette } from './helpers/namespaceHelpers';
import { toast } from 'sonner';
import { debug, warn, fallback } from '../../utils/startupDebug';
import { CustomOntologyNode as OntologyNode } from './CustomOntologyNode';
import FloatingEdge from './FloatingEdge';
import FloatingConnectionLine from './FloatingConnectionLine';
import { applyDagreLayout } from './layout/dagreLayout';
import type { NodeData, LinkData } from '../../types/canvas';

/**
 * Minimal React Flow-based Canvas replacement.
 *
 * This component aims to provide a first, safe pass at replacing the -based canvas
 * with React Flow. It intentionally implements a conservative feature subset:
 *  - maps currentGraph -> nodes/edges (preserves URIs / IDs)
 *  - selection/double-click to open editors
 *  - onConnect to add edges
 *  - triggers reasoning on node/edge changes and marks hasReasoningError
 *  - provides a simple programmatic layout API (window.__VG_APPLY_LAYOUT) that computes
 *    deterministic positions and updates nodes. Advanced animated layouts should be
 *    implemented later in a dedicated LayoutManagerReactFlow module.
 *
 * The code reuses existing helpers (computeDisplayInfoMemo, computeBadgeText, palette builders)
 * so visual parity (badges/colors) is preserved.
 */

const nodeGridPosition = (index: number) => {
  const colSize = 4;
  const spacingX = 220;
  const spacingY = 140;
  const col = index % colSize;
  const row = Math.floor(index / colSize);
  return { x: col * spacingX, y: row * spacingY };
};

export const ReactFlowCanvas: React.FC = () => {
  const DEBUG = typeof window !== 'undefined' && !!(window as any).__VG_DEBUG__;
  if (DEBUG) {
    try { debug('reactflow.component.init', { envDebug: typeof window !== 'undefined' ? (window as any).__VG_DEBUG__ : false }, { caller: true }); } catch (_) { /* ignore debug failures */ }
  }

  const { state: canvasState, actions: canvasActions } = useCanvasState();
  const { loadedOntologies, availableClasses, loadKnowledgeGraph, exportGraph, updateNode, loadAdditionalOntologies, getRdfManager, currentGraph, availableProperties, availableClasses: ac } = useOntologyStore();
  const { startReasoning } = useReasoningStore();
  const { settings } = useSettingsStore();
  const { config, setCurrentLayout, setShowLegend, setViewMode: setPersistedViewMode, addAdditionalOntology } = useAppConfigStore();

  const [viewMode, setViewMode] = useState(config.viewMode);
  const [showLegend, setShowLegendState] = useState(config.showLegend);
  const [currentLayout, setCurrentLayoutState] = useState(config.currentLayout);
  const [layoutEnabled, setLayoutEnabled] = useState(false);

  useEffect(() => {
    setViewMode(config.viewMode);
    setShowLegendState(config.showLegend);
    setCurrentLayoutState(config.currentLayout);
  }, [config.viewMode, config.showLegend, config.currentLayout]);

  const allEntities = useMemo(() => {
    return loadedOntologies.flatMap(ontology => [
      ...ontology.classes.map(cls => ({
        uri: cls.uri,
        label: cls.label,
        namespace: cls.namespace,
        rdfType: 'owl:Class' as const,
        description: `Class from ${ontology.name}`
      })),
      ...ontology.properties.map(prop => ({
        uri: prop.uri,
        label: prop.label,
        namespace: prop.namespace,
        rdfType: prop.uri.includes('ObjectProperty') ? 'owl:ObjectProperty' : 'owl:AnnotationProperty' as const,
        description: `Property from ${ontology.name}`
      }))
    ]);
  }, [loadedOntologies]);

  const getRdfManagerRef = useRef(getRdfManager);
  useEffect(() => {
    getRdfManagerRef.current = getRdfManager;
  }, [getRdfManager]);

  // Subscribe to lightweight subject-change notifications from the RDF manager.
  // The RDF manager emits an array of subject IRIs that changed; for each subject
  // we query the store for triples with that subject and compute minimal node + outgoing-edge
  // updates. We batch updates to React Flow by calling setNodes/setEdges once per event.
  // (This effect moved below so setNodes/setEdges are already declared.)

  // Guard to avoid mapping the canvas on initial mount. The mapping effect is subscribed
  // to RDF change notifications and will run when rdfChangeSignal increments. We skip
  // the very first render to ensure no automatic mapping happens before any RDF changes.
  const initialMapRef = useRef(true);

  // Palette helpers (reuse existing implementations)
  const paletteMap = useMemo(() => {
    try {
      const mgr = getRdfManager?.();
      const nsMap = (mgr && typeof mgr.getNamespaces === 'function') ? mgr.getNamespaces() : {};
      const prefixes = Object.keys(nsMap || {}).filter(Boolean).sort();
      const textColors = [
        getComputedStyle(document.documentElement).getPropertyValue('--node-foreground') || '#000000',
        getComputedStyle(document.documentElement).getPropertyValue('--primary-foreground') || '#000000'
      ];
      return buildPaletteMap(prefixes, { avoidColors: textColors });
    } catch (e) {
      return {};
    }
  }, [getRdfManager]);

  const getNamespaceColor = useCallback((namespace: string) => {
    return getNamespaceColorFromPalette(paletteMap as Record<string, string> | undefined, namespace);
  }, [paletteMap]);

  // React Flow state (typed as React Flow Node/Edge with  payloads)
  const _initialRFNodes: RFNode<NodeData>[] = [];
  const _initialRFEdges: RFEdge<LinkData>[] = [];
  const [nodes, setNodes, onNodesChange] = useNodesState(_initialRFNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(_initialRFEdges);
  const reactFlowInstance = useRef<RFInstance | null>(null);
  const linkSourceRef = useRef<NodeData | null>(null);
  const linkTargetRef = useRef<NodeData | null>(null);
  // Prevent re-entrant / overlapping reasoning runs which can cause render loops
  const reasoningInProgressRef = useRef(false);
  const reasoningTimerRef = useRef<number | null>(null);

  // Simple deterministic mapping: currentGraph -> nodes & edges
  useEffect(() => {
    // Skip the initial mount mapping; mapping will run when rdfChangeSignal changes (or manual trigger).
    if (initialMapRef.current) {
      initialMapRef.current = false;
      return;
    }

    const cg = currentGraph;
    if (DEBUG) {
      try { debug('reactflow.mapping.start', { nodeCount: cg?.nodes?.length ?? 0, edgeCount: cg?.edges?.length ?? 0 }, { caller: true }); } catch (_) { /* ignore */ }
    }
    const diagramNodes: RFNode<NodeData>[] = [];
    const diagramEdges: RFEdge<LinkData>[] = [];

    if (!cg) {
      setNodes([]);
      setEdges([]);
      return;
    }

    try {
      for (let i = 0; i < cg.nodes.length; i++) {
        const node = cg.nodes[i];
        const src = node.data || node;
        // compute display info using existing helpers
        const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
        let badgeText = '';
        let dispInfo: any = null;
        try {
          dispInfo = computeDisplayInfoMemo(src, mgr, availableClasses);
          badgeText = computeBadgeText(src, mgr, availableClasses) || '';
        } catch (e) { /* ignore */ }

        const typeNamespace = (dispInfo && dispInfo.namespace) || src.namespace || '';
        const paletteLocal = buildPaletteForRdfManager(mgr);
        const color = (() => {
          try {
            const nsKey = typeNamespace || src.namespace || '';
            const direct = paletteLocal[nsKey];
            if (direct) return direct;
            const stripped = String(nsKey || '').replace(/[:#].*$/, '');
            if (stripped && paletteLocal[stripped]) return paletteLocal[stripped];
            return getNamespaceColor(nsKey);
          } catch {
            return getNamespaceColor(typeNamespace || src.namespace);
          }
        })();

        const id = canonicalId(src.uri || src.iri || src.id || src.key || `n-${i}`);
        const pos = node.position || nodeGridPosition(i);

        let rdfTypesArr = Array.isArray(src.rdfTypes) ? src.rdfTypes.map(String).filter(Boolean) : [];

        // If rdfTypes are not present on the parsed node, attempt to look them up
        // from the RDF manager store. Use direct subject/predicate queries where possible
        // and avoid any store mutation here — mapping must be pure and not normalize data.
        if ((!rdfTypesArr || rdfTypesArr.length === 0) && typeof getRdfManagerRef.current === 'function') {
          try {
            const mgrLocal = getRdfManagerRef.current();
            const store = mgrLocal && typeof mgrLocal.getStore === 'function' ? mgrLocal.getStore() : null;
            const subjectUri = src.uri || src.iri || src.id || '';
            if (store && subjectUri && typeof store.getQuads === 'function') {
              // Prefer using rdfManager's prefix expansion to obtain the predicate IRI
              const rdfTypePredicate = (mgrLocal && typeof mgrLocal.expandPrefix === 'function')
                ? String(mgrLocal.expandPrefix('rdf:type'))
                : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

              // Query triples directly for the subject + rdf:type predicate
              let typeQuads = store.getQuads(namedNode(subjectUri), namedNode(rdfTypePredicate), null, null) || [];

              // Fallback: some stored subjects may have http/https variants; try to match those if direct lookup returned nothing.
              if ((!typeQuads || typeQuads.length === 0)) {
                try {
                  const altSubjects = [`http:${subjectUri}`, `https:${subjectUri}`];
                  for (const s of altSubjects) {
                    const found = store.getQuads(namedNode(s), namedNode(rdfTypePredicate), null, null) || [];
                    if (found && found.length > 0) {
                      typeQuads = found;
                      break;
                    }
                  }
                } catch (_) {
                  // ignore fallback errors
                }
              }

              if (typeQuads && typeQuads.length > 0) {
                rdfTypesArr = Array.from(new Set(typeQuads.map((q: any) => (q.object && q.object.value) || '').filter(Boolean)));
              }
            }
          } catch (e) {
            // Non-fatal lookup failure; continue with empty rdfTypesArr
          }
        }

        const isTBoxEntity = rdfTypesArr.some((type: string) =>
          type.includes('Class') ||
          type.includes('ObjectProperty') ||
          type.includes('AnnotationProperty') ||
          type.includes('DatatypeProperty')
        );

        const nodeData: NodeData = {
          key: id,
          uri: src.uri || src.iri || id,
          rdfTypes: rdfTypesArr,
          label: badgeText || (dispInfo && dispInfo.short) || shortLocalName(src.uri || src.iri || ''),
          namespace: src.namespace,
          classType: src.classType,
          literalProperties: src.literalProperties || [],
          annotationProperties: src.annotationProperties || [],
          visible: true,
          color,
          hasReasoningError: !!src.hasReasoningError,
          // mark whether this node is a TBox entity so we can render separate canvases/views
          isTBox: !!isTBoxEntity
        };

        // compute a safe namespace key for CSS var fallback
        const nsKeyForVar = ((dispInfo && dispInfo.namespace) || src.namespace || '').toString().replace(/[:#].*$/, '') || 'default';

        // Prefer nodeData.color (mapping), otherwise expose a CSS var fallback referencing the theme's --ns-<key>
        const leftBarVarValue = nodeData.color ? String(nodeData.color) : `hsl(var(--ns-${nsKeyForVar}))`;

        diagramNodes.push({
          id,
          type: 'ontology',
          position: { x: pos.x, y: pos.y },
          data: nodeData,
          // set CSS variable on the node so global CSS (./index.css) can pick up the left bar color
          style: { ['--node-leftbar-color' as any]: leftBarVarValue }
        });
      }

      // Only create edges when both endpoints exist on the canvas (subject and object mapped to nodes).
      // Limit edges to nodes shown in the current viewMode (ABox vs TBox).
      const nodeIdsSet = new Set(
        diagramNodes
          .filter(n => {
            try {
              const isTBox = !!(n.data && (n.data as any).isTBox);
              return viewMode === 'tbox' ? isTBox : !isTBox;
            } catch {
              return true;
            }
          })
          .map(n => n.id)
      );

      for (let j = 0; j < cg.edges.length; j++) {
        const edge = cg.edges[j];
        const src = edge.data || edge;
        const from = canonicalId(resolveKeyForCg(src.source, cg) || String(src.source));
        const to = canonicalId(resolveKeyForCg(src.target, cg) || String(src.target));
        const id = canonicalId(src.id || `e-${from}-${to}-${j}`);

        // Skip edge creation when either endpoint isn't present as a node on the canvas
        if (!nodeIdsSet.has(String(from)) || !nodeIdsSet.has(String(to))) {
          continue;
        }

        const linkData: LinkData = {
          key: id,
          from: String(from),
          to: String(to),
          propertyUri: src.propertyUri || '',
          propertyType: src.propertyType || '',
          label: src.label || '',
          namespace: src.namespace || '',
          rdfType: src.rdfType || '',
        };

        diagramEdges.push({
          id,
          source: String(from),
          target: String(to),
          type: 'floating',
          markerEnd: { type: MarkerType.Arrow },
          data: linkData,
        });
      }

      // Emit a structured mapping snapshot to help diagnose missing edges (captured by startupDebug)
      try {
        debug('reactflow.mapped', {
          nodeIds: diagramNodes.map(n => n.id),
          edgeSamples: diagramEdges.slice(0, 12).map(e => ({ id: e.id, source: e.source, target: e.target }))
        }, { caller: true });
      } catch (_) { /* ignore debug failures */ }

      // Only replace nodes/edges when the computed sets differ from current state to avoid
      // unnecessary re-renders which can trigger repeated computations in child nodes.
      setNodes((prev) => {
        try {
          if (
            prev.length === diagramNodes.length &&
            prev.every((p, idx) => p.id === diagramNodes[idx].id && JSON.stringify(p.data) === JSON.stringify(diagramNodes[idx].data))
          ) {
            return prev;
          }
        } catch (_) { /* fallback to replace */ }
        return diagramNodes;
      });

      if (DEBUG) {
        try { debug('reactflow.nodes.updated', { count: diagramNodes.length, sample: diagramNodes.slice(0,6).map(n => n.id) }, { caller: true }); } catch (_) { /* ignore */ }
      }

      setEdges((prev) => {
        try {
          if (
            prev.length === diagramEdges.length &&
            prev.every((p, idx) =>
              p.id === diagramEdges[idx].id &&
              p.source === diagramEdges[idx].source &&
              p.target === diagramEdges[idx].target &&
              JSON.stringify(p.data) === JSON.stringify(diagramEdges[idx].data)
            )
          ) {
            return prev;
          }
        } catch (_) { /* fallback to replace */ }
        return diagramEdges;
      });

      if (DEBUG) {
        try { debug('reactflow.edges.updated', { count: diagramEdges.length, sample: diagramEdges.slice(0,6).map(e => ({ id: e.id, source: e.source, target: e.target })) }, { caller: true }); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      try { fallback('reactflow.mapping.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ }
      setNodes([]);
      setEdges([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGraph, loadedOntologies, availableClasses, viewMode]);

  // Auto-load demo file and additional ontologies on component mount (mirrors Canvas behavior)
  // This component intentionally does NOT auto-populate the canvas on mount by default.
  // Rationale:
  //  - During debugging we want an empty canvas and deterministic control over when RDF
  //    content is loaded and mapped into the UI.
  //  - Loading persisted demo files or configured ontologies should be an explicit action.
  //
  // To re-enable the previous behaviour for automated runs, either:
  //  - set `window.__VG_ALLOW_PERSISTED_AUTOLOAD = true` before the app mounts, OR
  //  - call the programmatic initializer `window.__VG_INIT_APP()` at runtime.
  //
  // The initializer is exposed on window to allow interactive developer control without
  // re-building the app. It re-uses the existing loading helpers and progress UI.
  const __initializedAppRef = useRef(false);

  const initializeApp = async (opts?: { force?: boolean }) => {
    // Prevent duplicate initialization across React StrictMode remounts by using a
    // global window flag. Allow explicit force to override.
    if (typeof window !== 'undefined' && (window as any).__VG_APP_INITIALIZED && !(opts && opts.force)) return;
    // If this particular component instance already initialized, skip unless forced.
    if (__initializedAppRef.current && !(opts && opts.force)) return;
    __initializedAppRef.current = true;
    if (typeof window !== 'undefined') (window as any).__VG_APP_INITIALIZED = true;

    // Determine whether persisted/autoload behavior is explicitly permitted.
    // Developers may set window.__VG_ALLOW_PERSISTED_AUTOLOAD = true in the console
    // or via test/dev scripts to restore previous auto-load semantics.
    const allowAutoLoad = Boolean(
      (typeof window !== 'undefined' && (window as any).__VG_ALLOW_PERSISTED_AUTOLOAD) ||
      (useAppConfigStore && (useAppConfigStore as any).getState && (useAppConfigStore as any).getState().config && (useAppConfigStore as any).getState().config.allowAutoLoad)
    );

    try {
      canvasActions.setLoading(true, 0, '');
      try { /* instrumentation placeholder */ } catch (_) { /* ignore */ }

      // Prefer stable getters from the Zustand stores if available to avoid re-running
      const ontologyStoreState = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : null;
      const settingsStoreState = (useSettingsStore as any).getState ? (useSettingsStore as any).getState() : null;
      const appConfigState = (useAppConfigStore as any).getState ? (useAppConfigStore as any).getState() : null;

      const loadAdditionalOntologiesFn = ontologyStoreState && ontologyStoreState.loadAdditionalOntologies ? ontologyStoreState.loadAdditionalOntologies : loadAdditionalOntologies;
      const loadKnowledgeGraphFn = ontologyStoreState && ontologyStoreState.loadKnowledgeGraph ? ontologyStoreState.loadKnowledgeGraph : loadKnowledgeGraph;
      // Allow developer overrides at runtime:
      // - __VG_STARTUP_TTL : inline TTL/text to load (preferred, useful for environments with CORS)
      // - __VG_STARTUP_URL : external URL to fetch (fallback)
      const startupUrlFromSettings = settingsStoreState && settingsStoreState.settings ? settingsStoreState.settings.startupFileUrl : (settings && settings.startupFileUrl);
      const startupTtl = (typeof window !== 'undefined' && (window as any).__VG_STARTUP_TTL) ? String((window as any).__VG_STARTUP_TTL) : '';
      const startupUrl = startupTtl ? startupTtl : ((typeof window !== 'undefined' && (window as any).__VG_STARTUP_URL) ? (window as any).__VG_STARTUP_URL : startupUrlFromSettings);

      const additionalOntologies = appConfigState && appConfigState.config ? appConfigState.config.additionalOntologies : (config && config.additionalOntologies);

      // Only perform network/load operations when autorun is explicitly allowed.
      if (allowAutoLoad) {
        // Load additional ontologies from config first
        if (additionalOntologies && additionalOntologies.length > 0 && typeof loadAdditionalOntologiesFn === 'function') {
          canvasActions.setLoading(true, 5, 'Loading configured ontologies...');
          await loadAdditionalOntologiesFn(additionalOntologies, (progress: number, message: string) => {
            canvasActions.setLoading(true, Math.max(progress * 0.5, 5), message);
          });
        }

        // Then load the startup file if configured
        if (startupUrl && typeof loadKnowledgeGraphFn === 'function') {
          canvasActions.setLoading(true, 50, 'Loading demo file...');
          await loadKnowledgeGraphFn(startupUrl, {
            onProgress: (progress: number, message: string) => {
              canvasActions.setLoading(true, Math.max(progress * 0.5 + 50, 50), message);
            }
          });
        }
      } else {
        // When auto-load disabled, just initialize UI state (no RDF/network activity)
        // This keeps the canvas empty and the app responsive for debugging.
        if (DEBUG) {
          try { debug('reactflow.initializeApp.skipped', { reason: 'autoLoadDisabled' }, { caller: true }); } catch (_) { /* ignore */ }
        }
      }

      canvasActions.setLoading(false, 0, '');
    } catch (error) {
      try { fallback('reactflow.initializeApp.failed', { error: (error && (error as Error).message) ? (error as Error).message : String(error) }, { level: 'warn' }); } catch (_) { /* ignore */ }
      canvasActions.setLoading(false, 0, '');
    }
  };

  useEffect(() => {
    // Expose a developer-facing initializer so authors can opt-in to loading the configured
    // ontologies / startup file at runtime without changing app code or env vars.
    if (typeof window !== 'undefined') {
      (window as any).__VG_INIT_APP = async (opts?: any) => {
        try {
          await initializeApp(opts);
        } catch (_) { /* ignore */ }
      };
    }

    // If a calling environment explicitly opted-in before mount, run initialization automatically.
    // Prefer persisted autoload when both persisted and force-on-mount flags are present so we avoid
    // accidentally initializing twice (force-on-mount was historically used for automation/testing).
    const shouldAuto = typeof window !== 'undefined' && !!(window as any).__VG_ALLOW_PERSISTED_AUTOLOAD;
    const forceOnMount = typeof window !== 'undefined' && !!(window as any).__VG_INIT_FORCE_ON_MOUNT;

    if (shouldAuto) {
      // Persisted auto-load requested: run initializer once.
      void initializeApp({ force: true });
    } else if (forceOnMount) {
      // Developer automation: support a force-on-mount flag that enables RDF write tracing
      // and then forces initialization. This is useful for CI/playwright or when the dev
      // entrypoint (main.tsx) sets a flag to reproduce startup writes without manual console work.
      try {
        // Ensure write-logging is enabled so any store.addQuad/removeQuad calls are traced.
        if (typeof (window as any).__VG_ENABLE_RDF_WRITE_LOGGING === 'function') {
          try { (window as any).__VG_ENABLE_RDF_WRITE_LOGGING(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      void initializeApp({ force: true });
      try { delete (window as any).__VG_INIT_FORCE_ON_MOUNT; } catch (_) { /* ignore */ }
    }

    return () => {
      try { delete (window as any).__VG_INIT_APP; } catch (_) { /* ignore */ }
    };
    // Empty deps: run once on mount and rely on stable store.getState() getters above.
  }, []);

  // Trigger reasoning on nodes/edges change
  const triggerReasoning = useCallback(async (ns: RFNode<NodeData>[], es: RFEdge<LinkData>[]) => {
    if (!startReasoning || !settings.autoReasoning) return;
    if (DEBUG) {
      try { debug('reactflow.reasoning.invoke', { nodes: ns.length, edges: es.length }); } catch (_) { /* ignore */ }
    }
    try {
      const nodesPayload = ns.map(n => n.data && n.data.iri ? { iri: n.data.iri, key: n.id } : { key: n.id });
      const edgesPayload = es.map(e => ({ id: e.id, source: e.source, target: e.target }));
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (DEBUG) {
        try { debug('reactflow.reasoning.payload', { nodes: nodesPayload.length, edges: edgesPayload.length }); } catch (_) { /* ignore */ }
      }
      const result = await startReasoning(nodesPayload as any, edgesPayload as any, mgr && mgr.getStore && mgr.getStore());
      if (DEBUG) {
        try { debug('reactflow.reasoning.result', { errorCount: Array.isArray(result.errors) ? result.errors.length : 0 }); } catch (_) { /* ignore */ }
      }
      // Update nodes/edges with hasReasoningError flags
      setNodes((nds) =>
        nds.map(n => {
          const hasNodeErr = !!(Array.isArray(result.errors) && result.errors.find((er: any) => er.nodeId === n.id));
          return { ...n, data: { ...n.data, hasReasoningError: hasNodeErr } };
        })
      );
      setEdges((eds) =>
        eds.map(e => {
          const hasEdgeErr = !!(Array.isArray(result.errors) && result.errors.find((er: any) => er.edgeId === e.id));
          return { ...e, data: { ...e.data, hasReasoningError: hasEdgeErr } };
        })
      );
    } catch (e) {
      try { warn('reactflow.reasoning.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
    }
  }, [setNodes, setEdges, startReasoning, settings.autoReasoning]);

  // Avoid repeatedly triggering reasoning for trivial updates by fingerprinting the
  // inputs that should cause reasoning (node identity, rdf-type, important positions,
  // and edge endpoints). We intentionally exclude transient flags like hasReasoningError
  // so that reasoning results updating nodes don't immediately re-trigger reasoning.
  const lastReasoningFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!startReasoning || !settings.autoReasoning) return;

    try {
      // Build compact fingerprints for nodes and edges (exclude hasReasoningError).
      const nodeSigParts: string[] = nodes.map(n => {
        const d: any = n.data || {};
        const uri = String(d.uri || d.iri || '');
        const rdf = Array.isArray(d.rdfTypes) ? d.rdfTypes.join('|') : '';
        const pos = n.position ? `${Math.round(n.position.x)}:${Math.round(n.position.y)}` : '';
        return `${n.id}|${uri}|${rdf}|${pos}`;
      });
      const edgeSigParts: string[] = edges.map(e => {
        const ed: any = e.data || {};
        const prop = String(ed.propertyUri || ed.propertyType || '');
        return `${e.id}|${e.source}|${e.target}|${prop}`;
      });

      const fp = `${nodeSigParts.join(';')}||${edgeSigParts.join(';')}`;
      if (DEBUG) {
        try { debug('reactflow.reasoning.fp', { fingerprint: fp, nodeCount: nodeSigParts.length, edgeCount: edgeSigParts.length }); } catch (_) { /* ignore */ }
      }

      // If fingerprint unchanged since last reasoning run, skip scheduling.
      if (lastReasoningFingerprintRef.current === fp) {
        return;
      }
      lastReasoningFingerprintRef.current = fp;

      // Debounce scheduling as before
      try {
        if (reasoningTimerRef.current) {
          window.clearTimeout(reasoningTimerRef.current);
          reasoningTimerRef.current = null;
        }
      } catch (_) { /* ignore */ }

      reasoningTimerRef.current = window.setTimeout(() => {
        // scheduled reasoning (fingerprint: fp)
        if (DEBUG) {
          try { debug('reactflow.reasoning.scheduled', { fingerprint: lastReasoningFingerprintRef.current }); } catch (_) { /* ignore */ }
        }
        // If another reasoning run is in progress, skip this scheduled run
        if (reasoningInProgressRef.current) return;
        reasoningInProgressRef.current = true;
        (async () => {
          try {
            if (DEBUG) {
              try { debug('reactflow.reasoning.start', { fingerprint: lastReasoningFingerprintRef.current, nodes: nodes.length, edges: edges.length }); } catch (_) { /* ignore */ }
            }
            await triggerReasoning(nodes, edges);
          } finally {
            reasoningInProgressRef.current = false;
            if (DEBUG) {
              try { debug('reactflow.reasoning.complete', { fingerprint: lastReasoningFingerprintRef.current }); } catch (_) { /* ignore */ }
            }
          }
        })();
      }, 250);

      return () => {
        try {
          if (reasoningTimerRef.current) {
            window.clearTimeout(reasoningTimerRef.current);
            reasoningTimerRef.current = null;
          }
        } catch (_) { /* ignore */ }
      };
    } catch (e) {
      // In case fingerprinting fails, fall back to previous behavior: schedule reasoning.
      try { fallback('reactflow.reasoning.fingerprint_failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ }
      try {
        if (reasoningTimerRef.current) {
          window.clearTimeout(reasoningTimerRef.current);
          reasoningTimerRef.current = null;
        }
      } catch (_) { /* ignore */ }

      reasoningTimerRef.current = window.setTimeout(() => {
        if (reasoningInProgressRef.current) return;
        reasoningInProgressRef.current = true;
        (async () => {
          try {
            await triggerReasoning(nodes, edges);
          } finally {
            reasoningInProgressRef.current = false;
          }
        })();
      }, 250);

      return () => {
        try {
          if (reasoningTimerRef.current) {
            window.clearTimeout(reasoningTimerRef.current);
            reasoningTimerRef.current = null;
          }
        } catch (_) { /* ignore */ }
      };
    }
  }, [nodes, edges, triggerReasoning, startReasoning, settings.autoReasoning]);

  // Selection / double-click handlers
  const onNodeDoubleClick = useCallback((event: any, node: any) => {
    const d = node.data || ({} as NodeData);
    const minimal = {
      key: node.id,
      uri: d.uri || '',
      rdfTypes: d.rdfTypes || [],
      annotationProperties: d.annotationProperties || [],
      hasReasoningError: d.hasReasoningError || false,
      visible: true,
      color: d.color || getNamespaceColor(d.namespace || '')
    };
    canvasActions.setSelectedNode(minimal as any, true);
  }, [canvasActions, getNamespaceColor]);

  const onEdgeDoubleClick = useCallback((event: any, edge: any) => {
    canvasActions.setSelectedLink(edge.data || edge, true);
  }, [canvasActions]);

  // Link creation
  const onConnect = useCallback((params: Connection) => {
    if (DEBUG) {
      try { debug('reactflow.connect.attempt', { params: { source: params.source, target: params.target } }, { caller: true }); } catch (_) { /* ignore */ }
    }
    // basic validation: require source and target
    if (!params.source || !params.target) return;
    const sourceNode = nodes.find(n => n.id === params.source);
    const targetNode = nodes.find(n => n.id === params.target);
    if (!sourceNode || !targetNode) {
      toast.error('Invalid connection endpoints');
      return;
    }
    // Prevent self-loops
    if (params.source === params.target) {
      toast.error('Cannot connect a node to itself');
      return;
    }
    // Prevent cross ABox/TBox connections
    const sourceIsTBox = !!(sourceNode.data && (sourceNode.data as any).isTBox);
    const targetIsTBox = !!(targetNode.data && (targetNode.data as any).isTBox);
    if (sourceIsTBox !== targetIsTBox) {
      toast.error('Cannot connect nodes across ABox and TBox');
      return;
    }

    // Normalize IDs using canonicalId to keep React Flow ids and RDF subjects/objects consistent
    const normalizedParams = {
      ...params,
      source: canonicalId(String(params.source)),
      target: canonicalId(String(params.target)),
      id: canonicalId((params as any).id || `${params.source}-${params.target}`)
    };

    // Choose a default predicate candidate up-front so we can persist and annotate the edge's data
    const predCandidate = (normalizedParams as any).data && (normalizedParams as any).data.propertyUri
      ? (normalizedParams as any).data.propertyUri
      : (availableProperties && availableProperties.length > 0 ? (availableProperties[0].uri || (availableProperties[0] as any).key) : null);
    const predFallback = predCandidate || 'http://www.w3.org/2000/01/rdf-schema#seeAlso';

    // Create the new edge list, and attach a visible data payload (propertyUri/label) so editors display
    const newEdgeList = addEdge({
      ...normalizedParams,
      type: 'floating',
      markerEnd: { type: MarkerType.Arrow },
      data: {
        ...(normalizedParams as any).data,
        propertyUri: predCandidate || predFallback,
        label: (normalizedParams as any).data && (normalizedParams as any).data.label ? (normalizedParams as any).data.label : ''
      }
    } as any, edges) as RFEdge<LinkData>[];

    // Persist the new edge as an RDF triple (subject - predicate - object) into the RDF store.
    try {
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgr && typeof mgr.getStore === 'function') {
        const store = mgr.getStore();
        const subj = (sourceNode.data && (sourceNode.data as NodeData).uri) || sourceNode.id;
        const obj = (targetNode.data && (targetNode.data as NodeData).uri) || targetNode.id;
        const predFull = (mgr.expandPrefix && typeof mgr.expandPrefix === 'function') ? mgr.expandPrefix(predFallback) : predFallback;

        const existing = store.getQuads(namedNode(subj), namedNode(predFull), namedNode(obj), null) || [];
        if (existing.length === 0) {
          store.addQuad(quad(namedNode(subj), namedNode(predFull), namedNode(obj)));
        }
      }
    } catch (e) {
      try { warn('reactflow.persistEdge.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
    }

    // Update application state with the augmented edge data so editors and labels are populated immediately
    setEdges(newEdgeList);

    // choose source/target for editors
    canvasActions.setSelectedLink({ id: normalizedParams.id, ...(normalizedParams as any) }, true);
    linkSourceRef.current = sourceNode.data as NodeData;
    linkTargetRef.current = targetNode.data as NodeData;
  }, [edges, setEdges, nodes, canvasActions, availableProperties]);

  // Node property save handler (mirror previous behavior: update RDF store then node data)
  const handleSaveNodeProperties = useCallback(async (properties: any[]) => {
    if (!canvasState.selectedNode) return;
    const entityUri = (canvasState.selectedNode as any)?.uri || (canvasState.selectedNode as any)?.iri || (canvasState.selectedNode as any)?.key;
    if (!entityUri) return;
    // build payload
    const annotationProperties = (properties || []).map((p: any) => ({
      property: p.key || p.property,
      value: p.value,
      datatype: p.type || 'xsd:string'
    }));
    try {
      updateNode(entityUri, { annotationProperties });
      // Update node locally
      setNodes((nds) => nds.map(n => {
        if (n.id === (canvasState.selectedNode as any)?.key) {
          return { ...n, data: { ...(n.data as NodeData), annotationProperties } as NodeData };
        }
        return n;
      }));
    } catch (e) {
      try { warn('reactflow.saveNode.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
    }
  }, [canvasState.selectedNode, updateNode, setNodes]);

  const handleSaveLinkProperty = useCallback((propertyType: string, label: string) => {
    const selected = canvasState.selectedLink;
    if (!selected) return;
    setEdges((eds) => eds.map(e => {
      const keyMatch = e.id === (selected as any).key || e.id === (selected as any).id;
      if (keyMatch) {
        const newData: LinkData = { ...(e.data as LinkData), propertyType, label };
        return { ...e, data: newData };
      }
      return e;
    }));
  }, [canvasState.selectedLink, setEdges]);

  // Export handler (reuses existing exportGraph)
  const handleExport = useCallback(async (format: 'turtle' | 'owl-xml' | 'json-ld') => {
    try {
      const rdfFormat = format === 'owl-xml' ? 'rdf-xml' : format;
      const content = await exportGraph(rdfFormat as any);
      const blob = new Blob([content], {
        type: format === 'json-ld' ? 'application/ld+json' : format === 'owl-xml' ? 'application/rdf+xml' : 'text/turtle'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledge-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.${format === 'owl-xml' ? 'owl' : format === 'json-ld' ? 'jsonld' : 'ttl'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Graph exported as ${format.toUpperCase()}`);
    } catch (e) {
      toast.error('Export failed');
      try { warn('reactflow.export.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
    }
  }, [exportGraph]);

  // File load handler
  const onLoadFile = useCallback(async (file: File | any) => {
    canvasActions.setLoading(true, 10, 'Reading file...');
    try {
      let text: string;
      if (file.type === 'url' || typeof file === 'string' || file.url) {
        const url = file.url || file;
        canvasActions.setLoading(true, 10, 'Fetching from URL...');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
        text = await response.text();
      } else {
        text = await file.text();
      }
      canvasActions.setLoading(true, 30, 'Parsing RDF...');
      await loadKnowledgeGraph(text, {
        onProgress: (progress: number, message: string) => {
          canvasActions.setLoading(true, Math.max(progress, 30), message);
        }
      });
      toast.success('Knowledge graph loaded successfully');
    } catch (e) {
      try { fallback('reactflow.onLoadFile.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }, { level: 'warn' }); } catch (_) { /* ignore */ }
      toast.error('Failed to load file');
    } finally {
      canvasActions.setLoading(false, 0, '');
    }
  }, [loadKnowledgeGraph, canvasActions]);

  // Basic layout handler: computes deterministic positions and updates nodes.
  const handleLayoutChange = useCallback(async (layoutType: string, force = false) => {
    if (DEBUG) {
      try { debug('reactflow.layout.request', { layoutType, force, layoutEnabled }, { caller: true }); } catch (_) { /* ignore */ }
    }
    // Gate programmatic layout application behind the toolbar toggle unless explicitly forced.
    if (!layoutEnabled && !force) {
      if (DEBUG) { try { debug('reactflow.layout.blocked', { layoutType, force, layoutEnabled }, { caller: true }); } catch (_) { /* ignore */ } }
      toast.info('Layout disabled; enable Layout toggle in toolbar to apply layout');
      return false;
    }

    const current = reactFlowInstance.current;
    if (!current) {
      toast.error('Canvas not ready for layout');
      return false;
    }

    try {
      // Delegate to dagre for graph-style layout types
      if (layoutType === 'layered-digraph' || layoutType === 'dagre' || layoutType === 'hierarchical') {
        setNodes((nds) => {
          try {
            const positioned = applyDagreLayout(nds, edges as any, { direction: 'LR', nodeSep: 60, rankSep: 60 });
            // When using React Flow, positions are set directly on nodes
            return positioned;
          } catch (err) {
            // fallback to previous positions on failure
            return nds;
          }
        });
      } else if (layoutType === 'circular' || layoutType === 'grid' || layoutType === 'force-directed' || layoutType === 'tree') {
        // simple built-in layouts preserved
        setNodes((nds) => {
          const updated = nds.map((n, i) => {
            if (layoutType === 'circular') {
              const r = 240 + (Math.floor(i / 8) * 80);
              const angle = (i / Math.max(1, nds.length)) * Math.PI * 2;
              return { ...n, position: { x: Math.round(400 + r * Math.cos(angle)), y: Math.round(300 + r * Math.sin(angle)) } };
            } else if (layoutType === 'grid') {
              const pos = nodeGridPosition(i);
              return { ...n, position: { x: pos.x, y: pos.y } };
            } else if (layoutType === 'tree') {
              return { ...n, position: { x: i * 200, y: (i % 5) * 120 } };
            } else {
              // force-directed / fallback: simple horizontal spread
              return { ...n, position: { x: i * 200, y: (i % 5) * 120 } };
            }
          });
          return updated;
        });
      } else {
        // unknown layout: no-op
        toast.error(`Unknown layout: ${layoutType}`);
        return false;
      }

      setCurrentLayoutState(layoutType);
      setCurrentLayout(layoutType);
      if (DEBUG) {
        try { debug('reactflow.layout.applied', { layoutType, nodeCount: nodes.length, edgeCount: edges.length }, { caller: true }); } catch (_) { /* ignore */ }
      }
      toast.success(`Applied ${layoutType} layout`, { description: `Graph reorganized with new layout` });
      // try to fit view after layout
      try {
        if (current && typeof (current as any).fitView === 'function') {
          (current as any).fitView();
        }
      } catch (_) { /* ignore */ }
      return true;
    } catch (e) {
      toast.error(`Layout failed: ${(e && (e as Error).message) ? (e as Error).message : String(e)}`);
      return false;
    }
  }, [setNodes, setCurrentLayout, setCurrentLayoutState, edges, layoutEnabled]);

  // Expose programmatic apply layout hook (queue until ready)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const queueName = '__VG_APPLY_LAYOUT_QUEUE';
    (window as any)[queueName] = (window as any)[queueName] || [];

    (window as any).__VG_APPLY_LAYOUT = async (layoutType: string) => {
      const isReady = !!reactFlowInstance.current;
      if (!isReady) {
        return new Promise<boolean>((resolve) => {
          try {
            try { debug('vg.applyLayoutHook.enqueue', { layoutType }); } catch (_) { /* ignore */ }
            (window as any)[queueName].push({ layoutType, resolve });
          } catch (err) {
            try { if (DEBUG) warn('vg.applyLayoutHook.enqueue_failed', { error: String(err) }); } catch (_) { /* ignore */ }
            resolve(false);
          }
        });
      }

      try {
        await handleLayoutChange(layoutType);
        return true;
      } catch (e) {
        try { if (DEBUG) warn('vg.applyLayoutHook.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
        return false;
      }
    };

    return () => {
      try { delete (window as any).__VG_APPLY_LAYOUT; } catch (_) { /* ignore */ }
      try { delete (window as any)[queueName]; } catch (_) { /* ignore */ }
    };
  }, [handleLayoutChange, DEBUG]);

  // Process queue after instance is ready
  useEffect(() => {
    try {
      const q = (window as any).__VG_APPLY_LAYOUT_QUEUE;
      if (q && Array.isArray(q) && q.length > 0) {
        (async () => {
          try {
            try { debug('vg.applyLayout.queue.process.start', { queued: q.length }); } catch (_) { /* ignore */ }
          } catch (_) { /* ignore */ }

          while (q.length > 0) {
            const item = q.shift();
            try {
              try { debug('vg.applyLayout.queue.item', { item: item && item.layoutType ? item.layoutType : item }); } catch (_) { /* ignore */ }
              if (item && item.layoutType) {
                const applied = await handleLayoutChange(item.layoutType);
                try { debug('vg.applyLayout.queue.item.applied', { layoutType: item.layoutType, success: !!applied }); } catch (_) { /* ignore */ }
                if (typeof item.resolve === 'function') {
                  try { item.resolve(true); } catch (_) { /* ignore */ }
                }
              } else {
                try { debug('vg.applyLayout.queue.item.invalid', { item }); } catch (_) { /* ignore */ }
                if (typeof item.resolve === 'function') {
                  try { item.resolve(false); } catch (_) { /* ignore */ }
                }
              }
            } catch (err) {
              try { debug('vg.applyLayout.queue.item.failed', { error: (err && (err as Error).message) ? (err as Error).message : String(err) }); } catch (_) { /* ignore */ }
              if (typeof item?.resolve === 'function') {
                try { item.resolve(false); } catch (_) { /* ignore */ }
              }
            }
          }

          try { debug('vg.applyLayout.queue.process.complete'); } catch (_) { /* ignore */ }
        })();
      }
    } catch (_) { /* ignore */ }
  }, [nodes, edges, handleLayoutChange]);

  // Toolbar callbacks
  const handleToggleLegend = useCallback(() => {
    const newValue = !showLegend;
    setShowLegendState(newValue);
    setShowLegend(newValue);
  }, [showLegend, setShowLegend]);

  const handleViewModeChange = useCallback((mode: 'abox' | 'tbox') => {
    setViewMode(mode);
    setPersistedViewMode(mode);
  }, [setPersistedViewMode]);

  // React Flow init
  const onInit = useCallback((instance: RFInstance) => {
    reactFlowInstance.current = instance;
    if (DEBUG) {
      try { debug('reactflow.onInit', { hasInstance: !!instance }, { caller: true }); } catch (_) { /* ignore */ }
    }

    // Dev-only: load a hard-coded demo TTL into the RDF store after canvas is ready (no server dependency).
    // This runs only in development and only once per session.
    if (typeof window !== 'undefined' && import.meta.env.DEV) {
      (async () => {
        try {
          if ((window as any).__VG_DEV_DEMO_LOADED) {
            try { console.debug('[VG] dev demo already loaded'); } catch (_) { /* ignore */ }
            return;
          }

          const DEV_DEMO_TTL = `
            @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
            @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
            @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
            @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
            @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

            :SpecimenLength a iof-qual:Length ;
                iof:masuredByAtSomeTime :Caliper .

            :Caliper a iof-mat:MeasurementDevice .
          `;

          if (DEV_DEMO_TTL && typeof loadKnowledgeGraph === 'function') {
            try {
              canvasActions.setLoading(true, 5, 'Loading dev demo TTL (embedded)...');
            } catch (_) { /* ignore */ }

            try {
              await loadKnowledgeGraph(DEV_DEMO_TTL, {
                onProgress: (progress: number, message: string) => {
                  try { canvasActions.setLoading(true, Math.max(progress, 5), message); } catch (_) { /* ignore */ }
                }
              });
              try { console.debug('[VG] dev TTL loaded via loadKnowledgeGraph (embedded)'); } catch (_) { /* ignore */ }
            } catch (err) {
              try { console.error('[VG] loadKnowledgeGraph failed', err); } catch (_) { /* ignore */ }
            } finally {
              try { canvasActions.setLoading(false, 0, ''); } catch (_) { /* ignore */ }
            }
          } else {
            try { console.warn('[VG] dev TTL invalid or loadKnowledgeGraph unavailable'); } catch (_) { /* ignore */ }
          }

          (window as any).__VG_DEV_DEMO_LOADED = true;
        } catch (e) {
          try { console.error('[VG] dev TTL load failed', e); } catch (_) { /* ignore */ }
        }
      })();
    }
  }, [loadKnowledgeGraph, canvasActions, DEBUG]);


  // Compute displayed nodes/edges based on viewMode so only intra-canvas edges render
  const displayedNodes = useMemo(() => {
    return nodes.filter(n => {
      try {
         const isTBox = !!(n.data && (n.data as any).isTBox);
        return viewMode === 'tbox' ? isTBox : !isTBox;
      } catch {
        return true;
      }
    });
  }, [nodes, viewMode]);

  const displayedNodeIds = useMemo(() => new Set(displayedNodes.map(n => n.id)), [displayedNodes]);

  const displayedEdges = useMemo(() => {
    // Show edges when both endpoints exist in the nodes state and the endpoints belong to the current viewMode.
    // This is more robust against id-normalization differences (uri vs key) than strict set membership.
    return edges.filter(e => {
      const sId = String(e.source);
      const tId = String(e.target);
      const sNode = nodes.find(n => String(n.id) === sId);
      const tNode = nodes.find(n => String(n.id) === tId);
      if (!sNode || !tNode) return false;
      const sIsTBox = !!(sNode.data && (sNode.data as any).isTBox);
      const tIsTBox = !!(tNode.data && (tNode.data as any).isTBox);
      // require both endpoints to be same domain
      if (sIsTBox !== tIsTBox) return false;
      // only show edges that match current view mode (tbox vs abox)
      return viewMode === 'tbox' ? sIsTBox : !sIsTBox;
    });
  }, [edges, nodes, viewMode]);

  // Debugging: record counts in startupDebug and console to help diagnose "no edges" issue
  useEffect(() => {
    try {
      const payload = {
        viewMode,
        nodes: nodes.length,
        displayedNodes: displayedNodes.length,
        edges: edges.length,
        displayedEdges: displayedEdges.length,
        sampleEdge: displayedEdges.length > 0 ? displayedEdges[0] : null
      };
      // structured runtime logger (startupDebug) — will persist into window.__VG_DEBUG_SUMMARY__
      try { debug('reactflow.displayedCounts', payload, { caller: true }); } catch (_) { /* ignore */ }
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.debug('[VG] displayed counts', payload);
      }
    } catch (_) { /* ignore */ }
  }, [DEBUG, viewMode, nodes, displayedNodes, edges, displayedEdges]);

  // Relinking handlers kept for future use; React Flow typings in this build may not expose onEdgeUpdate props.
  const onEdgeUpdate = useCallback((oldEdge: RFEdge<LinkData>, connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = nodes.find(n => n.id === connection.source);
    const targetNode = nodes.find(n => n.id === connection.target);
    if (!sourceNode || !targetNode) {
      toast.error('Invalid edge update endpoints');
      return;
    }
    if (connection.source === connection.target) {
      toast.error('Cannot create self-loop');
      return;
    }
    const sourceIsTBox = !!(sourceNode.data && (sourceNode.data as any).isTBox);
    const targetIsTBox = !!(targetNode.data && (targetNode.data as any).isTBox);
    if (sourceIsTBox !== targetIsTBox) {
      toast.error('Cannot relink edge across ABox and TBox');
      return;
    }

    // Persist change: remove old triple and add new triple using RDF manager
    try {
      const mgr = getRdfManagerRef.current && getRdfManagerRef.current();
      if (mgr && typeof mgr.getStore === 'function') {
        const store = mgr.getStore();
        const oldData = oldEdge && oldEdge.data ? (oldEdge.data as LinkData) : undefined;
        const oldPredCandidate = oldData && (oldData.propertyUri || oldData.propertyType) ? (oldData.propertyUri || oldData.propertyType) : (availableProperties && availableProperties.length > 0 ? (availableProperties[0].uri || (availableProperties[0] as any).key) : 'http://www.w3.org/2000/01/rdf-schema#seeAlso');
        const oldPredFull = (mgr.expandPrefix && typeof mgr.expandPrefix === 'function') ? mgr.expandPrefix(oldPredCandidate) : oldPredCandidate;
        const oldSubj = oldEdge.source;
        const oldObj = oldEdge.target;

        // remove matching quads
        try {
          const found = store.getQuads(namedNode(oldSubj), namedNode(oldPredFull), namedNode(oldObj), null) || [];
          found.forEach((q: any) => {
            try { store.removeQuad(q); } catch (_) { /* ignore */ }
          });
        } catch (_) { /* ignore */ }

        // add new quad
        const subj = (sourceNode.data && (sourceNode.data as NodeData).uri) || sourceNode.id;
        const obj = (targetNode.data && (targetNode.data as NodeData).uri) || targetNode.id;
        const exists = store.getQuads(namedNode(subj), namedNode(oldPredFull), namedNode(obj), null) || [];
        if (exists.length === 0) {
          store.addQuad(quad(namedNode(subj), namedNode(oldPredFull), namedNode(obj)));
        }
      }
    } catch (e) {
      try { warn('reactflow.persistEdgeUpdate.failed', { error: (e && (e as Error).message) ? (e as Error).message : String(e) }); } catch (_) { /* ignore */ }
    }

    setEdges((eds) => eds.map(e => e.id === oldEdge.id ? { ...e, source: connection.source!, target: connection.target! } : e));
  }, [nodes, setEdges, availableProperties]);

  const onEdgeUpdateEnd = useCallback(() => {
    // no-op: reasoning/update pipeline will run on edges change
  }, []);

  return (
    <div className="w-full h-screen bg-canvas-bg relative">
      <CanvasToolbar
        onAddNode={(uri: string) => {
          const id = `node-${Date.now()}`;
          // compute a sensible starting position: center of viewport projected into graph coords
          let startPos = { x: 200, y: 200 };
          try {
            const inst = reactFlowInstance.current;
            if (inst && typeof (inst as any).project === 'function') {
              const center = (inst as any).project({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
              startPos = { x: Math.round(center.x), y: Math.round(center.y) };
            }
          } catch (_) { /* ignore projection failures; use fallback */ }

          setNodes((nds) => {
            // avoid exact overlap with existing nodes by stepping if needed
            const existingPositions = new Set(nds.map(n => `${Math.round(n.position?.x || 0)}:${Math.round(n.position?.y || 0)}`));
            const step = 48;
            const maxAttempts = 50;
            const candidate = { ...startPos };
            let attempts = 0;
            while (existingPositions.has(`${candidate.x}:${candidate.y}`) && attempts < maxAttempts) {
              candidate.x += step;
              candidate.y += (attempts % 5 === 0) ? step : 0;
              attempts++;
            }

            return [
              ...nds,
              {
                id,
                type: 'ontology',
                position: { x: candidate.x, y: candidate.y },
                data: {
                  key: id,
                  uri,
                  rdfTypes: [],
                  literalProperties: [],
                  annotationProperties: [],
                  hasReasoningError: false,
                  visible: true,
                  color: getNamespaceColor(''),
                  label: uri
                } as NodeData
              }
            ];
          });
        }}
        onToggleLegend={handleToggleLegend}
        showLegend={showLegend}
        onExport={handleExport}
        onLoadFile={onLoadFile}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onLayoutChange={handleLayoutChange}
        currentLayout={currentLayout}
        availableEntities={allEntities}
          layoutEnabled={layoutEnabled}
          onToggleLayoutEnable={(enabled: boolean) => {
            setLayoutEnabled(enabled);
            if (enabled) {
              // apply current layout immediately when enabling
              void handleLayoutChange(currentLayout, true);
            }
          }}
      />

      {canvasState.isLoading && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-50 bg-card p-4 rounded-lg shadow-lg min-w-96">
          <div className="space-y-2">
            <div className="text-sm font-medium">{canvasState.loadingMessage}</div>
            <Progress value={canvasState.loadingProgress} className="w-full" />
            <div className="text-xs text-muted-foreground">{canvasState.loadingProgress}%</div>
          </div>
        </div>
      )}

      <div className="w-full h-full">
        {/*
          Render a single ReactFlow instance but pass only the nodes appropriate for the current viewMode.
          Nodes are marked with node.data.isTBox during mapping above; we filter accordingly so ABox and TBox
          views show separate canvases/sets of nodes while retaining shared edges/state.
        */}
        {/* SVG marker definitions for edge arrowheads (temporary debug marker) */}
        <svg style={{ position: 'absolute', top: 0, left: 0 }}>
          <defs>
            <marker
              id="logo"
              viewBox="0 0 40 40"
              markerHeight={20}
              markerWidth={20}
              refX={20}
              refY={40}
            >
              <path
                d="M35 23H25C23.8954 23 23 23.8954 23 25V35C23 36.1046 23.8954 37 25 37H35C36.1046 37 37 36.1046 37 35V25C37 23.8954 36.1046 23 35 23Z"
                stroke="#1A192B"
                strokeWidth="2"
                fill="white"
              />
              <path
                d="M35 3H25C23.8954 3 23 3.89543 23 5V15C23 16.1046 23.8954 17 25 17H35C36.1046 17 37 16.1046 37 15V5C37 3.89543 36.1046 3 35 3Z"
                stroke="#FF0072"
                strokeWidth="2"
                fill="white"
              />
              <path
                d="M15 23H5C3.89543 23 3 23.8954 3 25V35C3 36.1046 3.89543 37 5 37H15C16.1046 37 17 36.1046 17 35V25C17 23.8954 16.1046 23 15 23Z"
                stroke="#1A192B"
                strokeWidth="2"
                fill="white"
              />
              <path
                d="M15 3H5C3.89543 3 3 3.89543 3 5V15C3 16.1046 3.89543 17 5 17H15C16.1046 17 17 16.1046 17 15V5C17 3.89543 16.1046 3 15 3Z"
                stroke="#1A192B"
                strokeWidth="2"
                fill="white"
              />
              <path
                d="M17 13C18.6569 13 20 11.6569 20 10C20 8.34315 18.6569 7 17 7C15.3431 7 14 8.34315 14 10C14 11.6569 15.3431 13 17 13Z"
                fill="white"
              />
              <path
                d="M23 13C24.6569 13 26 11.6569 26 10C26 8.34315 24.6569 7 23 7C21.3431 7 20 8.34315 20 10C20 11.6569 21.3431 13 23 13Z"
                fill="white"
              />
              <path
                d="M30 20C31.6569 20 33 18.6569 33 17C33 15.3431 31.6569 14 30 14C28.3431 14 27 15.3431 27 17C27 18.6569 28.3431 20 30 20Z"
                fill="white"
              />
              <path
                d="M30 26C31.6569 26 33 24.6569 33 23C33 21.3431 31.6569 20 30 20C28.3431 20 27 21.3431 27 23C27 24.6569 28.3431 26 30 26Z"
                fill="white"
              />
              <path
                d="M17 33C18.6569 33 20 31.6569 20 30C20 28.3431 18.6569 27 17 27C15.3431 27 14 28.3431 14 30C14 31.6569 15.3431 33 17 33Z"
                fill="white"
              />
              <path
                d="M23 33C24.6569 33 26 31.6569 26 30C26 28.3431 24.6569 27 23 27C21.3431 27 20 28.3431 20 30C20 31.6569 21.3431 33 23 33Z"
                fill="white"
              />
              <path
                d="M30 25C31.1046 25 32 24.1046 32 23C32 21.8954 31.1046 21 30 21C28.8954 21 28 21.8954 28 23C28 24.1046 28.8954 25 30 25Z"
                fill="#1A192B"
              />
              <path
                d="M17 32C18.1046 32 19 31.1046 19 30C19 28.8954 18.1046 28 17 28C15.8954 28 15 28.8954 15 30C15 31.1046 15.8954 32 17 32Z"
                fill="#1A192B"
              />
              <path
                d="M23 32C24.1046 32 25 31.1046 25 30C25 28.8954 24.1046 28 23 28C21.8954 28 21 28.8954 21 30C21 31.1046 21.8954 32 23 32Z"
                fill="#1A192B"
              />
              <path opacity="0.35" d="M22 9.5H18V10.5H22V9.5Z" fill="#1A192B" />
              <path
                opacity="0.35"
                d="M29.5 17.5V21.5H30.5V17.5H29.5Z"
                fill="#1A192B"
              />
              <path opacity="0.35" d="M22 29.5H18V30.5H22V29.5Z" fill="#1A192B" />
              <path
                d="M17 12C18.1046 12 19 11.1046 19 10C19 8.89543 18.1046 8 17 8C15.8954 8 15 8.89543 15 10C15 11.1046 15.8954 12 17 12Z"
                fill="#1A192B"
              />
              <path
                d="M23 12C24.1046 12 25 11.1046 25 10C25 8.89543 24.1046 8 23 8C21.8954 8 21 8.89543 21 10C21 11.1046 21.8954 12 23 12Z"
                fill="#FF0072"
              />
              <path
                d="M30 19C31.1046 19 32 18.1046 32 17C32 15.8954 31.1046 15 30 15C28.8954 15 28 15.8954 28 17C28 18.1046 28.8954 19 30 19Z"
                fill="#FF0072"
              />
            </marker>
          </defs>
        </svg>
        <ReactFlow
          nodes={displayedNodes}
          edges={displayedEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={onInit}
          onNodeDoubleClick={onNodeDoubleClick}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onConnect={onConnect}
        nodeTypes={{ ontology: OntologyNode }}
        edgeTypes={{ floating: FloatingEdge }}
        connectionLineComponent={FloatingConnectionLine}
        className="knowledge-graph-canvas bg-canvas-bg"
      >
          <Controls position="bottom-left" showInteractive={true} showZoom={true} showFitView={true} />
          <Background gap={16} color="var(--grid-color, rgba(0,0,0,0.03))" />
        </ReactFlow>
      </div>

      {showLegend && <ResizableNamespaceLegend onClose={() => handleToggleLegend()} />}

      <ReasoningIndicator
        onOpenReport={() => canvasActions.toggleReasoningReport(true)}
        onRunReason={() => {
          try {
            // Manual reasoning trigger tied to the current React Flow node/edge state
            triggerReasoning(nodes, edges);
          } catch (e) {
            // UI-level safeguard: do not throw from click handler
            // eslint-disable-next-line no-console
            console.warn('manual reasoning trigger failed', e);
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
          if (DEBUG) debug('reactflow.nodeEditor.openChange', { open }, { caller: true });
          canvasActions.toggleNodeEditor(open);
        }}
        nodeData={canvasState.selectedNode}
        availableEntities={allEntities}
        onSave={handleSaveNodeProperties}
      />

      <LinkPropertyEditor
        open={canvasState.showLinkEditor}
        onOpenChange={canvasActions.toggleLinkEditor}
        linkData={canvasState.selectedLink}
        sourceNode={linkSourceRef.current}
        targetNode={linkTargetRef.current}
        onSave={handleSaveLinkProperty}
      />
    </div>
  );
};

export default ReactFlowCanvas;
