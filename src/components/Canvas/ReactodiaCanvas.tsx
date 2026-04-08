import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { UnifiedSearchTopic } from '@reactodia/workspace';
// useOntologyStore must be imported before rdfManager to avoid a TDZ circular-dep error:
// rdfManager.ts → rdfManager.impl.ts → ontologyStore.ts → rdfManager (TDZ if rdfManager starts first)
import { useOntologyStore } from '@/stores/ontologyStore';
import { rdfManager } from '@/utils/rdfManager';
import type { ReasoningResult } from '@/utils/rdfManager';
import { N3DataProvider, type ViewMode } from '@/providers/N3DataProvider';
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
import ResizableNamespaceLegend from './ResizableNamespaceLegend';
import { useAppConfigStore } from '@/stores/appConfigStore';
import { getLayoutFunction } from './layout/getLayoutFunction';
import { toast } from 'sonner';

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
const dataProvider = new N3DataProvider();
const metadataProvider = new RdfMetadataProvider(rdfManager);
const validationProvider = new RdfValidationProvider();

// Track all subject IRIs ever seen (for initial load and incremental adds)
const knownSubjects = new Set<string>();

// Current view mode state
let currentViewMode: ViewMode = 'abox';

// Persisted layout per view mode, saved via model.exportLayout() before each switch
const savedLayoutsByMode: Partial<Record<ViewMode, Reactodia.SerializedDiagram>> = {};


export default function ReactodiaCanvas() {
  const { defaultLayout } = Reactodia.useWorker(Layouts);
  const { state: canvasState, actions } = useCanvasState();
  const [sidebarExpanded, setSidebarExpanded] = React.useState(true);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [isReasoning, setIsReasoning] = React.useState(false);
  const [currentReasoning, setCurrentReasoning] = React.useState<ReasoningResult | null>(null);
  const [reasoningHistory, setReasoningHistory] = React.useState<ReasoningResult[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const performLayoutRef = React.useRef<(() => Promise<void>) | null>(null);

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

  const { onMount } = Reactodia.useLoadedWorkspace(async ({ context, signal }) => {
    const { model, view, getCommandBus } = context;
    modelRef.current = model;
    commandBusRef.current = getCommandBus;
    contextRef.current = context;

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
  }, []);

  // Subscribe to rdfManager changes — incremental sync to live model
  React.useEffect(() => {
    const handler = (subjects: string[], quads?: WorkerQuad[], _snapshot?: unknown, meta?: Record<string, unknown> | null) => {
      if (metadataProvider.suppressSync) return;

      // Only process subjects from urn:vg:data or urn:vg:inferred (or unspecified).
      const incomingGraphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      if (incomingGraphName && incomingGraphName !== 'urn:vg:data' && incomingGraphName !== 'urn:vg:inferred') {
        return;
      }

      const isFullRefresh = meta?.reason === 'emitAllSubjects';
      const model = modelRef.current;
      const ctx = contextRef.current;

      // Determine which subjects are new vs already on canvas
      const existingIris = new Set(
        model
          ? model.elements
              .filter((el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement)
              .map(el => el.data.id)
          : []
      );
      const added = subjects.filter(s => !existingIris.has(s));
      const changed = subjects.filter(s => existingIris.has(s));

      subjects.forEach(s => knownSubjects.add(s));

      if (quads && quads.length > 0) {
        dataProvider.addGraph(workerQuadsToRdf(quads as unknown as ConverterQuad[]));
      }

      if (!model || !ctx) return;

      // Filter by current view mode now that quads (and their rdf:type triples) are in the provider
      const addedFiltered = dataProvider.filterByViewMode(added);

      // Read autoApplyLayout without subscribing — we only need the value at call time
      const autoApplyLayout = (useAppConfigStore as any).getState().config.autoApplyLayout as boolean;

      // Defer model mutations out of the React lifecycle to avoid flushSync warnings
      queueMicrotask(async () => {
        for (const iri of addedFiltered) {
          model.createElement(iri as Reactodia.ElementIri);
        }
        // Redraw elements whose data changed
        for (const iri of changed) {
          const el = model.elements
            .filter((e): e is Reactodia.EntityElement => e instanceof Reactodia.EntityElement)
            .find(e => e.data.id === iri);
          el?.redraw();
        }

        await model.requestData();

        if (!autoApplyLayout || addedFiltered.length === 0) return;

        const controller = new AbortController();

        const cfg = (useAppConfigStore as any).getState().config;
        const layoutFn = getLayoutFunction(cfg.currentLayout, cfg, defaultLayout);

        if (isFullRefresh) {
          // emitAllSubjects = full dataset reload: lay out the whole canvas
          await ctx.performLayout({ layoutFunction: layoutFn, animate: cfg.layoutAnimations, signal: controller.signal });
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

  // Handle view mode changes (ABox/TBox)
  React.useEffect(() => {
    const mode = canvasState.viewMode as ViewMode;
    if (mode === currentViewMode) return;
    const prevMode = currentViewMode;
    currentViewMode = mode;

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
        // Restore the previously computed layout for this mode
        await model.importLayout({ dataProvider, diagram, signal: controller.signal });

        // Add any elements that were added while we were in the other mode
        const inModel = new Set(
          model.elements
            .filter((e): e is Reactodia.EntityElement => e instanceof Reactodia.EntityElement)
            .map(e => e.data.id)
        );
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
        ctx.view.findAnyCanvas()?.zoomToFit();
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

  const handleClearData = React.useCallback(() => {
    knownSubjects.clear();
    const model = modelRef.current;
    if (!model) return;
    queueMicrotask(() => {
      for (const el of [...model.elements]) {
        model.removeElement(el.id);
      }
    });
  }, []);

  const handleRunReasoning = React.useCallback(async () => {
    setIsReasoning(true);
    try {
      const result = await rdfManager.runReasoning();
      setCurrentReasoning(result);
      setReasoningHistory(h => [...h, result]);
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
    setSettingsOpen(true);
  }, []);

  const handleExport = React.useCallback(async () => {
    try {
      const { exportPngFull } = await import('./core/downloadHelpers');
      await exportPngFull();
    } catch (err) {
      console.error('[ReactodiaCanvas] PNG export failed', err);
      toast.error('PNG export failed');
    }
  }, []);

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
            const iri = `urn:vg:entity:${Date.now()}` as Reactodia.ElementIri;
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
              }}
              dropOnCanvas={{ getDroppedItems: handleDropOnCanvas }}
              menu={null}
              search={null}
              actions={<>
                <Reactodia.ToolbarActionUndo />
                <Reactodia.ToolbarActionRedo />
                <Reactodia.ToolbarAction
                  title="Layout Settings"
                  onSelect={() => setSettingsOpen(true)}
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

                  {/* Custom items */}
                  <div style={{ pointerEvents: 'auto' }}>
                    <TopBar
                      viewMode={canvasState.viewMode as 'abox' | 'tbox'}
                      onViewModeChange={actions.setViewMode}
                      ontologyCount={ontologyCount}
                      onOpenReasoningReport={() => actions.toggleReasoningReport(true)}
                      onRunReason={handleRunReasoning}
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
        onExport={handleExport}
        onSettings={() => setSettingsOpen(true)}
      />



      {canvasState.showLegend && <ResizableNamespaceLegend />}

      <ConfigurationPanel
        triggerVariant="none"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onApplyLayout={() => performLayoutRef.current?.()}
      />

      <ReasoningReportModal
        open={canvasState.showReasoningReport}
        onOpenChange={actions.toggleReasoningReport}
        currentReasoning={currentReasoning}
        reasoningHistory={reasoningHistory}
      />
    </div>
  );
}
