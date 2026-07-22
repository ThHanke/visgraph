import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { UnifiedSearchTopic } from '@reactodia/workspace';
import { SearchMatchCounter } from './search/SearchMatchCounter';
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
import { setWorkspaceContext, registerReasoningCallback, registerClearInferredCallback, registerSetViewMode } from '@/mcp/workspaceContext';
import { TopBar } from './TopBar';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
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
import { useSettingsStore } from '@/stores/settingsStore';
import { useShaclResultStore } from '@/stores/shaclResultStore';
import { getLayoutFunction } from './layout/getLayoutFunction';
import { runSilentLayout, type SilentLayoutEdge } from './layout/silentLayout';
import type { StructuralGroupMap } from './core/structuralGroups';
import { ClusterLevelManager } from './core/ClusterLevelManager';
import { LayoutPopover } from './LayoutPopover';
import { LayoutSettingsPanel } from './LayoutSettingsPanel';
import { OntologyListPanel } from './OntologyListPanel';
import { WorkflowExecutionDialog } from './WorkflowExecutionDialog';
import { RdfPropertyEditor } from './rdfPropertyEditor';
import { toast } from 'sonner';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import OntologyUrlAutoComplete from '../ui/OntologyUrlAutoComplete';
import { Button } from '../ui/button';
import { WELL_KNOWN_BY_PREFIX, resolveOntologyLoadUrl } from '@/utils/wellKnownOntologies';
import { instantiateWorkflowOnCanvas } from '@/utils/workflowInstantiator';
import { LAYOUT_DEBOUNCE_MS, DEFAULT_OVERLAP_THRESHOLD_PX } from '@/utils/canvasConstants';
import { toPrefixed } from '@/utils/termUtils';

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

// Singletons — one per app lifetime. dataProvider is an exported app-lifetime
// singleton (not a component); it must live alongside the canvas that wires it up.
// eslint-disable-next-line react-refresh/only-export-components
export const dataProvider = new N3DataProvider();
const metadataProvider = new RdfMetadataProvider(rdfManager, dataProvider);
const validationProvider = new RdfValidationProvider();

// Track all subject IRIs ever seen (for initial load and incremental adds)
const knownSubjects = new Set<string>();

// Positions saved from authoring elements so emitSubject can restore them
const pendingPositions = new Map<string, Reactodia.Vector>();


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
  const deleteIris: string[] = [];

  // Canvas-model cleanup runs before RDF writes to avoid race with onSubjectsChange
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
      // Always remove the authoring element — emitSubject will re-add it to the
      // correct view (ABox or TBox) once the RDF write fires onSubjectsChange.
      const el = model.elements.find(e => e instanceof Reactodia.EntityElement && e.data.id === event.data.id);
      if (el) {
        pendingPositions.set(event.data.id, { ...el.position });
        elementsToRemove.push(el);
      }
    } else if (event.type === 'entityDelete') {
      deleteIris.push(event.data.id);
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

  // Remove canvas elements/links BEFORE firing RDF writes so that onSubjectsChange
  // sees them as absent and treats re-emitted IRIs as adds (not changes).
  for (const link of linksToRemove) model.removeLink(link.id);
  for (const el of elementsToRemove) model.removeElement(el.id);
  for (const iri of deleteIris) {
    knownSubjects.delete(iri);
    dataProvider.removeSubjects([iri]);
  }

  // Write to RDF store — deleteIris go via removeAllQuadsForIri (hits all graphs),
  // add/change/relationDelete triples go via syncBatch on urn:vg:data.
  // applyBatch now resolves to the actual store delta ({added, removed}); we
  // only await completion here, so widen the op list to ignore the value.
  const rdfOps: Promise<unknown>[] = [];
  if (removes.length > 0 || adds.length > 0) {
    rdfOps.push(rdfManager.applyBatch({ removes, adds }, 'urn:vg:data'));
  }
  for (const iri of deleteIris) {
    rdfOps.push(rdfManager.removeAllQuadsForIri(iri, 'urn:vg:data'));
  }
  await Promise.all(rdfOps);

  // Clear the authoring state — changes are now in the RDF store
  editor.setAuthoringState(Reactodia.AuthoringState.empty);
}

// Current view mode state
let currentViewMode: ViewMode = 'abox';

// Persisted layout per view mode, saved via model.exportLayout() before each switch
const savedLayoutsByMode: Partial<Record<ViewMode, Reactodia.SerializedDiagram>> = {};

// Manager owns all cluster level state (L0-L3), group operations, and position caching.
const clusterLevelManager = new ClusterLevelManager(
  () => (useAppConfigStore as any).getState().config.clusteringAlgorithm as string
);

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

// Checks both standalone EntityElements and EntityGroups for position proximity.
// Groups are treated as single units — their member elements move with them and are skipped.
// threshold: px distance below which two elements are considered overlapping; use cfg.layoutSpacing.
function findOverlappingEntities(
  elements: ReadonlyArray<Reactodia.Element>,
  threshold: number = DEFAULT_OVERLAP_THRESHOLD_PX,
): Set<Reactodia.Element> {
  const groupedIris = new Set<string>();
  for (const el of elements) {
    if (el instanceof Reactodia.EntityGroup) {
      for (const member of el.items) {
        if (member.data.id) groupedIris.add(member.data.id);
      }
    }
  }
  const candidates = elements.filter(e =>
    (e instanceof Reactodia.EntityGroup) ||
    (e instanceof Reactodia.EntityElement && !groupedIris.has(e.data.id))
  );
  const overlapping = new Set<Reactodia.Element>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const pa = candidates[i].position;
      const pb = candidates[j].position;
      if (Math.abs(pa.x - pb.x) < threshold && Math.abs(pa.y - pb.y) < threshold) {
        overlapping.add(candidates[i]);
        overlapping.add(candidates[j]);
      }
    }
  }
  return overlapping;
}

function getUnpersistedIris(ctx: Reactodia.WorkspaceContext): Set<string> {
  const result = new Set<string>();
  const editor = ctx.editor;
  if (!editor?.authoringState?.elements) return result;
  for (const [iri, event] of editor.authoringState.elements) {
    if (event.type === 'entityAdd') result.add(iri);
  }
  return result;
}

function applyL2Fold(
  ctx: Reactodia.WorkspaceContext,
  model: Reactodia.DataDiagramModel,
  groupMap: StructuralGroupMap,
  unpersistedIris: ReadonlySet<string>
): number {
  if (groupMap.size === 0) return 0;

  const rootToMembers = new Map<string, Set<string>>();
  for (const [memberIri, rootIri] of groupMap) {
    if (!rootToMembers.has(rootIri)) rootToMembers.set(rootIri, new Set());
    rootToMembers.get(rootIri)!.add(memberIri);
  }

  const elementByIri = new Map<string, Reactodia.EntityElement>();
  for (const el of model.elements) {
    if (el instanceof Reactodia.EntityElement && !unpersistedIris.has(el.data.id)) {
      elementByIri.set(el.data.id, el);
    }
  }

  const alreadyGrouped = new Set<string>();
  let groupsCreated = 0;
  for (const [rootIri, memberIris] of rootToMembers) {
    const rootEl = elementByIri.get(rootIri);
    if (!rootEl || alreadyGrouped.has(rootIri)) continue;
    const members: Reactodia.EntityElement[] = [rootEl];
    for (const mIri of memberIris) {
      if (alreadyGrouped.has(mIri)) continue;
      const el = elementByIri.get(mIri);
      if (el) members.push(el);
    }
    if (members.length < 2) continue;
    for (const m of members) alreadyGrouped.add(m.data.id);
    ctx.model.group(members);
    groupsCreated++;
  }
  return groupsCreated;
}

function updateL2GroupsForNewElements(
  ctx: Reactodia.WorkspaceContext,
  model: Reactodia.DataDiagramModel,
  newIris: string[],
  groupMap: StructuralGroupMap,
  unpersistedIris: ReadonlySet<string>
): number {
  if (newIris.length === 0 || groupMap.size === 0) return 0;

  // Invert: rootIri → Set<memberIri>
  const rootToMembers = new Map<string, Set<string>>();
  for (const [memberIri, rootIri] of groupMap) {
    if (!rootToMembers.has(rootIri)) rootToMembers.set(rootIri, new Set());
    rootToMembers.get(rootIri)!.add(memberIri);
  }

  const newIriSet = new Set(newIris);

  // Build canvas state: standalone elements + which EntityGroup each IRI lives in
  const standaloneByIri = new Map<string, Reactodia.EntityElement>();
  const groupByMemberIri = new Map<string, Reactodia.EntityGroup>();
  for (const el of model.elements) {
    if (el instanceof Reactodia.EntityElement && !unpersistedIris.has(el.data.id)) {
      standaloneByIri.set(el.data.id, el);
    } else if (el instanceof Reactodia.EntityGroup) {
      for (const item of el.items) {
        if (!unpersistedIris.has(item.data.id)) {
          groupByMemberIri.set(item.data.id, el);
        }
      }
    }
  }

  // Helper: resolve an IRI to its EntityElement whether standalone or inside a group
  const resolveEl = (iri: string): Reactodia.EntityElement | undefined => {
    const standalone = standaloneByIri.get(iri);
    if (standalone) return standalone;
    const grp = groupByMemberIri.get(iri);
    if (!grp) return undefined;
    return grp.items.find((item): item is Reactodia.EntityElement =>
      item instanceof Reactodia.EntityElement && item.data.id === iri
    );
  };

  // Determine which root groups need updating because of the new IRIs
  const rootsToUpdate = new Set<string>();
  for (const iri of newIriSet) {
    if (groupMap.has(iri)) rootsToUpdate.add(groupMap.get(iri)!); // iri is a member
    if (rootToMembers.has(iri)) rootsToUpdate.add(iri);             // iri is a root
  }

  const alreadyReformed = new Set<string>(); // guard against double reform

  for (const rootIri of rootsToUpdate) {
    if (alreadyReformed.has(rootIri)) continue;
    const memberIris = rootToMembers.get(rootIri) ?? new Set<string>();

    const rootEl = resolveEl(rootIri);
    if (!rootEl) continue;

    // Collect all on-canvas elements for this group
    const allGroupEls: Reactodia.EntityElement[] = [rootEl];
    for (const mIri of memberIris) {
      const el = resolveEl(mIri);
      if (el) allGroupEls.push(el);
    }
    if (allGroupEls.length < 2) continue;

    // Ungroup any existing EntityGroup for this root so we can reform with new members
    const existingGroup = groupByMemberIri.get(rootIri);
    if (existingGroup) {
      ctx.model.ungroupAll([existingGroup]);
      // After ungroupAll, the items are back as standalone EntityElements.
      // The refs in allGroupEls are still valid (same objects).
    }

    ctx.model.group(allGroupEls);
    alreadyReformed.add(rootIri);
  }
  return alreadyReformed.size;
}

/**
 * Fire-and-forget background layout for L1 (entities) and L2 (structural groups).
 * Runs after L3 init layout so level-down transitions have pre-computed home positions.
 * Must be called without await — the result is stored in ClusterLevelManager async.
 */
function scheduleSilentLayoutWorker(
  ctx: Reactodia.WorkspaceContext,
  layoutFn: Reactodia.LayoutFunction,
  clusterMgr: ClusterLevelManager,
): void {
  void (async () => {
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      clusterMgr.snapshotClusterPositions();

      // Collect all entity IRIs and snapshot standalone L3 positions.
      const allEntityIris: string[] = [];
      const standaloneL3Pos = new Map<string, Reactodia.Vector>();
      for (const el of ctx.model.elements) {
        if (el instanceof Reactodia.EntityElement) {
          const iri = el.data.id as string;
          allEntityIris.push(iri);
          standaloneL3Pos.set(iri, { ...el.position });
        } else if (el instanceof Reactodia.EntityGroup) {
          for (const item of el.items) {
            allEntityIris.push(item.data.id as string);
          }
        }
      }

      const l1Edges: SilentLayoutEdge[] = ctx.model.links
        .filter((lk): lk is Reactodia.RelationLink => lk instanceof Reactodia.RelationLink)
        .map(lk => ({ source: lk.data.sourceId, target: lk.data.targetId }));

      const { groupMap } = dataProvider.getStructuralGroupsForView(dataProvider.currentViewMode);
      const entityMemberToRoot = new Map<string, string>();
      for (const entityIri of allEntityIris) {
        const rootIri = groupMap.get(entityIri);
        if (rootIri) entityMemberToRoot.set(entityIri, rootIri);
      }

      const clusterEntries = clusterMgr.clusterState ?? [];
      const entityToClusterPos = new Map<string, Reactodia.Vector>();
      for (const entry of clusterEntries) {
        for (const iri of entry.iris) {
          entityToClusterPos.set(iri, entry.position);
        }
      }

      const getL3Seed = (iri: string): Reactodia.Vector | undefined =>
        standaloneL3Pos.get(iri) ?? entityToClusterPos.get(iri);

      // ── L2 positions: each entity → its L3 seed ────────────────────────────
      // Members are overridden with their root's position so _animateToLevel2
      // places EntityGroups correctly.
      const l2Positions = new Map<string, Reactodia.Vector>();
      for (const iri of allEntityIris) {
        const pos = getL3Seed(iri);
        if (pos) l2Positions.set(iri, pos);
      }
      for (const [entityIri, rootIri] of entityMemberToRoot) {
        const rootPos = l2Positions.get(rootIri);
        if (rootPos) l2Positions.set(entityIri, rootPos);
      }

      // ── L1 incremental layout ──────────────────────────────────────────────
      // Non-members (roots + standalones) are fixed at their L2 positions.
      // Members are free — the engine spreads them with full edge connectivity.
      const l1Fixed = new Set<string>();
      const l1Seeds = new Map<string, Reactodia.Vector>();
      for (const iri of allEntityIris) {
        if (!entityMemberToRoot.has(iri)) {
          const pos = l2Positions.get(iri);
          if (pos) { l1Fixed.add(iri); l1Seeds.set(iri, pos); }
        } else {
          const rootIri = entityMemberToRoot.get(iri)!;
          const seed = l2Positions.get(rootIri) ?? getL3Seed(iri);
          if (seed) l1Seeds.set(iri, seed);
        }
      }

      const l1Positions = l1Fixed.size > 0
        ? await runSilentLayout(layoutFn, allEntityIris, l1Edges, { seeds: l1Seeds, fixed: l1Fixed })
        : await runSilentLayout(layoutFn, allEntityIris, l1Edges);

      clusterMgr.setPrecomputedPositions({ l1: l1Positions, l2: l2Positions });
      console.debug(`[VG_LAYOUT] Silent layout complete — L1: ${l1Positions.size}, L2: ${l2Positions.size}`);
    } catch (err) {
      console.warn('[Canvas] Silent layout failed:', err);
    }
  })();
}

/**
 * Initialize the canvas after nodes arrive — handles both small and large graphs
 * for ABox initial load and first TBox switch.
 *
 * Small graph (≤ largeGraphThreshold): schedule layout, entities displayed.
 * Large graph (> threshold): L3 clustering triggered, layout on groups,
 *   then silent worker pre-computes L1/L2 positions in background.
 */
async function initializeCanvas(
  ctx: Reactodia.WorkspaceContext,
  layoutFn: Reactodia.LayoutFunction,
  cfg: { clusteringAlgorithm: string; largeGraphThreshold: number; layoutAnimations: boolean },
  clusterMgr: ClusterLevelManager,
  signal: AbortSignal,
  onDone: () => void,
): Promise<void> {
  const { model } = ctx;

  // Capture entity count BEFORE levelUp/buildL3 — model.group() removes EntityElements
  // from model.elements, so sampling after L3 grouping returns only ungrouped nodes.
  const entityCount = model.elements.filter(
    (el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement
  ).length;

  if (entityCount === 0) {
    onDone();
    return;
  }

  const autoCluster = clusterMgr.shouldAutoCluster(
    entityCount, cfg.clusteringAlgorithm, cfg.largeGraphThreshold
  );

  // L0→L1: fold annotations. Guard: may already be at L1+ from a prior import.
  if (clusterMgr.currentLevel < 1) {
    await clusterMgr.levelUp();
  }

  if (autoCluster) {
    clusterMgr.buildL3(cfg.clusteringAlgorithm, knownSubjects);
    const topLevel = new Set(model.elements.filter(
      el => el instanceof Reactodia.EntityGroup || el instanceof Reactodia.EntityElement
    ));
    try {
      await ctx.performLayout({ layoutFunction: layoutFn, selectedElements: topLevel, animate: false, signal });
    } catch (err) {
      console.warn('[canvas layout] L3 performLayout failed:', err);
    }
    clusterMgr.snapshotClusterPositions();
    // Fire-and-forget: pre-compute L1/L2 positions for smooth level-down transitions.
    scheduleSilentLayoutWorker(ctx, layoutFn, clusterMgr);
  } else {
    try {
      await ctx.performLayout({ layoutFunction: layoutFn, animate: cfg.layoutAnimations, signal });
    } catch (err) {
      console.warn('[canvas layout] performLayout failed (model changed during layout):', err);
    }
  }

  onDone();
}

export default function ReactodiaCanvas() {
  const { defaultLayout } = Reactodia.useWorker(Layouts);
  const { state: canvasState, actions } = useCanvasState();
  const [sidebarExpanded, setSidebarExpanded] = React.useState(false);
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth < 740);
  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 740);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [loadOntologyOpen, setLoadOntologyOpen] = React.useState(false);
  const [ontologyUrlInput, setOntologyUrlInput] = React.useState('');
  const [ontologyListOpen, setOntologyListOpen] = React.useState(false);
  const [layoutPanelOpen, setLayoutPanelOpen] = React.useState(false);
  const [isReasoning, setIsReasoning] = React.useState(false);
  // Ref mirror of isReasoning so closure callbacks (onSubjectsChange handler) can
  // read the latest value without capturing stale state.
  const isReasoningRef = React.useRef(false);
  const [isInconsistentDetected, setIsInconsistentDetected] = React.useState(false);
  const [isClustered, setIsClustered] = React.useState(false);
  const levelSnapshot = React.useSyncExternalStore(
    clusterLevelManager.subscribe,
    clusterLevelManager.getSnapshot
  );
  const [currentReasoning, setCurrentReasoning] = React.useState<ReasoningResult | null>(null);
  const [reasoningHistory, setReasoningHistory] = React.useState<ReasoningResult[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const performLayoutRef = React.useRef<(() => Promise<void>) | null>(null);
  const pendingLayoutController = React.useRef<AbortController | null>(null);
  const layoutDebounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLayoutDone = React.useRef(false);

  // Resolved once at mount from ?loadImports URL param. false = imports disabled for this session.
  const loadImportsEnabledRef = React.useRef<boolean>(true);

  const ontologyCount = useOntologyStore(s =>
    (s.loadedOntologies ?? []).filter((o: any) => o.loadStatus !== 'fail').length
  );
  const namespaces = useOntologyStore(s => Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []);
  const loadKnowledgeGraph = useOntologyStore(s => s.loadKnowledgeGraph);
  const loadAdditionalOntologies = useOntologyStore(s => s.loadAdditionalOntologies);
  const discoverReferencedOntologies = useOntologyStore(s => s.discoverReferencedOntologies);

  // prefixes: prefix -> namespace URI (for PrefixContext consumers)
  // NamespaceEntry uses the field name `uri`, not `namespace`
  const prefixes = React.useMemo(
    () => Object.fromEntries(
      namespaces
        .filter((n) => !!(n as any).uri || !!(n as any).namespace)
        .map((n) => [n.prefix, (n as any).uri ?? (n as any).namespace])
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

  // Patch unlabeled link/element types in Reactodia model after namespaces + ontologies are ready.
  // Called at namespace-change time (after pmdco loads) so labels and toPrefixed both work correctly.
  React.useEffect(() => {
    if (namespaces.length === 0) return;
    const model = contextRef.current?.model;
    if (!model) return;
    void (async () => {
      try {
        const [linkTypes, elementTypeGraph] = await Promise.all([
          dataProvider.knownLinkTypes({}),
          dataProvider.knownElementTypes({}),
        ]);
        for (const t of linkTypes) {
          const lt = model.getLinkType(t.id);
          if (!lt?.data || lt.data.label.length > 0) continue;
          if (t.label && t.label.length > 0) {
            lt.setData({ ...lt.data, label: t.label });
          } else {
            const prefixed = toPrefixed(String(t.id));
            if (prefixed !== String(t.id)) {
              lt.setData({ ...lt.data, label: [dataProvider.factory.literal(prefixed)] });
            }
          }
        }
        for (const t of elementTypeGraph.elementTypes) {
          const et = model.getElementType(t.id);
          if (!et?.data) continue;
          if (et.data.label.length > 0) continue;
          if (t.label && t.label.length > 0) {
            et.setData({ ...et.data, label: t.label });
          } else {
            const prefixed = toPrefixed(String(t.id));
            if (prefixed !== String(t.id)) {
              et.setData({ ...et.data, label: [dataProvider.factory.literal(prefixed)] });
            }
          }
        }
      } catch { /* ignore if model torn down */ }
    })();
  }, [namespaces]);

  const modelRef = React.useRef<Reactodia.DataDiagramModel | null>(null);
  const commandBusRef = React.useRef<((topic: any) => any) | null>(null);
  const contextRef = React.useRef<Reactodia.WorkspaceContext | null>(null);
  const flushAuthoringStateRef = React.useRef<(() => Promise<void>) | null>(null);

  const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
    const { model, view, editor, getCommandBus } = context;
    modelRef.current = model;
    commandBusRef.current = getCommandBus;
    contextRef.current = context;
    setWorkspaceContext(context, dataProvider);
    clusterLevelManager.init(context, dataProvider);

    // Test bridge — exposes element positions and current level for Playwright tests.
    (window as any).__testClusterBridge = {
      getLevel: () => clusterLevelManager.currentLevel,
      getElementPositions: () => {
        const m = contextRef.current?.model;
        if (!m) return {};
        const out: Record<string, { x: number; y: number }> = {};
        for (const el of m.elements) {
          if (el instanceof Reactodia.EntityElement) out[el.data.id as string] = { ...el.position };
          else if (el instanceof Reactodia.EntityGroup) {
            const firstMemberId = el.items[0]?.data.id;
            const key = firstMemberId ? `__group__${firstMemberId}` : `__group__${el.id}`;
            out[key] = { ...el.position };
          }
        }
        return out;
      },
    };

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

    // Keep isClustered in sync with actual group presence in the model.
    // Debounced: bulk element adds (view-mode switch, initial load) fire changeCells
    // once per element; coalesce into one state update after the flood settles.
    let syncClusteredTimer: ReturnType<typeof setTimeout> | null = null;
    const syncClustered = () => {
      if (syncClusteredTimer) clearTimeout(syncClusteredTimer);
      syncClusteredTimer = setTimeout(() => {
        syncClusteredTimer = null;
        const hasGroups = model.elements.some(el => el instanceof Reactodia.EntityGroup);
        setIsClustered(hasGroups);
        actions.setIsClustered(hasGroups);
      }, 50);
    };
    model.events.on('changeCells', syncClustered);

    // Revalidate elements that appear on the diagram after SHACL reasoning has
    // already run — badges must show up even when the node was added later.
    let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const revalidateNewElements = (e: { updateAll: boolean; changedElement?: unknown }) => {
      const affected = validationProvider.getAffectedIris();
      if (affected.size === 0) return;
      if (revalidateTimer) clearTimeout(revalidateTimer);
      revalidateTimer = setTimeout(() => {
        revalidateTimer = null;
        const toRevalidate = new Set<Reactodia.ElementIri>();
        for (const el of model.elements) {
          for (const entity of Reactodia.iterateEntitiesOf(el)) {
            if (affected.has(entity.id)) toRevalidate.add(entity.id);
          }
        }
        if (toRevalidate.size > 0) {
          editor.revalidateEntities(toRevalidate);
        }
      }, 100);
    };
    model.events.on('changeCells', revalidateNewElements);

    signal.addEventListener('abort', () => {
      model.events.off('changeCells', syncClustered);
      model.events.off('changeCells', revalidateNewElements);
      if (syncClusteredTimer) { clearTimeout(syncClusteredTimer); syncClusteredTimer = null; }
      if (revalidateTimer) { clearTimeout(revalidateTimer); revalidateTimer = null; }
    });
  }, []);

  // Subscribe to rdfManager changes — incremental sync to live model
  React.useEffect(() => {
    const handler = (subjects: string[], quads?: WorkerQuad[], _snapshot?: unknown, meta?: Record<string, unknown> | null) => {
      console.debug("[VG_LAYOUT] subjects received", subjects, meta);
      if (metadataProvider.suppressSync) return;

      const incomingGraphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      const isDataGraph = !incomingGraphName
        || incomingGraphName === 'urn:vg:data'
        || incomingGraphName === 'urn:vg:inferred';
      const isInferredGraph = incomingGraphName === 'urn:vg:inferred';

      const isFullRefresh = meta?.reason === 'emitAllSubjects';
      const model = modelRef.current;
      const ctx = contextRef.current;

      // When an ontology is unloaded, remove its subjects from the data provider's
      // inner dataset so knownElementTypes and lookupAll no longer return stale classes.
      if (meta?.reason === 'unloadOntologySubjects' && Array.isArray(meta.removedSubjects)) {
        dataProvider.removeSubjects(meta.removedSubjects as string[]);
      }

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
          // Pass the graph name so N3DataProvider can exclude these subjects from
          // allSubjects (and therefore from Entities search results).
          dataProvider.addGraph(rdfQuads, incomingGraphName ?? undefined);
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

      // removeGraph fires emitSubjects with the deleted subjects + their residual quads
      // from other graphs. Canvas is already cleared; re-adding would resurface them.
      if (meta?.reason === 'removeGraph') return;

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
          const el = model.createElement(iri as Reactodia.ElementIri);
          const savedPos = pendingPositions.get(iri);
          if (savedPos) {
            el.setPosition(savedPos);
            pendingPositions.delete(iri);
          }
        }

        // Re-fetch data + links for elements already on canvas whose triples changed.
        // Skip for the inferred graph: handleRunReasoning owns that update path and
        // decorates links with VG_GRAPH_NAME_PROP before they first render. Letting
        // this branch run for inferred subjects would re-fetch links without the
        // decoration (inferredBySubject not yet populated), causing a one-frame flash
        // of solid-blue inferred links before they turn amber.
        if (changed.length > 0 && !isInferredGraph) {
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

        // L2 incremental fold: classify newly arrived elements into structural groups
        if (!isFullRefresh && addedFiltered.length > 0) {
          const { groupMap } = dataProvider.getStructuralGroupsForView(dataProvider.currentViewMode);
          if (groupMap.size > 0) {
            const unpersistedIris = getUnpersistedIris(ctx);
            const l2Count = updateL2GroupsForNewElements(ctx, model, addedFiltered, groupMap, unpersistedIris);
            if (l2Count > 0 && clusterLevelManager.currentLevel < 2) {
              clusterLevelManager.setCurrentLevel(2);
            }
          }
        }

        // autoApplyLayout only gates incremental updates. Initial load (isFullRefresh) always
        // runs layout + clustering so nodes are positioned and L3 groups are built regardless
        // of the setting.
        if (!isFullRefresh) {
          if (!autoApplyLayout || addedFiltered.length === 0 || existingIris.size === 0) return;
        }

        // discoverReferencedOntologies always fires a second emitAllSubjects after loading
        // T-Box ontologies. If the initial layout is already done and no new elements were
        // added, skip to avoid a redundant re-layout on an already-positioned canvas.
        if (isFullRefresh && addedFiltered.length === 0 && initialLayoutDone.current) {
          console.debug('[VG_LAYOUT] skipping redundant full-refresh (already laid out, no new elements)');
          return;
        }

        const cfg = (useAppConfigStore as any).getState().config;
        const layoutFn = getLayoutFunction(cfg.currentLayout, cfg, defaultLayout);

        if (isFullRefresh) {
          const controller = new AbortController();
          pendingLayoutController.current = controller;
          try {
            await initializeCanvas(ctx, layoutFn, cfg, clusterLevelManager, controller.signal, () => {
              initialLayoutDone.current = true;
              actions.setCanvasReady(true);
            });
          } finally {
            if (pendingLayoutController.current === controller) pendingLayoutController.current = null;
          }
        } else {
          // Debounce overlap-triggered layout: wait 300 ms after the last change so
          // rapid sequential adds (MCP loop) and workflow drops (which call performLayout
          // themselves) coalesce into a single layout run — or none if the caller already
          // positioned everything.
          if (layoutDebounceTimer.current) clearTimeout(layoutDebounceTimer.current);
          layoutDebounceTimer.current = setTimeout(async () => {
            layoutDebounceTimer.current = null;
            const overlapping = findOverlappingEntities(model.elements, cfg.layoutSpacing);
            console.debug('[VG_LAYOUT] overlap check (debounced) —', overlapping.size, 'overlapping');
            if (overlapping.size === 0) return;
            const debouncedController = new AbortController();
            pendingLayoutController.current = debouncedController;
            try {
              await ctx.performLayout({
                layoutFunction: layoutFn,
                selectedElements: overlapping,
                animate: cfg.layoutAnimations,
                signal: debouncedController.signal,
              });
            } finally {
              if (pendingLayoutController.current === debouncedController) pendingLayoutController.current = null;
            }
          }, 500);
        }
      });
    };

    rdfManager.onSubjectsChange(handler as any);
    return () => rdfManager.offSubjectsChange(handler as any);
    // Mount-only: this registers a single rdfManager subscription for the component's
    // lifetime. `actions` (stable Zustand setters) and `defaultLayout` (stable prop) are
    // read inside the handler; adding them would re-subscribe on every render and churn
    // the incremental-sync handler. Live config is read via getState(), not via deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clustering is manual-only (top bar Cluster button). No auto-trigger on algo/threshold change.

  // Handle view mode changes (ABox/TBox)
  React.useEffect(() => {
    const mode = canvasState.viewMode as ViewMode;
    if (mode === currentViewMode) return;
    const prevMode = currentViewMode;
    currentViewMode = mode;

    const model = modelRef.current;
    const ctx = contextRef.current;
    if (!model || !ctx) return;

    // Snapshot the current layout + cluster level state before switching
    savedLayoutsByMode[prevMode] = model.exportLayout();
    clusterLevelManager.saveViewState(prevMode);

    // Reset clustering/ready state so they don't bleed into the new view
    setIsClustered(false); actions.setIsClustered(false);
    actions.setCanvasReady(false);
    initialLayoutDone.current = false;
    clusterLevelManager.reset();

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

        // Restore cluster level state for this view mode
        if (clusterLevelManager.restoreViewState(mode)) {
          const hasGroups = model.elements.some(el => el instanceof Reactodia.EntityGroup);
          setIsClustered(hasGroups); actions.setIsClustered(hasGroups);
          initialLayoutDone.current = true;
          actions.setCanvasReady(true);
        }

        // Add any elements that were added while we were in the other mode
        const inModel = collectCanvasIris(model.elements);
        const newIris = filtered.filter(iri => !inModel.has(iri));
        for (const iri of newIris) {
          model.createElement(iri as Reactodia.ElementIri);
        }
        if (newIris.length > 0) {
          await model.requestData();
          if (autoApplyLayout) {
            const overlapping = findOverlappingEntities(model.elements, cfg.layoutSpacing);
            console.debug('[VG_LAYOUT] view-switch new nodes —', newIris.length, 'new,', overlapping.size, 'overlapping');
            if (overlapping.size > 0) {
              await ctx.performLayout({ layoutFunction: layoutFn, selectedElements: overlapping, animate: cfg.layoutAnimations, signal: controller.signal });
            }
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
          await initializeCanvas(ctx, layoutFn, cfg, clusterLevelManager, controller.signal, () => {
            initialLayoutDone.current = true;
            actions.setCanvasReady(true);
          });
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

      // Re-trigger validation badges for elements now visible in this view mode
      const affected = validationProvider.getAffectedIris();
      if (affected.size > 0) {
        ctx.editor.revalidateEntities(affected as ReadonlySet<Reactodia.ElementIri>);
      }
    });
    // Keyed to view-mode transitions only. `actions` (stable Zustand setters) and
    // `defaultLayout` (stable worker handle from module-scope Layouts) never change for
    // the component lifetime, so omitting them cannot cause a stale closure; including
    // them would only obscure that this effect models an ABox/TBox switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    let shaclShapesParam = '';
    try {
      const u = new URL(String(window.location.href));
      startupUrl =
        u.searchParams.get('url') ||
        u.searchParams.get('rdfUrl') ||
        u.searchParams.get('vg_url') ||
        '';
      startupApiKey = u.searchParams.get('apiKey') || '';
      startupApiKeyHeader = u.searchParams.get('apiKeyHeader') || '';
      shaclShapesParam = u.searchParams.get('shaclShapes') || '';
      // ?loadImports=false disables owl:imports auto-loading for this session only.
      const loadImportsParam = u.searchParams.get('loadImports');
      loadImportsEnabledRef.current = loadImportsParam !== 'false';
      if (startupUrl) {
        try {
          const dataUrl = new URL(startupUrl);
          const label = dataUrl.pathname.split('/').filter(Boolean).pop()?.replace(/\.[^.]+$/, '') || startupUrl;
          document.title = `Ontosphere: ${label}`;
          if (!window.location.hash) {
            history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${label}`);
          }
        } catch {
          document.title = `Ontosphere: ${startupUrl}`;
        }
      }
    } catch {
      startupUrl = '';
    }

    // ?ontologies= (plural) — comma-separated prefixes/URIs that REPLACE the configured
    // additionalOntologies list. When present, the stored autoload list is skipped entirely.
    // ?ontology= (singular) — adds on top of the configured list (existing behaviour).
    let startupOntologyEntries: { input: string; resolved: string; label: string }[] = [];
    let ontologiesParamOverride: string[] | null = null; // non-null → replace mode
    try {
      const u = new URL(String(window.location.href));
      const replaceParam = u.searchParams.get('ontologies');
      const addParam    = u.searchParams.get('ontology');
      if (replaceParam !== null) {
        // Replace mode: ?ontologies= overrides the stored additionalOntologies list.
        ontologiesParamOverride = replaceParam
          .split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => resolveOntologyLoadUrl(s));
      } else if (addParam?.trim()) {
        startupOntologyEntries = addParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => ({
            input: s,
            resolved: resolveOntologyLoadUrl(s),
            label: WELL_KNOWN_BY_PREFIX[s]?.name ?? s,
          }));
      }
    } catch {
      /* ignore */
    }

    (async () => {
      // Autoload ontologies: ?ontologies= replaces the configured list; otherwise use config.
      const autoloadList = ontologiesParamOverride ?? (cfg?.persistedAutoload ? additional : []);
      if (autoloadList.length > 0) {
        try {
          actions.setLoading(true, 5, 'Autoloading configured ontologies...');
          await loadAdditionalOntologies(autoloadList, (progress: number, message: string) => {
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
            disableImportDiscovery: !loadImportsEnabledRef.current,
            ...(startupApiKey ? { apiKey: startupApiKey, apiKeyHeader: startupApiKeyHeader || undefined } : {}),
          });
          const startupLabel = (() => {
            try { return new URL(startupUrl).pathname.split('/').filter(Boolean).pop()?.replace(/\.[^.]+$/, '') || startupUrl; }
            catch { return startupUrl; }
          })();
          toast.success(`Loaded: ${startupLabel}`, { description: '?url= parameter' });
        } catch (err) {
          toast.error('Failed to load startup graph', { description: startupUrl });
          console.error('[ReactodiaCanvas] Startup URL load failed', err);
        } finally {
          actions.setLoading(false, 0, '');
        }
      }

      // Load ontologies specified via ?ontology= URL param — one toast per entry.
      if (startupOntologyEntries.length > 0) {
        for (const entry of startupOntologyEntries) {
          try {
            actions.setLoading(true, 5, `Loading ${entry.label}...`);
            await loadAdditionalOntologies([entry.resolved], (progress, message) => {
              actions.setLoading(true, Math.max(5, progress), message);
            });
            toast.success(entry.label, { description: 'Loaded from ?ontology= parameter' });
          } catch (err) {
            console.warn('[ReactodiaCanvas] ?ontology= load failed', entry.input, err);
            toast.error(`Failed to load ${entry.label}`, { description: '?ontology= parameter — check the prefix or URL' });
          }
        }
        actions.setLoading(false, 0, '');
      }

      // Load SHACL shapes: ?shaclShapes= param takes priority, otherwise use settings
      const shaclUrl = shaclShapesParam || useSettingsStore.getState().settings.shaclShapesUrl;
      if (shaclUrl) {
        try {
          const { loadShaclShapes } = await import('../../utils/shaclShapeLoader');
          const manifest = await loadShaclShapes(shaclUrl);
          if (manifest.loaded.length > 0) {
            console.log('[ReactodiaCanvas] SHACL shapes loaded:', manifest.loaded.map(s => s.name));
            useShaclResultStore.getState().setShaclShapesLoaded(true);
          } else {
            useShaclResultStore.getState().setShaclShapesLoaded(false);
          }
          for (const err of manifest.errors) {
            console.warn('[ReactodiaCanvas] SHACL shape load error:', err.url, err.error);
          }
          if (manifest.loaded.length === 0 && manifest.errors.length > 0) {
            useShaclResultStore.getState().setShaclShapesLoaded(false);
          }
        } catch (err) {
          console.warn('[ReactodiaCanvas] SHACL shapes load failed', err);
          useShaclResultStore.getState().setShaclShapesLoaded(false);
        }
      } else {
        useShaclResultStore.getState().setShaclShapesLoaded(false);
      }
    })();
  }, [loadKnowledgeGraph, loadAdditionalOntologies, actions]);

  // Intercept Ctrl+F / Cmd+F (and browser equivalents) to open the unified search widget
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modKey = /mac/i.test(navigator.userAgent) ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === 'f' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        commandBusRef.current?.(UnifiedSearchTopic).trigger('focus', {});
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

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
    // buildL3 handles ungroup + cluster; follow up with layout
    clusterLevelManager.buildL3(cfg.clusteringAlgorithm);
    const canvas = ctx.view.findAnyCanvas();
    if (canvas) {
      const topLevel = new Set(ctx.model.elements.filter(
        el => el instanceof Reactodia.EntityGroup || el instanceof Reactodia.EntityElement
      ));
      await ctx.performLayout({
        layoutFunction: getLayoutFunction(cfg.currentLayout, cfg, defaultLayout),
        selectedElements: topLevel,
        animate: cfg.layoutAnimations,
      });
      clusterLevelManager.snapshotClusterPositions();
    }
  }, [defaultLayout]);

  const clusteringAlgorithm = useAppConfigStore(s => s.config.clusteringAlgorithm);
  const prevClusteringAlgorithmRef = React.useRef(clusteringAlgorithm);

  React.useEffect(() => {
    if (prevClusteringAlgorithmRef.current === clusteringAlgorithm) return;
    prevClusteringAlgorithmRef.current = clusteringAlgorithm;
    clusterLevelManager.invalidateL3Cache();
    if (levelSnapshot.currentLevel === 3) {
      void handleCluster();
    }
  }, [clusteringAlgorithm, levelSnapshot.currentLevel, handleCluster]);

  const { currentLevel, maxFoldLevel, canGoUp, canGoDown } = levelSnapshot;

  const diagOverlaps = React.useCallback((ctx: Reactodia.WorkspaceContext, label: string) => {
    // Defer to next animation frame so React has rendered sizes
    requestAnimationFrame(() => {
      const els = ctx.model.elements.filter(
        (el): el is Reactodia.EntityElement | Reactodia.EntityGroup =>
          el instanceof Reactodia.EntityElement || el instanceof Reactodia.EntityGroup
      );
      const groups = els.filter(el => el instanceof Reactodia.EntityGroup);
      const entities = els.filter(el => el instanceof Reactodia.EntityElement);
      const canvas = ctx.view.findAnyCanvas();
      let overlaps = 0;
      let skippedNoSize = 0;
      const atOrigin = els.filter(el => el.position.x === 0 && el.position.y === 0).length;

      const sized = els.filter(el => {
        const s = canvas?.renderingState.getElementSize(el);
        if (!s || (s.width === 0 && s.height === 0)) { skippedNoSize++; return false; }
        return true;
      });

      for (let i = 0; i < sized.length; i++) {
        const a = sized[i];
        const aSize = canvas!.renderingState.getElementSize(a)!;
        const ax = a.position.x, ay = a.position.y;
        const aw = aSize.width, ah = aSize.height;
        for (let j = i + 1; j < sized.length; j++) {
          const b = sized[j];
          const bSize = canvas!.renderingState.getElementSize(b)!;
          const bx = b.position.x, by = b.position.y;
          const bw = bSize.width, bh = bSize.height;
          if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by) {
            overlaps++;
          }
        }
      }
      const uniquePositions = new Set(sized.map(el => `${el.position.x},${el.position.y}`)).size;
      console.debug(`[VG_LAYOUT] [${label}] overlap check: ${groups.length} groups + ${entities.length} entities = ${els.length} (${skippedNoSize} no size), ${overlaps} overlapping pairs, ${uniquePositions} unique positions, ${atOrigin} at origin`);
    });
  }, []);

  const handleLevelUp = React.useCallback(async () => {
    const ctx = contextRef.current;
    const cfg = useAppConfigStore.getState().config;
    if (!ctx) return;

    const result = await clusterLevelManager.levelUp();
    await ctx.model.requestLinks();

    if (result.needsLayout && cfg.autoApplyLayout) {
      const topLevel = new Set(ctx.model.elements.filter(
        el => el instanceof Reactodia.EntityGroup || el instanceof Reactodia.EntityElement
      ));
      await ctx.performLayout({
        layoutFunction: getLayoutFunction(cfg.currentLayout, cfg, defaultLayout),
        selectedElements: topLevel,
        animate: cfg.layoutAnimations,
      });
      clusterLevelManager.snapshotClusterPositions();
    }
    diagOverlaps(ctx, 'levelUp');
  }, [defaultLayout, diagOverlaps]);

  const handleLevelDown = React.useCallback(async () => {
    const ctx = contextRef.current;
    const cfg = useAppConfigStore.getState().config;
    if (!ctx) return;

    const result = clusterLevelManager.levelDown();
    const targetLevel = clusterLevelManager.currentLevel;
    const hasPrecomputed = clusterLevelManager.hasPositionsForLevel(targetLevel);
    await ctx.model.requestLinks();

    if (result.needsLayout && hasPrecomputed) {
      await clusterLevelManager.animateExpandPositions();
    } else if (result.needsLayout && cfg.autoApplyLayout) {
      const topLevel = new Set(ctx.model.elements.filter(
        el => el instanceof Reactodia.EntityGroup || el instanceof Reactodia.EntityElement
      ));
      await ctx.performLayout({
        layoutFunction: getLayoutFunction(cfg.currentLayout, cfg, defaultLayout),
        selectedElements: topLevel,
        animate: cfg.layoutAnimations,
      });
    } else if (result.needsLayout) {
      await clusterLevelManager.animateExpandPositions();
    }
    diagOverlaps(ctx, 'levelDown');
  }, [defaultLayout, diagOverlaps]);

  const handleClearData = React.useCallback(() => {
    knownSubjects.clear();
    setIsClustered(false); actions.setIsClustered(false);
    clusterLevelManager.reset();
    clusterLevelManager.resetViewHistory();
    rdfManager.removeGraph('urn:vg:data');
    // Clear saved layouts for both views so switching views after clear
    // doesn't restore stale nodes via importLayout.
    savedLayoutsByMode['abox'] = undefined;
    savedLayoutsByMode['tbox'] = undefined;
    const ctx = contextRef.current;
    if (!ctx) return;
    queueMicrotask(() => {
      const groups = ctx.model.elements.filter(
        (el): el is Reactodia.EntityGroup => el instanceof Reactodia.EntityGroup
      );
      if (groups.length) ctx.model.ungroupAll(groups);
      for (const el of [...ctx.model.elements]) {
        ctx.model.removeElement(el.id);
      }
    });
    // `actions` is a stable reference (memoized in useCanvasState), so listing it keeps
    // this callback's identity stable while satisfying the dependency check.
  }, [actions]);

  const handleClearInferred = React.useCallback(() => {
    dataProvider.clearInferred();
    rdfManager.removeGraph('urn:vg:inferred');
    setCurrentReasoning(null);
    setIsInconsistentDetected(false);
    validationProvider.clearErrors();
    useShaclResultStore.getState().clearShaclResults();
    const ctx = contextRef.current;
    if (ctx) {
      const visibleIris = new Set(
        ctx.model.elements.map(el => el.id as Reactodia.ElementIri)
      );
      if (visibleIris.size > 0) ctx.editor.revalidateEntities(visibleIris);
    }
    void rdfManager.emitAllSubjects('urn:vg:data');
  }, []);

  const handleApplyInferred = React.useCallback(async () => {
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
  }, []);

  const handleRunReasoning = React.useCallback(async (reasonerBackend?: 'konclude' | 'n3') => {
    setIsReasoning(true);
    isReasoningRef.current = true;
    setIsInconsistentDetected(false);
    try {
      const cfg = useAppConfigStore.getState().config;
      const rulesets = Array.isArray(cfg?.reasoningRulesets) ? cfg.reasoningRulesets : [];
      const backend = reasonerBackend ?? cfg?.reasonerBackend ?? 'konclude';
      const result = await rdfManager.runReasoning({ rulesets, reasonerBackend: backend });
      setCurrentReasoning(result);
      setReasoningHistory(h => [...h, result]);
      await handleApplyInferred();
      // Highlight nodes with reasoning errors/warnings via the validation provider.
      const errorMap = new Map<string, string[]>();
      for (const err of result.errors ?? []) {
        if (err.nodeId) {
          const list = errorMap.get(err.nodeId) ?? [];
          list.push(err.message);
          errorMap.set(err.nodeId, list);
        }
      }
      const warningMap = new Map<string, string[]>();
      for (const warn of result.warnings ?? []) {
        if (warn.nodeId) {
          const list = warningMap.get(warn.nodeId) ?? [];
          list.push(warn.message);
          warningMap.set(warn.nodeId, list);
        }
      }
      validationProvider.setErrors(errorMap);
      validationProvider.setWarnings(warningMap);
      const affectedIris = new Set([...errorMap.keys(), ...warningMap.keys()]);
      const ctx = contextRef.current;
      if (ctx && affectedIris.size > 0) {
        ctx.editor.revalidateEntities(affectedIris as ReadonlySet<Reactodia.ElementIri>);
      }
      const isShaclRule = (rule: string) => rule.startsWith('shacl:') || rule === 'sh:ValidationResult';
      useShaclResultStore.getState().setShaclResults(
        result.errors.filter(e => isShaclRule(e.rule)),
        result.warnings.filter(w => isShaclRule(w.rule)),
      );
      return result;
    } finally {
      setIsReasoning(false);
      isReasoningRef.current = false;
      setIsInconsistentDetected(false);
    }
  }, [handleApplyInferred]);

  React.useEffect(() => {
    return rdfManager.onReasoningStage((payload) => {
      if (payload.stage === 'inconsistent-detected') {
        setIsInconsistentDetected(true);
      }
    });
  }, []);

  React.useEffect(() => {
    registerReasoningCallback(handleRunReasoning);
  }, [handleRunReasoning]);

  React.useEffect(() => {
    registerClearInferredCallback(handleClearInferred);
  }, [handleClearInferred]);

  React.useEffect(() => {
    registerSetViewMode(actions.setViewMode);
  }, [actions.setViewMode]);

  // ─── Auto-reasoning: full reclassification on urn:vg:data edits ─────────────
  const autoReasoningDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditRef = React.useRef(false);
  const scheduleAutoReasoningRef = React.useRef<(() => void) | null>(null);

  const handleAutoReasoning = React.useCallback(async () => {
    setIsReasoning(true);
    isReasoningRef.current = true;
    try {
      const cfg = useAppConfigStore.getState().config;
      const rulesets = Array.isArray(cfg?.reasoningRulesets) ? cfg.reasoningRulesets : [];
      const backend = cfg?.reasonerBackend ?? 'konclude';
      const result = await rdfManager.runReasoning({ rulesets, reasonerBackend: backend });
      setCurrentReasoning(result);
      setReasoningHistory(h => [...h, result]);
      setIsInconsistentDetected(result.isConsistent === false);
      await handleApplyInferred();
    } finally {
      setIsReasoning(false);
      isReasoningRef.current = false;
      if (
        pendingEditRef.current &&
        useSettingsStore.getState().settings.autoReasoning
      ) {
        pendingEditRef.current = false;
        scheduleAutoReasoningRef.current?.();
      }
    }
  }, [handleApplyInferred]);

  React.useEffect(() => {
    const AUTO_REASONING_DEBOUNCE_MS = 1500;

    const schedule = () => {
      if (autoReasoningDebounceRef.current) clearTimeout(autoReasoningDebounceRef.current);
      autoReasoningDebounceRef.current = setTimeout(() => {
        autoReasoningDebounceRef.current = null;
        if (!useSettingsStore.getState().settings.autoReasoning) return;
        if (isReasoningRef.current) {
          pendingEditRef.current = true;
          return;
        }
        if (!pendingEditRef.current) return;
        pendingEditRef.current = false;
        void handleAutoReasoning();
      }, AUTO_REASONING_DEBOUNCE_MS);
    };
    scheduleAutoReasoningRef.current = schedule;

    const handler = (
      _subjects: string[],
      _quads?: unknown,
      _snapshot?: unknown,
      meta?: Record<string, unknown> | null,
    ) => {
      const graphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      if (graphName !== 'urn:vg:data') return;
      if (meta?.reason === 'emitAllSubjects') return;
      if (!useSettingsStore.getState().settings.autoReasoning) return;

      pendingEditRef.current = true;
      schedule();
    };

    rdfManager.onSubjectsChange(handler as any);
    return () => {
      rdfManager.offSubjectsChange(handler as any);
      scheduleAutoReasoningRef.current = null;
      if (autoReasoningDebounceRef.current) {
        clearTimeout(autoReasoningDebounceRef.current);
        autoReasoningDebounceRef.current = null;
      }
    };
  }, [handleAutoReasoning]);

  // ─── Undo / Redo keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) ──
  React.useEffect(() => {
    const handleUndoRedo = (e: KeyboardEvent) => {
      // Skip when focus is inside a text input/textarea/contenteditable so that
      // native browser undo (for typed text) is not hijacked.
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) return;

      const modKey = /mac/i.test(navigator.userAgent) ? e.metaKey : e.ctrlKey;
      if (!modKey) return;

      const model = modelRef.current;
      if (!model) return;

      if (e.key === 'z' && !e.shiftKey && !e.altKey) {
        // Ctrl/Cmd+Z → undo
        e.preventDefault();
        e.stopPropagation();
        if (model.history.undoStack.length > 0) {
          model.history.undo();
        }
      } else if (
        (e.key === 'z' && e.shiftKey && !e.altKey) ||
        (e.key === 'y' && !e.shiftKey && !e.altKey)
      ) {
        // Ctrl/Cmd+Shift+Z or Ctrl+Y → redo
        e.preventDefault();
        e.stopPropagation();
        if (model.history.redoStack.length > 0) {
          model.history.redo();
        }
      }
    };

    document.addEventListener('keydown', handleUndoRedo, { capture: true });
    return () => document.removeEventListener('keydown', handleUndoRedo, { capture: true });
  }, []);

  const handleFileChange = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    actions.setLoading(true, 0, `Loading ${file.name}…`);
    try {
      const text = await file.text();
      await rdfManager.loadRDFIntoGraph(text, undefined, undefined, file.name);
      useOntologyStore.getState().setDataFilename(file.name.replace(/\.[^.]+$/, ''));
      actions.setLoading(false, 100, `Loaded ${file.name}`);
      // Fire-and-forget: discover and load owl:imports referenced in the uploaded file.
      if (typeof discoverReferencedOntologies === 'function') {
        discoverReferencedOntologies({
          load: 'async',
          graphName: 'urn:vg:data',
          forceDisabled: !loadImportsEnabledRef.current,
        });
      }
    } catch (err) {
      actions.setLoading(false, 0, '');
      console.error('[ReactodiaCanvas] File load failed', err);
    }
    e.target.value = '';
  }, [actions, discoverReferencedOntologies]);

  const handleLoadFile = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleLoadOntology = React.useCallback(() => {
    setLoadOntologyOpen(true);
  }, []);

  const handleExportRdf = React.useCallback(async (format: 'turtle' | 'json-ld' | 'rdf-xml' | 'nquads' | 'trig') => {
    try {
      const { exportGraph, dataFilename } = useOntologyStore.getState();
      const content = await exportGraph(format);
      const extByFormat: Record<typeof format, string> = {
        'turtle': 'ttl',
        'json-ld': 'jsonld',
        'rdf-xml': 'rdf',
        'nquads': 'nq',
        'trig': 'trig',
      };
      const mimeByFormat: Record<typeof format, string> = {
        'turtle': 'text/turtle',
        'json-ld': 'application/ld+json',
        'rdf-xml': 'application/rdf+xml',
        'nquads': 'application/n-quads',
        'trig': 'application/trig',
      };
      const ext = extByFormat[format];
      const mime = mimeByFormat[format];
      const baseName = dataFilename || 'knowledgegraph';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}.${ext}`;
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

      // Workflow template drag from sidebar → handled by native onDrop on the container div

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

  // Ensure p-plan and qudt ontologies are loaded before workflow instantiation.
  // These were removed from the default auto-load set but are required for workflow triples.
  async function ensureWorkflowOntologies() {
    const REQUIRED = [
      'http://purl.org/net/p-plan#',
      'http://qudt.org/schema/qudt/',
    ];
    const { loadedOntologies, loadOntology } = useOntologyStore.getState();
    const loaded = new Set((loadedOntologies ?? []).map((o: any) => String(o.url)));
    await Promise.all(
      REQUIRED
        .filter(url => !loaded.has(url))
        .map(url => loadOntology(url, { autoload: true }).catch(err =>
          console.warn(`[ReactodiaCanvas] Could not load workflow ontology ${url}:`, err)
        ))
    );
  }

  // Native document-level drag listeners for workflow template drops.
  // React synthetic drag events don't fire reliably when Reactodia owns the canvas.
  React.useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/vg-workflow-template')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      const iri = e.dataTransfer?.getData('application/vg-workflow-template');
      if (!iri) return;
      e.preventDefault();
      e.stopPropagation();
      const model = modelRef.current;
      const ctx = contextRef.current;
      if (!model || !ctx) return;
      const canvas = ctx.view.findAnyCanvas();
      const pane = canvas?.metrics.clientToScrollablePaneCoords(e.clientX, e.clientY);
      const canvasPos = (canvas && pane)
        ? canvas.metrics.scrollablePaneToPaperCoords(pane.x, pane.y)
        : { x: e.clientX, y: e.clientY };
      ensureWorkflowOntologies().then(() =>
        instantiateWorkflowOnCanvas(iri, canvasPos, model, ctx.editor, ctx)
      ).catch(err => {
        console.error('[ReactodiaCanvas] Workflow instantiation failed', err);
        toast.error('Failed to instantiate workflow');
      });
    };
    const onTouchDrop = (e: Event) => {
      const { iri, clientX, clientY } = (e as CustomEvent).detail as { iri: string; clientX: number; clientY: number };
      if (!iri) return;
      const model = modelRef.current;
      const ctx = contextRef.current;
      if (!model || !ctx) return;
      const canvas = ctx.view.findAnyCanvas();
      const pane = canvas?.metrics.clientToScrollablePaneCoords(clientX, clientY);
      const canvasPos = (canvas && pane)
        ? canvas.metrics.scrollablePaneToPaperCoords(pane.x, pane.y)
        : { x: clientX, y: clientY };
      ensureWorkflowOntologies().then(() =>
        instantiateWorkflowOnCanvas(iri, canvasPos, model, ctx.editor, ctx)
      ).catch(err => {
        console.error('[ReactodiaCanvas] Workflow touch-drop instantiation failed', err);
        toast.error('Failed to instantiate workflow');
      });
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('vg-workflow-touch-drop', onTouchDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('vg-workflow-touch-drop', onTouchDrop);
    };
  }, []);

  return (
    <div
      style={{ width: '100vw', height: '100dvh', position: 'relative', background: 'var(--canvas-bg)' }}
    >
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
        left: sidebarExpanded && window.innerWidth >= 740 ? Math.min(288, window.innerWidth * 0.75) : 40,
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
                  flexDirection: isMobile ? 'column' : 'row',
                  flexWrap: 'nowrap',
                  alignItems: 'flex-start',
                  gap: 4,
                  width: '100%',
                  padding: '0 var(--reactodia-viewport-dock-margin, 10px)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                  position: 'relative',
                  zIndex: 'calc(var(--reactodia-z-index-base, 0) + 35)',
                }}>
                  {/* Reactodia hamburger + search */}
                  <div className="reactodia-toolbar" role="toolbar" style={{ display: 'flex', alignItems: 'center', pointerEvents: 'auto', flexShrink: 0, ...(isMobile ? { width: '100%' } : {}) }}>
                    <Reactodia.DropdownMenu
                      className="reactodia-toolbar__menu"
                      direction="down"
                      title="Menu"
                    >
                      <Reactodia.ToolbarAction title="Export PNG" onSelect={() => {
                        const canvas = getWorkspaceRefs().ctx.view.findAnyCanvas();
                        canvas?.exportRaster({ mimeType: 'image/png' }).then(dataUrl => {
                          const base = useOntologyStore.getState().dataFilename || 'knowledgegraph';
                          const a = document.createElement('a'); a.href = dataUrl; a.download = `${base}.png`; a.click();
                        });
                      }}>Export PNG</Reactodia.ToolbarAction>
                      <Reactodia.ToolbarAction title="Export SVG" onSelect={() => {
                        const canvas = getWorkspaceRefs().ctx.view.findAnyCanvas();
                        canvas?.exportSvg({ addXmlHeader: true }).then(svg => {
                          const base = useOntologyStore.getState().dataFilename || 'knowledgegraph';
                          const blob = new Blob([svg], { type: 'image/svg+xml' });
                          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${base}.svg`; a.click();
                        });
                      }}>Export SVG</Reactodia.ToolbarAction>
                      <Reactodia.ToolbarActionExport kind="print" />
                      <Reactodia.ToolbarAction
                        title={canvasState.showLegend ? 'Hide Legend' : 'Show Legend'}
                        onSelect={actions.toggleLegend}
                      >
                        {canvasState.showLegend ? 'Hide Legend' : 'Show Legend'}
                      </Reactodia.ToolbarAction>
                    </Reactodia.DropdownMenu>
                    <SearchMatchCounter />
                  </div>

                  {/* Spacer — desktop only */}
                  {!isMobile && <div style={{ flex: '1 1 0', minWidth: 0 }} />}

                  {/* Action buttons — never shrinks, scrolls internally */}
                  <div className="reactodia-toolbar" role="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'auto', overflowX: 'auto', overflowY: 'hidden', flexShrink: isMobile ? 0 : 1, maxWidth: '100%', ...(isMobile ? { width: '100%' } : {}) }}>
                    <LayoutPopover onToggle={() => { setLayoutPanelOpen(v => !v); setOntologyListOpen(false); }} />
                    <TopBar
                      viewMode={canvasState.viewMode as 'abox' | 'tbox'}
                      onViewModeChange={actions.setViewMode}
                      ontologyCount={ontologyCount}
                      foldLevel={currentLevel}
                      maxFoldLevel={maxFoldLevel}
                      canLevelUp={canGoUp}
                      canLevelDown={canGoDown}
                      onLevelUp={handleLevelUp}
                      onLevelDown={handleLevelDown}
                      onOpenReasoningReport={() => actions.toggleReasoningReport(true)}
                      onToggleOntologyList={() => { setOntologyListOpen(v => !v); setLayoutPanelOpen(false); }}
                      onRunReason={handleRunReasoning}
                      onClearInferred={handleClearInferred}
                      currentReasoning={currentReasoning}
                      isReasoning={isReasoning}
                      isInconsistentDetected={isInconsistentDetected}
                    />
                  </div>
                </div>
              </Reactodia.ViewportDock>
            </Reactodia.DefaultWorkspace>
          </PrefixContext.Provider>
        </Reactodia.Workspace>

        <ReasoningReportModal
          open={canvasState.showReasoningReport}
          onOpenChange={actions.toggleReasoningReport}
          currentReasoning={currentReasoning}
          reasoningHistory={reasoningHistory}
        />

        <OntologyListPanel
          open={ontologyListOpen}
          onClose={() => setOntologyListOpen(false)}
        />

        <LayoutSettingsPanel
          open={layoutPanelOpen}
          onClose={() => setLayoutPanelOpen(false)}
          onApplyLayout={() => performLayoutRef.current?.()}
        />

        <WorkflowExecutionDialog />

        {loadOntologyOpen && (
          <div
            className="absolute inset-0 z-50 flex items-start justify-center bg-black/60 pt-4"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setLoadOntologyOpen(false); }}
          >
            <div className="w-full max-w-lg max-h-[calc(100%-2rem)] overflow-y-auto rounded-lg border bg-background p-6 shadow-lg animate-in fade-in-0 zoom-in-95 duration-200">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold leading-none tracking-tight">Load Ontology</h2>
                  <p className="text-sm text-muted-foreground mt-1">Enter a URL or type to search well-known ontologies.</p>
                </div>
                <button
                  className="rounded-sm p-1.5 opacity-70 hover:opacity-100 hover:bg-accent transition-colors text-sm leading-none"
                  onClick={() => setLoadOntologyOpen(false)}
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ontologyUrl">Ontology URL</Label>
                  <OntologyUrlAutoComplete
                    value={ontologyUrlInput}
                    onChange={setOntologyUrlInput}
                  />
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
                        const wk = Object.values(WELL_KNOWN_BY_PREFIX).find(e => e.url === url);
                        const loadedLabel = wk?.name ?? (() => {
                          try { return new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/\.[^.]+$/, '') || url; }
                          catch { return url; }
                        })();
                        toast.success(`Loaded: ${loadedLabel}`);
                        setOntologyUrlInput('');
                        setLoadOntologyOpen(false);
                      } catch (err) {
                        console.error('Failed to load ontology:', err);
                      } finally {
                        actions.setLoading(false, 0, '');
                      }
                    }}
                  >
                    Load Ontology
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <ConfigurationPanel
          triggerVariant="none"
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      </div>

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

    </div>
  );
}
