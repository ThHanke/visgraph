import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { UnifiedSearchTopic } from '@reactodia/workspace';
// useOntologyStore must be imported before rdfManager to avoid a TDZ circular-dep error:
// rdfManager.ts → rdfManager.impl.ts → ontologyStore.ts → rdfManager (TDZ if rdfManager starts first)
import { useOntologyStore } from '@/stores/ontologyStore';
import { rdfManager } from '@/utils/rdfManager';
import { DataFactory } from 'n3';
const { namedNode } = DataFactory;
import type { ReasoningResult } from '@/utils/rdfManager';
import { N3DataProvider, VG_GRAPH_NAME_PROP, VG_GRAPH_NAME_STATE, type ViewMode } from '@/providers/N3DataProvider';
import { RdfMetadataProvider } from '@/providers/RdfMetadataProvider';
import { RdfValidationProvider } from '@/providers/RdfValidationProvider';
import { workerQuadsToRdf, type WorkerQuad as ConverterQuad } from '@/providers/quadConverter';
import type { WorkerQuad } from '@/utils/rdfSerialization';
import { TopBar } from './TopBar';
import { LeftSidebar } from './LeftSidebar';
import { ConfigurationPanel } from './ConfigurationPanel';
import { ReasoningReportModal } from './ReasoningReportModal';
import { useCanvasState } from '@/hooks/useCanvasState';
import { rdfElementTemplateResolver } from '@/templates/RdfElementTemplate';
import { rdfLinkTemplateResolver } from '@/templates/RdfLinkTemplate';
import { PrefixContext } from '@/providers/PrefixContext';
import { generateEntityIri } from '@/utils/iriUtils';
import ResizableNamespaceLegend from './ResizableNamespaceLegend';
import { useAppConfigStore } from '@/stores/appConfigStore';
import { getLayoutFunction } from './layout/getLayoutFunction';
import { applyCanvasClustering, clearCanvasClustering } from './core/clusteringService';
import { runSilentLayout, type SilentLayoutEdge } from './layout/silentLayout';
import type { ClusterNode, ClusterEdge } from './core/clusterAlgorithms/types';
import { computeClustersLabelPropagation } from './core/clusterAlgorithms/labelPropagation';
import { computeClustersLouvainNgraph } from './core/clusterAlgorithms/louvainNgraph';
import { computeClustersKmeans } from './core/clusterAlgorithms/kmeans';
import type { AppConfig } from '@/stores/appConfigStore';
import { LayoutPopover } from './LayoutPopover';
import { RdfPropertyEditor } from './rdfPropertyEditor';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { WELL_KNOWN_PREFIXES } from '@/utils/wellKnownOntologies';

function extractNamespace(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash > 0) return iri.slice(0, hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash > 0) return iri.slice(0, slash + 1);
  return iri;
}

// Must be at module scope — not inside a component
const Layouts = Reactodia.defineLayoutWorker(() =>
  new Worker(new URL('@reactodia/workspace/layout.worker', import.meta.url), { type: 'module' })
);

// Singletons — one per app lifetime
export const dataProvider = new N3DataProvider();
const metadataProvider = new RdfMetadataProvider(rdfManager, dataProvider);
const validationProvider = new RdfValidationProvider();

// Track all subject IRIs ever seen (for initial load and incremental adds)
const knownSubjects = new Set<string>();


/**
 * Flush all staged authoring state to the RDF store in one batch per subject.
 * This is the vanilla Reactodia pattern: stage many edits, then commit once.
 */
async function flushAuthoringState(
  editor: Reactodia.EditorController,
  model: Reactodia.DataDiagramModel,
): Promise<void> {
  const state = editor.authoringState;
  if (Reactodia.AuthoringState.isEmpty(state)) return;

  const removes: any[] = [];
  const adds: any[] = [];

  // Collect canvas-model cleanup tasks to run after the RDF write
  const linksToRemove: Reactodia.Link[] = [];
  const elementsToRemove: Reactodia.Element[] = [];

  // --- Relations ---
  for (const [, event] of state.links) {
    if (event.type === 'relationAdd') {
      // Already written by metadataProvider.createRelation — idempotent add
      adds.push({ subject: namedNode(event.data.sourceId), predicate: namedNode(event.data.linkTypeId), object: namedNode(event.data.targetId) });
    } else if (event.type === 'relationDelete') {
      removes.push({ subject: namedNode(event.data.sourceId), predicate: namedNode(event.data.linkTypeId), object: namedNode(event.data.targetId) });
      // Remove the link from the canvas model
      const link = model.findLink(event.data.linkTypeId as Reactodia.LinkTypeIri, event.data.sourceId as Reactodia.ElementIri, event.data.targetId as Reactodia.ElementIri);
      if (link) linksToRemove.push(link);
    } else if (event.type === 'relationChange') {
      removes.push({ subject: namedNode(event.before.sourceId), predicate: namedNode(event.before.linkTypeId), object: namedNode(event.before.targetId) });
      adds.push({ subject: namedNode(event.data.sourceId), predicate: namedNode(event.data.linkTypeId), object: namedNode(event.data.targetId) });
      // Remove the old link — changeRelation already added the new one to the canvas
      const oldLink = model.findLink(event.before.linkTypeId as Reactodia.LinkTypeIri, event.before.sourceId as Reactodia.ElementIri, event.before.targetId as Reactodia.ElementIri);
      if (oldLink) linksToRemove.push(oldLink);
    }
  }

  // --- Entities ---
  for (const [, event] of state.elements) {
    if (event.type === 'entityAdd') {
      const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
      for (const typeIri of event.data.types) {
        adds.push({ subject: namedNode(event.data.id), predicate: namedNode(rdfType), object: namedNode(typeIri) });
      }
      for (const [propIri, terms] of Object.entries(event.data.properties)) {
        for (const t of terms) adds.push({ subject: namedNode(event.data.id), predicate: namedNode(propIri), object: t });
      }
    } else if (event.type === 'entityDelete') {
      // Remove all quads for this subject via the data provider's internal dataset
      const dataset = (dataProvider as any).inner?.dataset;
      if (dataset) {
        for (const q of dataset.iterateMatches(namedNode(event.data.id), null, null)) {
          removes.push({ subject: namedNode((q.subject as any).value), predicate: namedNode((q.predicate as any).value), object: q.object });
        }
      }
      const el = model.elements.find(e => e instanceof Reactodia.EntityElement && e.data.id === event.data.id);
      if (el) elementsToRemove.push(el);
    } else if (event.type === 'entityChange') {
      const beforeSubj = namedNode(event.before.id);
      const afterSubj  = namedNode(event.data.id);
      const iriChanged = event.before.id !== event.data.id;
      const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

      if (iriChanged) {
        // IRI rename: remove ALL triples from old subject, add all to new subject
        for (const t of event.before.types) {
          removes.push({ subject: beforeSubj, predicate: namedNode(rdfType), object: namedNode(t) });
        }
        for (const [propIri, oldTerms] of Object.entries(event.before.properties)) {
          for (const t of oldTerms) removes.push({ subject: beforeSubj, predicate: namedNode(propIri), object: t });
        }
        for (const t of event.data.types) {
          adds.push({ subject: afterSubj, predicate: namedNode(rdfType), object: namedNode(t) });
        }
        for (const [propIri, newTerms] of Object.entries(event.data.properties)) {
          for (const t of newTerms) adds.push({ subject: afterSubj, predicate: namedNode(propIri), object: t });
        }
      } else {
        // Same IRI: diff types and properties
        const beforeTypes = new Set(event.before.types);
        const afterTypes  = new Set(event.data.types);
        for (const t of beforeTypes) {
          if (!afterTypes.has(t)) removes.push({ subject: afterSubj, predicate: namedNode(rdfType), object: namedNode(t) });
        }
        for (const t of afterTypes) {
          if (!beforeTypes.has(t)) adds.push({ subject: afterSubj, predicate: namedNode(rdfType), object: namedNode(t) });
        }
        for (const [propIri, oldTerms] of Object.entries(event.before.properties)) {
          for (const t of oldTerms) removes.push({ subject: afterSubj, predicate: namedNode(propIri), object: t });
        }
        for (const [propIri, newTerms] of Object.entries(event.data.properties)) {
          for (const t of newTerms) adds.push({ subject: afterSubj, predicate: namedNode(propIri), object: t });
        }
      }
    }
  }

  if (removes.length > 0 || adds.length > 0) {
    await rdfManager.applyBatch({ removes, adds }, 'urn:vg:data');
  }

  // Clean up canvas model — must happen in a microtask to stay outside React's render cycle
  queueMicrotask(() => {
    for (const link of linksToRemove) model.removeLink(link.id);
    for (const el of elementsToRemove) model.removeElement(el.id);
  });

  // Clear the authoring state — changes are now in the RDF store
  editor.setAuthoringState(Reactodia.AuthoringState.empty);
}

// Current view mode state
let currentViewMode: ViewMode = 'abox';

// Persisted layout per view mode, saved via model.exportLayout() before each switch
const savedLayoutsByMode: Partial<Record<ViewMode, Reactodia.SerializedDiagram>> = {};

/**
 * Collect all entity IRIs currently represented on the canvas — both standalone
 * EntityElements and members embedded inside EntityGroups. Used to avoid
 * re-creating elements that are already present (possibly inside a group).
 */
function collectCanvasIris(elements: ReadonlyArray<Reactodia.Element>): Set<string> {
  const iris = new Set<string>();
  for (const el of elements) {
    for (const entity of Reactodia.iterateEntitiesOf(el)) {
      iris.add(entity.id);
    }
  }
  return iris;
}

async function applyInitialGrouping(
  ctx: Reactodia.WorkspaceContext,
  canvas: Reactodia.CanvasApi,
  algorithm: 'louvain' | 'label-propagation' | 'kmeans',
  entityElements: Reactodia.EntityElement[],
  relationLinks: Reactodia.RelationLink[]
): Promise<void> {
  const connectivity = new Map<string, number>();
  for (const el of entityElements) connectivity.set(el.data.id, 0);
  for (const lk of relationLinks) {
    connectivity.set(lk.data.sourceId, (connectivity.get(lk.data.sourceId) ?? 0) + 1);
    connectivity.set(lk.data.targetId, (connectivity.get(lk.data.targetId) ?? 0) + 1);
  }

  const clusterNodes: ClusterNode[] = entityElements.map(el => ({
    id: el.data.id,
    connectivity: connectivity.get(el.data.id) ?? 0,
    position: { x: el.position.x, y: el.position.y },
  }));
  const clusterEdges: ClusterEdge[] = relationLinks.map(lk => ({
    id: lk.id,
    source: lk.data.sourceId,
    target: lk.data.targetId,
  }));

  let result: ReturnType<typeof computeClustersLabelPropagation>;
  switch (algorithm) {
    case 'louvain':           result = computeClustersLouvainNgraph(clusterNodes, clusterEdges, { threshold: 2 }); break;
    case 'label-propagation': result = computeClustersLabelPropagation(clusterNodes, clusterEdges, { threshold: 2 }); break;
    case 'kmeans':            result = computeClustersKmeans(clusterNodes, clusterEdges, { threshold: 2 }); break;
    default: {
      const _: never = algorithm;
      throw new Error(`Unknown algorithm: ${_}`);
    }
  }

  const { clusters } = result;
  if (clusters.size === 0) return;

  const elementByIri = new Map(entityElements.map(el => [el.data.id, el]));
  const alreadyGrouped = new Set<string>();
  const groupPlans: Reactodia.EntityElement[][] = [];

  for (const [, clusterInfo] of clusters) {
    const members: Reactodia.EntityElement[] = [];
    for (const iri of clusterInfo.nodeIds) {
      if (alreadyGrouped.has(iri)) continue;
      const el = elementByIri.get(iri);
      if (el) members.push(el);
    }
    if (members.length < 2) continue;
    for (const m of members) alreadyGrouped.add(m.data.id);
    groupPlans.push(members);
  }

  for (const members of groupPlans) {
    ctx.model.group(members);
  }
  canvas.renderingState.syncUpdate();
}

async function performInitialClustering(
  ctx: Reactodia.WorkspaceContext,
  model: Reactodia.DataDiagramModel,
  cfg: AppConfig,
  layoutFn: Reactodia.LayoutFunction,
  silentLayoutPositions: React.MutableRefObject<Map<string, Reactodia.Vector> | null>,
  preClusterPositions: React.MutableRefObject<Map<string, Reactodia.Vector> | null>
): Promise<void> {
  const canvas = ctx.view.findAnyCanvas();
  if (!canvas) return;

  const entityElements = model.elements.filter(
    (el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement
  );
  const relationLinks = model.links.filter(
    (lk): lk is Reactodia.RelationLink => lk instanceof Reactodia.RelationLink
  );

  if (entityElements.length < 2) return;

  const clusterEdges: SilentLayoutEdge[] = relationLinks.map(lk => ({
    source: lk.data.sourceId,
    target: lk.data.targetId,
  }));

  await applyInitialGrouping(ctx, canvas, cfg.clusteringAlgorithm as 'louvain' | 'label-propagation' | 'kmeans', entityElements, relationLinks);

  // Snapshot pre-cluster positions so handleExpandAll has a fallback
  // if the silent background layout has not completed when user expands.
  preClusterPositions.current = new Map(
    entityElements.map(el => [el.data.id, { ...el.position }])
  );

  const groups = model.elements.filter(
    (el): el is Reactodia.EntityGroup => el instanceof Reactodia.EntityGroup
  );
  const ungrouped = model.elements.filter(
    (el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement
  );
  const topLevelElements = new Set<Reactodia.Element>([...groups, ...ungrouped]);

  await ctx.performLayout({
    layoutFunction: layoutFn,
    selectedElements: topLevelElements,
    animate: false,
  });

  const allIris: string[] = [];
  for (const el of model.elements) {
    if (el instanceof Reactodia.EntityGroup) {
      for (const item of el.items) allIris.push(item.data.id);
    } else if (el instanceof Reactodia.EntityElement) {
      allIris.push(el.data.id);
    }
  }

  runSilentLayout(layoutFn, allIris, clusterEdges).then(positions => {
    silentLayoutPositions.current = positions;
    console.log('[Canvas] Silent background layout complete —', positions.size, 'positions stored');
  }).catch(err => {
    console.warn('[Canvas] Silent background layout failed:', err);
  });
}

export default function ReactodiaCanvas() {
  const { defaultLayout } = Reactodia.useWorker(Layouts);
  const { state: canvasState, actions } = useCanvasState();
  const [sidebarExpanded, setSidebarExpanded] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [loadOntologyOpen, setLoadOntologyOpen] = React.useState(false);
  const [ontologyUrlInput, setOntologyUrlInput] = React.useState('');
  const [isReasoning, setIsReasoning] = React.useState(false);
  const [isClustered, setIsClustered] = React.useState(false);
  const [currentReasoning, setCurrentReasoning] = React.useState<ReasoningResult | null>(null);
  const [reasoningHistory, setReasoningHistory] = React.useState<ReasoningResult[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const performLayoutRef = React.useRef<(() => Promise<void>) | null>(null);
  const preClusterPositions = React.useRef<Map<string, Reactodia.Vector> | null>(null);
  const silentLayoutPositions = React.useRef<Map<string, Reactodia.Vector> | null>(null);

  const ontologyCount = useOntologyStore(s => s.loadedOntologies?.length ?? 0);
  const namespaces = useOntologyStore(s => Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []);
  const loadKnowledgeGraph = useOntologyStore(s => s.loadKnowledgeGraph);
  const loadAdditionalOntologies = useOntologyStore(s => s.loadAdditionalOntologies);

  // prefixes: prefix -> namespace URI (for PrefixContext consumers)
  const prefixes = React.useMemo(
    () => Object.fromEntries(
      namespaces
        .filter((n) => !!n.namespace)
        .map((n) => [n.prefix, n.namespace])
    ),
    [namespaces]
  );

  // nsColorMap: namespace URI -> color (for typeStyleResolver)
  const nsColorMap = React.useMemo(
    () => {
      const map: Record<string, string> = {};
      for (const n of namespaces) {
        if (n.namespace && n.color) map[n.namespace] = n.color;
      }
      return map;
    },
    [namespaces]
  );

  const typeStyleResolver = React.useCallback<Reactodia.TypeStyleResolver>(
    (types) => {
      const ns = extractNamespace(types[0] ?? '');
      const color = nsColorMap[ns];
      return color ? { color } : undefined;
    },
    [nsColorMap]
  );

  const modelRef = React.useRef<Reactodia.DataDiagramModel | null>(null);
  const commandBusRef = React.useRef<((topic: any) => any) | null>(null);
  const contextRef = React.useRef<Reactodia.WorkspaceContext | null>(null);
  const flushAuthoringStateRef = React.useRef<(() => Promise<void>) | null>(null);

  const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
    const { model, view, editor, getCommandBus } = context;
    modelRef.current = model;
    commandBusRef.current = getCommandBus;
    contextRef.current = context;

    // Enable authoring mode so link/element halo buttons (edit, delete, move) are visible
    editor.setAuthoringMode(true);

    // Wire up the toolbar "Re-layout" button with its own AbortController,
    // independent of the init signal. Omitting layoutFunction lets the Workspace
    // use the worker-based defaultLayout passed via the defaultLayout prop.
    performLayoutRef.current = () => {
      const ctx = contextRef.current;
      if (!ctx) return Promise.resolve();
      const controller = new AbortController();
      const cfg = (useAppConfigStore as any).getState().config;
      return ctx.performLayout({
        layoutFunction: getLayoutFunction(cfg.currentLayout, cfg, defaultLayout),
        animate: cfg.layoutAnimations,
        signal: controller.signal,
      });
    };

    // Start with an empty canvas. Elements arrive via the onSubjectsChange handler
    // (including the emitAllSubjects burst on startup) which also triggers layout.
    await model.importLayout({ dataProvider, signal });
    model.history.reset();

    // Store flush function for use by the Save toolbar action
    flushAuthoringStateRef.current = () => flushAuthoringState(editor, model);
  }, []);

  // Subscribe to rdfManager changes — incremental sync to live model
  React.useEffect(() => {
    const handler = (subjects: string[], quads?: WorkerQuad[], _snapshot?: unknown, meta?: Record<string, unknown> | null) => {
      console.debug("[canvas] subjects received", subjects, meta);
      if (metadataProvider.suppressSync) return;

      const incomingGraphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      const isDataGraph = !incomingGraphName
        || incomingGraphName === 'urn:vg:data'
        || incomingGraphName === 'urn:vg:inferred';
      const isInferredGraph = incomingGraphName === 'urn:vg:inferred';

      const isFullRefresh = meta?.reason === 'emitAllSubjects';
      const model = modelRef.current;
      const ctx = contextRef.current;

      // When a namespace URI is renamed, remove stale canvas elements whose IRIs
      // used the old URI prefix — they would otherwise remain as orphans alongside
      // the newly-created elements under the renamed IRIs.
      if (meta?.reason === 'renameNamespaceUri' && typeof meta.oldUri === 'string' && model) {
        const oldUri = meta.oldUri as string;
        for (const el of [...model.elements]) {
          if (el instanceof Reactodia.EntityElement && el.data.id.startsWith(oldUri)) {
            model.removeElement(el.id);
            knownSubjects.delete(el.data.id);
          }
        }
      }

      // Determine which subjects are new vs already on canvas
      const existingIris = collectCanvasIris(model ? model.elements : []);
      const added = subjects.filter(s => !existingIris.has(s));
      const changed = subjects.filter(s => existingIris.has(s));

      if (quads && quads.length > 0) {
        const rdfQuads = workerQuadsToRdf(quads as unknown as ConverterQuad[]);
        if (!isDataGraph) {
          // Ontology/schema graph: load for schema awareness only, no canvas elements.
          dataProvider.addGraph(rdfQuads);
        } else if (isInferredGraph) {
          // Inferred graph: load quads for known data subjects WITHOUT the inferred
          // graphName tag. Inferred-triple tracking is done separately in
          // handleRunReasoning via fetchQuadsPage, which returns ONLY the quads that
          // are truly in urn:vg:inferred (not all quads for those subjects from all graphs).
          const filteredInferredQuads = rdfQuads.filter(
            q => q.subject.termType === 'NamedNode' && knownSubjects.has(q.subject.value)
          );
          if (filteredInferredQuads.length > 0) {
            dataProvider.addGraph(filteredInferredQuads);
          }
        } else if (changed.length > 0) {
          // For subjects already on the canvas, replace their quads so stale
          // triples don't persist alongside the updated ones.
          dataProvider.replaceSubjectQuads(changed, rdfQuads);
          // Then add any quads for brand-new subjects (addGraph deduplicates internally)
          if (added.length > 0) {
            const addedSet = new Set(added);
            dataProvider.addGraph(rdfQuads.filter(q => q.subject.termType === 'NamedNode' && addedSet.has((q.subject as any).value)));
          }
        } else {
          dataProvider.addGraph(rdfQuads);
        }
      }

      // Only track data-graph subjects and update canvas elements for data/inferred graphs
      if (!isDataGraph) return;

      // Inferred-graph subjects include OWL vocabulary terms emitted by the reasoner
      // (owl:Thing, rdfs:Class, etc.). Only data-graph subjects belong in knownSubjects;
      // inferred-graph subjects must NOT be tracked or they'll flood the canvas on view-mode switch.
      if (!isInferredGraph) {
        subjects.forEach(s => knownSubjects.add(s));
      }

      if (!model || !ctx) return;

      // Filter by current view mode now that quads (and their rdf:type triples) are in the provider.
      // Inferred graph subjects only decorate existing elements — don't create new canvas nodes
      // (OWL-RL inference touches vocabulary terms like owl:Thing that shouldn't appear on canvas).
      const addedFiltered = isInferredGraph ? [] : dataProvider.filterByViewMode(added);

      // Read autoApplyLayout without subscribing — we only need the value at call time
      const autoApplyLayout = (useAppConfigStore as any).getState().config.autoApplyLayout as boolean;

      // Defer model mutations out of the React lifecycle to avoid flushSync warnings
      queueMicrotask(async () => {
        for (const iri of addedFiltered) {
          model.createElement(iri as Reactodia.ElementIri);
        }

        // Re-fetch data + links for elements already on canvas whose triples changed
        if (changed.length > 0) {
          const changedSet = new Set(changed);
          // Remove all links whose source or target is in the changed set —
          // they'll be re-fetched below with the updated predicates from the store
          for (const link of [...model.links]) {
            if (
              link instanceof Reactodia.RelationLink &&
              (changedSet.has(link.data.sourceId) || changedSet.has(link.data.targetId))
            ) {
              model.removeLink(link.id);
            }
          }
          await model.requestElementData(changed as Reactodia.ElementIri[]);
          await model.requestLinks({ addedElements: changed as Reactodia.ElementIri[] });
        }

        await model.requestData();

        if (!autoApplyLayout || addedFiltered.length === 0) return;

        const controller = new AbortController();

        const cfg = (useAppConfigStore as any).getState().config;
        const layoutFn = getLayoutFunction(cfg.currentLayout, cfg, defaultLayout);

        if (isFullRefresh) {
          const shouldAutoCluster =
            cfg.clusteringAlgorithm !== 'none' &&
            addedFiltered.length > cfg.largeGraphThreshold;

          if (shouldAutoCluster) {
            await performInitialClustering(
              ctx,
              model,
              cfg,
              layoutFn,
              silentLayoutPositions,
              preClusterPositions
            );
          } else {
            await ctx.performLayout({
              layoutFunction: layoutFn,
              animate: cfg.layoutAnimations,
              signal: controller.signal,
            });
          }
        } else {
          // Incremental add: only lay out the newly added elements so existing
          // positions are preserved.
          const newElements = new Set(
            model.elements.filter(
              (e): e is Reactodia.EntityElement =>
                e instanceof Reactodia.EntityElement && addedFiltered.includes(e.data.id)
            )
          );
          await ctx.performLayout({
            layoutFunction: layoutFn,
            selectedElements: newElements,
            animate: cfg.layoutAnimations,
            signal: controller.signal,
          });
        }
      });
    };

    rdfManager.onSubjectsChange(handler as any);
    return () => rdfManager.offSubjectsChange(handler as any);
  }, []);

  // Clustering is manual-only (top bar Cluster button). No auto-trigger on algo/threshold change.

  // Handle view mode changes (ABox/TBox)
  React.useEffect(() => {
    const mode = canvasState.viewMode as ViewMode;
    if (mode === currentViewMode) return;
    const prevMode = currentViewMode;
    currentViewMode = mode;

    // Clustering state belongs to a specific view mode — reset it on switch.
    // model.importLayout below removes all EntityGroups from the model anyway.
    setIsClustered(false);

    const model = modelRef.current;
    const ctx = contextRef.current;
    if (!model || !ctx) return;

    // Snapshot the current layout before switching so we can restore it on the way back
    savedLayoutsByMode[prevMode] = model.exportLayout();

    dataProvider.setViewMode(mode);
    const filtered = dataProvider.filterByViewMode([...knownSubjects]);
    const savedDiagram = savedLayoutsByMode[mode];

    // Defer model mutations out of the React lifecycle to avoid flushSync warnings
    queueMicrotask(async () => {
      const controller = new AbortController();
      const cfg = (useAppConfigStore as any).getState().config;
      const autoApplyLayout = cfg.autoApplyLayout as boolean;
      const layoutFn = getLayoutFunction(cfg.currentLayout, cfg, defaultLayout);

      if (savedDiagram) {
        const diagram = savedDiagram;
        // Restore the previously computed layout for this mode.
        // validateLinks forces dataProvider.links() to be called, which re-injects
        // VG_GRAPH_NAME_PROP on inferred links. Only enabled when inferred data
        // exists so ordinary view-mode switches (no reasoning) pay zero extra cost.
        await model.importLayout({
          dataProvider,
          diagram,
          signal: controller.signal,
          validateLinks: dataProvider.hasInferredData(),
        });

        // Add any elements that were added while we were in the other mode
        const inModel = collectCanvasIris(model.elements);
        const newIris = filtered.filter(iri => !inModel.has(iri));
        for (const iri of newIris) {
          model.createElement(iri as Reactodia.ElementIri);
        }
        if (newIris.length > 0) {
          await model.requestData();
          if (autoApplyLayout) {
            // Layout only the elements without a saved position
            const newElements = new Set(
              model.elements.filter(
                (e): e is Reactodia.EntityElement =>
                  e instanceof Reactodia.EntityElement && newIris.includes(e.data.id)
              )
            );
            await ctx.performLayout({ layoutFunction: layoutFn, selectedElements: newElements, animate: cfg.layoutAnimations, signal: controller.signal });
          }
        }
      } else {
        // First time in this mode — add all filtered elements and layout if enabled
        await model.importLayout({ dataProvider, signal: controller.signal });
        for (const iri of filtered) {
          model.createElement(iri as Reactodia.ElementIri);
        }
        if (filtered.length > 0) {
          await model.requestData();
          if (autoApplyLayout) {
            await ctx.performLayout({ layoutFunction: layoutFn, animate: cfg.layoutAnimations, signal: controller.signal });
          }
        }
        const canvas = ctx.view.findAnyCanvas();
        if (canvas) {
          const FIT_PADDING = 100;
          const bbox = Reactodia.getContentFittingBox(
            ctx.model.elements, ctx.model.links, canvas.renderingState
          );
          void canvas.zoomToFitRect({
            x: bbox.x - FIT_PADDING,
            y: bbox.y - FIT_PADDING,
            width: bbox.width + FIT_PADDING * 2,
            height: bbox.height + FIT_PADDING * 2,
          });
        }
      }
    });
  }, [canvasState.viewMode]);

  // Startup initialization: ontology autoload + rdfUrl parameter load
  React.useEffect(() => {
    const cfg = (useAppConfigStore as any).getState().config;
    const additional: string[] = Array.isArray(cfg?.additionalOntologies)
      ? cfg.additionalOntologies.filter(Boolean)
      : [];

    let startupUrl = '';
    let startupApiKey = '';
    let startupApiKeyHeader = '';
    try {
      const u = new URL(String(window.location.href));
      startupUrl =
        u.searchParams.get('url') ||
        u.searchParams.get('rdfUrl') ||
        u.searchParams.get('vg_url') ||
        '';
      startupApiKey = u.searchParams.get('apiKey') || '';
      startupApiKeyHeader = u.searchParams.get('apiKeyHeader') || '';
    } catch {
      startupUrl = '';
    }

    (async () => {
      // Autoload configured ontologies if enabled
      if (additional.length > 0 && cfg?.persistedAutoload) {
        try {
          actions.setLoading(true, 5, 'Autoloading configured ontologies...');
          await loadAdditionalOntologies(additional, (progress: number, message: string) => {
            actions.setLoading(true, Math.max(5, progress), message);
          });
        } catch (err) {
          console.warn('[ReactodiaCanvas] Ontology autoload failed', err);
        } finally {
          actions.setLoading(false, 0, '');
        }
      }

      // Load startup graph from URL parameter
      if (startupUrl) {
        actions.setLoading(true, 5, 'Loading startup graph...');
        try {
          await loadKnowledgeGraph(startupUrl, {
            onProgress: (progress: number, message: string) => {
              actions.setLoading(true, Math.max(progress, 5), message);
            },
            timeout: 30000,
            ...(startupApiKey ? { apiKey: startupApiKey, apiKeyHeader: startupApiKeyHeader || undefined } : {}),
          });
          toast.success('Startup knowledge graph loaded');
        } catch (err) {
          console.error('[ReactodiaCanvas] Startup URL load failed', err);
        } finally {
          actions.setLoading(false, 0, '');
        }
      }
    })();
  }, [loadKnowledgeGraph, loadAdditionalOntologies, actions]);

  const handleAddNode = React.useCallback(() => {
    commandBusRef.current?.(UnifiedSearchTopic).trigger('focus', {});
  }, []);

  const handleLayoutChange = React.useCallback(() => {
    performLayoutRef.current?.();
  }, []);

  const handleCluster = React.useCallback(async () => {
    const ctx = contextRef.current;
    const cfg = useAppConfigStore.getState().config;
    if (!ctx || cfg.clusteringAlgorithm === 'none') return;
    const canvas = ctx.view.findAnyCanvas();
    if (!canvas) return;
    clearCanvasClustering(ctx.model);
    // Snapshot positions of all entities before clustering so expand-all can restore them.
    preClusterPositions.current = new Map(
      ctx.model.elements
        .filter((el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement)
        .map(el => [el.data.id, { ...el.position }])
    );
    await applyCanvasClustering(
      ctx, canvas,
      cfg.clusteringAlgorithm,
      getLayoutFunction(cfg.currentLayout, cfg, defaultLayout),
      cfg.layoutAnimations
    );
    setIsClustered(true);
  }, [defaultLayout]);

  const handleExpandAll = React.useCallback(async () => {
    const ctx = contextRef.current;
    if (!ctx) return;
    const canvas = ctx.view.findAnyCanvas();
    if (!canvas) return;
    const groups = ctx.model.elements.filter(
      (el): el is Reactodia.EntityGroup => el instanceof Reactodia.EntityGroup
    );
    if (groups.length === 0) return;
    setIsClustered(false);
    const saved = preClusterPositions.current;
    const silentPos = silentLayoutPositions.current;
    preClusterPositions.current = null;
    silentLayoutPositions.current = null;
    // Ungroup all groups synchronously (no animation yet).
    ctx.model.ungroupAll(groups);
    canvas.renderingState.syncUpdate();
    // Animate each element back to its pre-cluster position in one pass.
    await canvas.animateGraph(() => {
      for (const el of ctx.model.elements) {
        if (!(el instanceof Reactodia.EntityElement)) continue;
        // Prefer silent-layout positions (better than pre-cluster snapshot)
        const pos = silentPos?.get(el.data.id) ?? saved?.get(el.data.id);
        if (pos) el.setPosition(pos);
      }
    });
  }, []);

  const handleClearData = React.useCallback(() => {
    knownSubjects.clear();
    setIsClustered(false);
    const model = modelRef.current;
    if (!model) return;
    queueMicrotask(() => {
      for (const el of [...model.elements]) {
        model.removeElement(el.id);
      }
    });
  }, []);

  const handleClearInferred = React.useCallback(() => {
    dataProvider.clearInferred();
    rdfManager.removeGraph('urn:vg:inferred');
    setCurrentReasoning(null);
  }, []);

  const handleRunReasoning = React.useCallback(async () => {
    setIsReasoning(true);
    try {
      const cfg = useAppConfigStore.getState().config;
      const rulesets = Array.isArray(cfg?.reasoningRulesets) ? cfg.reasoningRulesets : [];
      const result = await rdfManager.runReasoning({ rulesets });
      setCurrentReasoning(result);
      setReasoningHistory(h => [...h, result]);

      // Fetch ONLY the quads that are truly in urn:vg:inferred (not the full subject
      // quads emitted by onSubjectsChange, which includes asserted triples too).
      // This is what drives the inferred-decoration markers in N3DataProvider.
      const inferredPage = await rdfManager.fetchQuadsPage({
        graphName: 'urn:vg:inferred',
        offset: 0,
        limit: 0,       // 0 = no limit
        serialize: false,
      });
      if (Array.isArray(inferredPage?.items) && inferredPage.items.length > 0) {
        const rdfQuads = workerQuadsToRdf(inferredPage.items as unknown as ConverterQuad[]);
        const filtered = rdfQuads.filter(
          q => q.subject.termType === 'NamedNode' && knownSubjects.has(q.subject.value as string)
        );
        if (filtered.length > 0) {
          dataProvider.addGraph(filtered, 'urn:vg:inferred');
          const model = modelRef.current;
          if (model) {
            const subjects = [...new Set(filtered.map(q => q.subject.value as Reactodia.ElementIri))];
            await model.requestElementData(subjects);
            await model.requestLinks({ addedElements: subjects });
            // Stamp inferred links with linkState so the decoration survives
            // importLayout (linkState is serialized in the diagram snapshot).
            for (const link of model.links) {
              if (!(link instanceof Reactodia.RelationLink)) continue;
              const graphName = link.data?.properties[VG_GRAPH_NAME_PROP]?.[0];
              if (graphName?.termType === 'NamedNode' && graphName.value === 'urn:vg:inferred') {
                const state = (link.linkState ?? Reactodia.TemplateState.empty)
                  .set(VG_GRAPH_NAME_STATE, 'urn:vg:inferred');
                model.history.execute(Reactodia.setLinkState(link, state));
              }
            }
          }
        }
      }
    } finally {
      setIsReasoning(false);
    }
  }, []);

  const handleFileChange = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    actions.setLoading(true, 0, `Loading ${file.name}…`);
    try {
      const text = await file.text();
      await rdfManager.loadRDFIntoGraph(text, undefined, undefined, file.name);
      actions.setLoading(false, 100, `Loaded ${file.name}`);
    } catch (err) {
      actions.setLoading(false, 0, '');
      console.error('[ReactodiaCanvas] File load failed', err);
    }
    e.target.value = '';
  }, [actions]);

  const handleLoadFile = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleLoadOntology = React.useCallback(() => {
    setLoadOntologyOpen(true);
  }, []);

  const handleExportRdf = React.useCallback(async (format: 'turtle' | 'json-ld' | 'rdf-xml') => {
    try {
      const { exportGraph } = useOntologyStore.getState();
      const content = await exportGraph(format);
      const ext = format === 'turtle' ? 'ttl' : format === 'json-ld' ? 'jsonld' : 'rdf';
      const mime = format === 'turtle' ? 'text/turtle' : format === 'json-ld' ? 'application/ld+json' : 'application/rdf+xml';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `knowledgegraph.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err) {
      console.error('[ReactodiaCanvas] RDF export failed', err);
      toast.error('RDF export failed');
    }
  }, []);

  const propertyEditor = React.useCallback<Reactodia.PropertyEditor>(
    (options) => <RdfPropertyEditor options={options} />,
    [],
  );

  // Custom drop handler: dragging a type label from the class tree puts the type IRI
  // in `text/uri-list` (browser anchor default). Instead of placing the type class itself
  // on the canvas, we create a NEW instance with that type.
  // Dragging from the Entities search panel uses `application/x-reactodia-elements` and
  // falls through to the default behaviour (place existing entity).
  const handleDropOnCanvas = React.useCallback(
    (e: Reactodia.CanvasDropEvent): Reactodia.DropOnCanvasItem[] => {
      // Explicit entity drags from search results → default behaviour
      const entityData = e.sourceEvent.dataTransfer?.getData('application/x-reactodia-elements');
      if (entityData) {
        return Reactodia.defaultGetDroppedOnCanvasItems(e);
      }

      // Type URI drag from class tree → create a new instance of that type
      const uriListRaw = e.sourceEvent.dataTransfer?.getData('text/uri-list');
      if (uriListRaw) {
        const typeIri = decodeURI(uriListRaw.trim()) as Reactodia.ElementTypeIri;
        const dropPosition = e.position;
        void (async () => {
          const model = modelRef.current;
          if (!model) return;
          try {
            const namespaces = rdfManager.getNamespaces();
            const defaultNs = namespaces.find(ns => ns.prefix === '')?.uri ?? 'http://example.com/';
            const iri = generateEntityIri(defaultNs, typeIri) as Reactodia.ElementIri;
            const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

            // Write triple to rdfManager (suppress canvas sync to avoid double-add)
            metadataProvider.suppressSync = true;
            try {
              await rdfManager.applyBatch({
                adds: [{
                  subject:   { termType: 'NamedNode', value: iri },
                  predicate: { termType: 'NamedNode', value: RDF_TYPE_IRI },
                  object:    { termType: 'NamedNode', value: typeIri },
                  graph:     { termType: 'NamedNode', value: 'urn:vg:data' },
                }],
              });
            } finally {
              metadataProvider.suppressSync = false;
            }

            // Also register with the data provider so links/elements queries work
            const factory = dataProvider.factory;
            dataProvider.addGraph([factory.quad(
              factory.namedNode(iri),
              factory.namedNode(RDF_TYPE_IRI),
              factory.namedNode(typeIri),
              factory.defaultGraph(),
            )]);
            knownSubjects.add(iri);

            // Place on canvas at drop position
            const elementData: Reactodia.ElementModel = {
              id: iri,
              types: [typeIri],
              properties: {},
            };
            queueMicrotask(() => {
              const element = model.createElement(elementData);
              element.setPosition(dropPosition);
              void model.requestData();
            });
          } catch (err) {
            console.error('[ReactodiaCanvas] Failed to create entity from type drag', err);
          }
        })();
        return []; // DropOnCanvas should not handle this drop
      }

      return Reactodia.defaultGetDroppedOnCanvasItems(e);
    },
    [],
  );

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: 'var(--canvas-bg)' }}>
      {/* Hidden file input for RDF file loading */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ttl,.owl,.rdf,.n3,.nt,.jsonld,.trig,.nq,.xml"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Reactodia Workspace — offset by sidebar width so it never sits under the overlay */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: sidebarExpanded ? 288 : 40,
        right: 0,
        bottom: 0,
        transition: 'left 300ms ease-in-out',
        background: 'var(--canvas-bg)',
      }}>
        <Reactodia.Workspace
          ref={onMount}
          defaultLayout={defaultLayout}
          metadataProvider={metadataProvider}
          validationProvider={validationProvider}
          typeStyleResolver={typeStyleResolver}
        >
          <PrefixContext.Provider value={prefixes}>
            <Reactodia.DefaultWorkspace
              canvas={{
                elementTemplateResolver: rdfElementTemplateResolver,
                linkTemplateResolver: rdfLinkTemplateResolver,
                zoomOptions: { fitPadding: 50, min: 0.05 },
              }}
              dropOnCanvas={{ getDroppedItems: handleDropOnCanvas }}
              menu={null}
              search={null}
              annotations={null}
              visualAuthoring={{ propertyEditor }}
              halo={{
                children: <>
                  <Reactodia.SelectionActionGroup dock='nw' dockColumn={1} />
                  <Reactodia.SelectionActionRemove dock='nw' dockRow={1} />
                  <Reactodia.SelectionActionZoomToFit dock='nw' dockRow={3} />
                  <Reactodia.SelectionActionLayout dock='nw' dockRow={4} />
                  <Reactodia.SelectionActionExpand dock='se' dockColumn={0} />
                  <Reactodia.SelectionActionEstablishLink dock='e' />
                </>
              }}
              actions={<>
                <Reactodia.ToolbarActionUndo />
                <Reactodia.ToolbarActionRedo />
                <Reactodia.ToolbarActionSave
                  mode="authoring"
                  onSelect={() => flushAuthoringStateRef.current?.()}
                >
                  Save
                </Reactodia.ToolbarActionSave>
                <Reactodia.ToolbarAction
                  title="Re-apply current layout"
                  onSelect={() => performLayoutRef.current?.()}
                >
                  Layout
                </Reactodia.ToolbarAction>
              </>}
            >
              <Reactodia.ViewportDock dock="n">
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                  gap: 4,
                  width: '100%',
                  padding: '0 var(--reactodia-viewport-dock-margin, 10px)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                  position: 'relative',
                  zIndex: 'calc(var(--reactodia-z-index-base, 0) + 35)',
                }}>
                  {/* Reactodia hamburger + search (no Toolbar wrapper to avoid nested ViewportDock) */}
                  <div className="reactodia-toolbar" role="toolbar" style={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
                    <Reactodia.DropdownMenu
                      className="reactodia-toolbar__menu"
                      direction="down"
                      title="Menu"
                    >
                      <Reactodia.ToolbarActionExport kind="exportRaster" />
                      <Reactodia.ToolbarActionExport kind="exportSvg" />
                      <Reactodia.ToolbarActionExport kind="print" />
                      <Reactodia.ToolbarAction
                        title={canvasState.showLegend ? 'Hide Legend' : 'Show Legend'}
                        onSelect={actions.toggleLegend}
                      >
                        {canvasState.showLegend ? 'Hide Legend' : 'Show Legend'}
                      </Reactodia.ToolbarAction>
                    </Reactodia.DropdownMenu>
                    <Reactodia.UnifiedSearch
                      sections={[
                        { key: 'elementTypes', label: 'Classes', title: 'Search element types', component: <Reactodia.SearchSectionElementTypes /> },
                        { key: 'entities', label: 'Entities', title: 'Search entities', component: <Reactodia.SearchSectionEntities /> },
                        { key: 'linkTypes', label: 'Link types', title: 'Search link types', component: <Reactodia.SearchSectionLinkTypes /> },
                      ]}
                    />
                  </div>

                  {/* Spacer */}
                  <div style={{ flex: 1 }} />

                  {/* Custom toolbar — same toolbar style, right-aligned */}
                  <div className="reactodia-toolbar" role="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'auto' }}>
                    <LayoutPopover onApplyLayout={() => performLayoutRef.current?.()} />
                    <TopBar
                      viewMode={canvasState.viewMode as 'abox' | 'tbox'}
                      onViewModeChange={actions.setViewMode}
                      ontologyCount={ontologyCount}
                      isClustered={isClustered}
                      onCluster={handleCluster}
                      onExpandAll={handleExpandAll}
                      onOpenReasoningReport={() => actions.toggleReasoningReport(true)}
                      onRunReason={handleRunReasoning}
                      onClearInferred={handleClearInferred}
                      currentReasoning={currentReasoning}
                      isReasoning={isReasoning}
                    />
                  </div>
                </div>
              </Reactodia.ViewportDock>
            </Reactodia.DefaultWorkspace>
          </PrefixContext.Provider>
        </Reactodia.Workspace>
      </div>

      {/* UI overlays — rendered OUTSIDE Workspace to avoid Radix UI + flushSync infinite loop */}
      <LeftSidebar
        isExpanded={sidebarExpanded}
        onToggle={() => setSidebarExpanded(v => !v)}
        onLoadOntology={handleLoadOntology}
        onLoadFile={handleLoadFile}
        onClearData={handleClearData}
        onExportRdf={handleExportRdf}
        onSettings={() => setSettingsOpen(true)}
      />



      {canvasState.showLegend && <ResizableNamespaceLegend />}

      <ConfigurationPanel
        triggerVariant="none"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <Dialog open={loadOntologyOpen} onOpenChange={setLoadOntologyOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Load Ontology</DialogTitle>
            <DialogDescription>
              Load an ontology from a URL or select from common vocabularies.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ontologyUrl">Ontology URL</Label>
              <Input
                id="ontologyUrl"
                placeholder="https://example.com/ontology.owl"
                value={ontologyUrlInput}
                onChange={(e) => setOntologyUrlInput(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Common Ontologies</Label>
              <div className="grid gap-1 max-h-48 overflow-y-auto pr-1">
                {WELL_KNOWN_PREFIXES.map((entry) => (
                  <Button
                    key={entry.url}
                    variant={ontologyUrlInput === entry.url ? 'secondary' : 'outline'}
                    size="sm"
                    className="justify-start h-auto py-2 text-left"
                    onClick={() => setOntologyUrlInput(entry.url)}
                  >
                    <div>
                      <div className="font-medium">{entry.prefix} — {entry.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{entry.url}</div>
                    </div>
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setLoadOntologyOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={!ontologyUrlInput.trim()}
                onClick={async () => {
                  const url = ontologyUrlInput.trim();
                  if (!url) return;
                  try {
                    actions.setLoading(true, 10, 'Loading ontology...');
                    await loadAdditionalOntologies([url], (progress, message) => {
                      actions.setLoading(true, Math.max(progress, 30), message);
                    });
                    toast.success('Ontology loaded successfully');
                    setOntologyUrlInput('');
                    setLoadOntologyOpen(false);
                  } catch (err) {
                    console.error('Failed to load ontology:', err);
                    toast.error('Failed to load ontology');
                  } finally {
                    actions.setLoading(false, 0, '');
                  }
                }}
              >
                Load Ontology
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ReasoningReportModal
        open={canvasState.showReasoningReport}
        onOpenChange={actions.toggleReasoningReport}
        currentReasoning={currentReasoning}
        reasoningHistory={reasoningHistory}
      />
    </div>
  );
}
