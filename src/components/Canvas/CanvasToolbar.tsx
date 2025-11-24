import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Slider } from '../ui/slider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Plus,
  Upload,
  Eye,
  EyeOff,
  Download,
  Palette,
  Network,
  Layout,
  Settings,
  GitBranch,
  TreePine,
  Circle,
  Grid3X3,
  Layers,
  TreeDeciduous,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { NodePropertyEditor } from './NodePropertyEditor';
import { LayoutManager } from './LayoutManager';
import { WELL_KNOWN_PREFIXES } from '../../utils/wellKnownOntologies';
import { ConfigurationPanel } from './ConfigurationPanel';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { toPrefixed } from '../../utils/termUtils';

interface CanvasToolbarProps {
  onAddNode: (payload: any) => void;
  onToggleLegend: () => void;
  showLegend: boolean;
  onExport: (format: 'turtle' | 'owl-xml' | 'json-ld') => void;
  // New optional callbacks for image/svg export (full-only)
  onExportSvg?: () => void;
  onExportPng?: (scale?: number) => void;
  onLoadFile?: (file: File) => void;
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  onLayoutChange?: (layoutType: string, force?: boolean, options?: { nodeSpacing?: number }) => void;
  currentLayout?: string;
  // layoutEnabled: whether programmatic/layout application is enabled (toggle supplied by parent)
  layoutEnabled?: boolean;
  // callback when the layoutEnabled toggle changes
  onToggleLayoutEnabled?: (enabled: boolean) => void;
  onOpenNodeEditor?: (id?: string | null) => void;
  onOpenLinkEditor?: (id?: string | null) => void;
  // Callback invoked when the user confirms clearing the canvas data (UI-level clear).
  onClearData?: () => void;
  // Optional canvas actions forwarded from KnowledgeCanvas so the toolbar can toggle the global loading UI.
  canvasActions?: any;
  // New: allow CanvasToolbar to display programmatic layout application (control removed)
  availableEntities: Array<{
   iri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onExportSvg, onExportPng, onLoadFile, onClearData, canvasActions, viewMode, onViewModeChange, onLayoutChange, currentLayout = 'horizontal', layoutEnabled = false, onToggleLayoutEnabled, availableEntities }: CanvasToolbarProps) => {
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isLoadOntologyOpen, setIsLoadOntologyOpen] = useState(false);
  const [isLoadFileOpen, setIsLoadFileOpen] = useState(false);
  const [isClearDataOpen, setIsClearDataOpen] = useState(false);
  const [ontologyUrl, setOntologyUrl] = useState('');
  const [newNodeClass, setNewNodeClass] = useState('');
  const [newNodeNamespace, setNewNodeNamespace] = useState('');
  // New: allow entering an explicit IRI (or prefixed form) when adding a node.
  const [newNodeIri, setNewNodeIri] = useState('');
  const [fileSource, setFileSource] = useState('');
  const [rdfBody, setRdfBody] = useState('');

  const setCanvasLoading = useCallback(
    (isLoading: boolean, progress = 0, message = '') => {
      const setter =
        (canvasActions && typeof canvasActions.setLoading === 'function')
          ? canvasActions.setLoading
          : typeof window !== 'undefined' &&
              typeof (window as any).__VG_SET_LOADING === 'function'
            ? (window as any).__VG_SET_LOADING
            : null;
      if (setter) {
        try {
          setter(isLoading, progress, message);
        } catch (_) {
          // ignore setter errors
        }
      }
    },
    [canvasActions],
  );

  const {
    loadOntology,
    availableClasses,
    loadKnowledgeGraph,
    getRdfManager,
    loadOntologyFromRDF,
    loadedOntologies,
  } = useOntologyStore(
    useShallow((state) => ({
      loadOntology: state.loadOntology,
      availableClasses: state.availableClasses ?? [],
      loadKnowledgeGraph: state.loadKnowledgeGraph,
      getRdfManager: state.getRdfManager,
      loadOntologyFromRDF: state.loadOntologyFromRDF,
      loadedOntologies: state.loadedOntologies ?? [],
    })),
  );
  const loadOntologyFromRDFFn = loadOntologyFromRDF;
  // registeredCount excludes core vocabularies; configuredCount shows user-configured autoload list size
  // Count all loaded ontologies except explicit core vocabularies.
  // Some entries may not have a 'source' field set reliably, so detect core
  // vocabularies by URL as a fallback (W3C RDF/RDFS/OWL namespaces).
  // Count all loaded ontologies (including auto-loaded ones like owl, rdf, rdfs)
  // Strategy:
  // - Consider loadedOntologies entries that are not 'core' and whose URL is not a core W3C URL.
  // - Also consider configured additionalOntologies that are "present" (either registered in loadedOntologies
  //   or visible via the RDF manager namespaces) so autoloaded items count even when a loadedOntologies
  //   entry wasn't registered in every codepath.
  // - Use a lightweight normalization for comparison to avoid depending on canonical() which is declared later.
  const loadedList = useOntologyStore((s) => s.loadedOntologies || []);
  const configuredList = useAppConfigStore((s) =>
    s.config && Array.isArray((s.config as any).additionalOntologies)
      ? ((s.config as any).additionalOntologies as string[])
      : [],
  );

  const normalizeForCompare = (u?: string | null) => {
    if (!u) return "";
    try {
      let s = String(u).trim();
      if (!s) return s;
      // Remove protocol if present without using regex literals that trigger lint issues.
      const low = s.toLowerCase();
      if (low.startsWith("http://")) s = s.slice(7);
      else if (low.startsWith("https://")) s = s.slice(8);
      // Strip trailing slashes and hash characters
      while (s.length > 0 && (s.endsWith("/") || s.endsWith("#"))) {
        s = s.slice(0, -1);
      }
      return s.toLowerCase();
    } catch {
      return String(u || "").toLowerCase();
    }
  };

  // Build set of loaded non-core ontology keys
  const loadedKeys = new Set<string>((loadedList || []).map((o: any) => normalizeForCompare(o.url)));

  // Namespaces currently known to the RDF manager (use as additional evidence an ontology was loaded)
  const rdfMgr = (typeof getRdfManager === "function" && getRdfManager && getRdfManager()) || null;
  const rdfNsVals = (rdfMgr && typeof rdfMgr.getNamespaces === "function")
    ? Object.values(rdfMgr.getNamespaces() || {}).map((v: any) => normalizeForCompare(String(v)))
    : [];

  // Consider configured additional ontologies present if they match a loaded entry or an RDF manager namespace
  const presentConfigured = (configuredList || []).filter((c) => {
    try {
      const n = normalizeForCompare(c);
      if (!n) return false;
      if (loadedKeys.has(n)) return true;
      if (rdfNsVals.includes(n)) return true;
      return false;
    } catch {
      return false;
    }
  });

  // Show ALL loaded ontologies including auto-loaded, discovered, fetched, and failures
  const explicitLoaded = loadedList || [];

  // Count successes and failures for display
  const successCount = explicitLoaded.filter((o: any) => {
    const status = (o && (o as any).loadStatus) || "ok";
    return String(status) === "ok" || !status;
  }).length;
  const failedCount = explicitLoaded.filter((o: any) => {
    const status = (o && (o as any).loadStatus) || undefined;
    return String(status) === "fail";
  }).length;
  const pendingCount = explicitLoaded.filter((o: any) => {
    const status = (o && (o as any).loadStatus) || undefined;
    return String(status) === "pending";
  }).length;

  const registeredCount = explicitLoaded.length;
  const configuredCount = configuredList.length;

  // Build a merged list of namespaces: prefer namespaces discovered in the RDF manager
  // but include namespaces from loaded ontology metadata as a fallback.
  const namespacesFromLoaded = loadedOntologies.reduce((acc, ont) => ({ ...acc, ...ont.namespaces }), {} as Record<string, string>);
  const rdfManagerNamespaces = (getRdfManager && typeof getRdfManager === 'function') ? (getRdfManager()?.getNamespaces?.() || {}) : {};
  const mergedNamespaces = { ...namespacesFromLoaded, ...rdfManagerNamespaces };

  // Use the canonical fat-map classes from the ontology store (availableClasses).
  // The test and runtime populate availableClasses via the ontology store; prefer that.
  const classEntities = useMemo(() => {
    if (!Array.isArray(availableClasses)) return [];
    return (availableClasses as any[]).map((cls: any) => ({
      iri: String(cls.iri || cls || ''),
      label: (typeof cls.label === 'string' && cls.label.trim().length > 0) ? String(cls.label) : undefined,
      namespace: cls.namespace || '',
      rdfType: cls.rdfType || cls.type || 'owl:Class',
      description: cls.description
    }));
  }, [availableClasses]);

  // Centralized: ask LayoutManager for available layouts (keeps single source of truth).
  const layoutManager = new LayoutManager();
  const layoutOptions = layoutManager.getAvailableLayouts();

  // Persistent layout spacing (single source of truth) — toolbar exposes a compact control.
  const { config, setLayoutSpacing } = useAppConfigStore(
    useShallow((state) => ({
      config: state.config,
      setLayoutSpacing: state.setLayoutSpacing,
    })),
  );
  const [tempLayoutSpacing, setTempLayoutSpacing] = useState<number>(config.layoutSpacing ?? 120);
  // Keep slider in sync when value changes elsewhere
  React.useEffect(() => {
    setTempLayoutSpacing(config.layoutSpacing ?? 120);
  }, [config.layoutSpacing]);

  const getLayoutIcon = (iconName?: string) => {
    const icons = {
      GitBranch,
      TreePine,
      Circle,
      Grid3X3,
      Layers,
      TreeDeciduous,
    } as Record<string, any>;
    return (iconName && (icons[iconName] || icons[iconName as keyof typeof icons])) || Layout;
  };

  const handleLayoutChange = (layoutType: string) => {
    // Always request layout application when the user selects from the UI dropdown.
    // The consumer may choose to respect or ignore the layoutEnabled toggle; we pass
    // `force=true` so the selection always triggers a layout run.
    onLayoutChange?.(layoutType, true);
    toast.success(`Applied ${layoutType} layout`, {
      description: `Graph reorganized with new layout`
    });
  };

  const handleLoadOntology = async () => {
    const trimmedUrl = ontologyUrl.trim();
    if (!trimmedUrl) return;
    if (typeof loadOntology !== 'function') {
      toast.error('Ontology loader is unavailable');
      return;
    }

    setCanvasLoading(true, 5, 'Loading ontology...');
    setIsLoadOntologyOpen(false);

    try {
      await loadOntology(trimmedUrl);
      setCanvasLoading(false, 100, '');
      setOntologyUrl('');
      toast.success('Ontology loaded');
    } catch (error) {
      setCanvasLoading(false, 0, '');
      const message =
        error instanceof Error ? error.message : String(error ?? 'Unknown error');
      toast.error(`Failed to load ontology: ${message}`, {
        description:
          'Paste the RDF via "Paste RDF", upload the file, or retry with a proxy-hosted URL if cross-origin restrictions apply.',
      });
    }
  };

  // const handleAddNode = () => {
  //   // Prefer explicit IRI input if provided, otherwise fall back to selected class IRI.
  //   const iriToAdd = (newNodeIri && String(newNodeIri).trim()) ? String(newNodeIri).trim() : String(newNodeClass || '').trim();
  //   if (!iriToAdd) return;

  //   try {
  //     onAddNode({
  //       iri: iriToAdd,
  //       classCandidate: newNodeClass ? String(newNodeClass) : undefined,
  //       namespace: newNodeNamespace ? String(newNodeNamespace) : undefined,
  //     } as any);
  //     setNewNodeClass('');
  //     setNewNodeNamespace('');
  //     setNewNodeIri('');
  //     setIsAddNodeOpen(false);
  //   } catch (error) {
  //     const message =
  //       error instanceof Error ? error.message : String(error ?? 'Unknown error');
  //     toast.error(`Failed to add node: ${message}`);
  //   }
  // };

  const handleConfirmClearData = () => {
    try {
      const mgr = (typeof getRdfManager === 'function' && getRdfManager && getRdfManager()) || null;
      if (!mgr) {
        toast.error('RDF manager not available');
        setIsClearDataOpen(false);
        return;
      }
      try {
        // First, clear the canvas UI immediately if the parent provided a handler.
        try {
          if (typeof onClearData === 'function') {
            try { onClearData(); } catch (_) { /* ignore parent handler errors */ }
          }
        } catch (_) { /* ignore */ }

        // Then remove persistence from the RDF graph.
        mgr.removeGraph('urn:vg:data');
        toast.success('Cleared graph: urn:vg:data');
      } catch (err) {
        console.error('Failed to clear data graph', err);
        toast.error('Failed to clear data graph');
      } finally {
        setIsClearDataOpen(false);
      }
    } catch (err) {
      try { setIsClearDataOpen(false); } catch (_) { void 0; }
    }
  };

  // Build unified list of options by joining RDF manager namespaces with well-known ontologies (deduped by URL).
  // Normalize URLs for matching so http/https and trailing slash differences don't create duplicates.
  const normalizeNamespaceKey = (u?: string) => {
    if (!u) return '';
    try {
      let s = String(u);
      // Remove protocol without regex to avoid escape-related lint warnings
      const low = s.toLowerCase();
      if (low.startsWith('http://')) s = s.slice(7);
      else if (low.startsWith('https://')) s = s.slice(8);
      // Strip trailing slashes and hashes
      while (s.length > 0 && (s.endsWith('/') || s.endsWith('#'))) s = s.slice(0, -1);
      return s;
    } catch {
      return String(u || '');
    }
  };

  // Robust canonicalization helper used when comparing configured URIs with loaded ontology URLs.
  // Canonical form prefers https and a URL.toString() when possible, falling back to a trimmed,
  // trailing-slash-stripped string so loose variants still match.
  const canonical = (u?: string | null) => {
    try {
      if (!u) return String(u || '');
      let s = String(u).trim();
      if (!s) return s;
      if (s.toLowerCase().startsWith('http://')) s = s.replace(/^http:\/\//i, 'https://');
      try {
        return new URL(s).toString();
      } catch {
        // Fallback: strip trailing slashes and hashes without using a regex literal that contains '/'
        while (s.length > 0 && (s.endsWith('/') || s.endsWith('#'))) s = s.slice(0, -1);
        return s;
      }
    } catch (_) {
      return String(u || '');
    }
  };

  const namespaceOptionsMap = new Map<string, { url: string; title: string; prefix?: string }>();
  // Add namespaces discovered in RDF manager / loaded ontologies (prefix -> namespaceUri)
  Object.entries(mergedNamespaces || {}).forEach(([prefix, namespace]) => {
    if (namespace) {
      const key = normalizeNamespaceKey(namespace);
      const entry = namespaceOptionsMap.get(key);
      if (!entry) {
        namespaceOptionsMap.set(key, { url: String(namespace), title: String(prefix), prefix: String(prefix) });
      } else {
        // Prefer keeping an explicit prefix if the entry lacks one
        entry.prefix = entry.prefix || String(prefix);
      }
    }
  });

  // Merge well-known ontologies, prefer well-known name and canonical URL for display when available.
  for (const p of WELL_KNOWN_PREFIXES) {
    const key = normalizeNamespaceKey(p.url);
    const existing = namespaceOptionsMap.get(key);
    if (existing) {
      // Prefer the well-known display name and canonical well-known URL
      existing.title = p.name || existing.title;
      existing.prefix = existing.prefix || p.prefix;
      // Prefer the well-known canonical URL so variants (http/https/trailing chars) unify visually
      existing.url = p.url;
    } else {
      namespaceOptionsMap.set(key, { url: p.url, title: p.name, prefix: p.prefix });
    }
  }

  const combinedOntologyOptions = Array.from(namespaceOptionsMap.values()).sort((a, b) => String(a.title).localeCompare(String(b.title)));

  return (
    <div className="absolute top-4 left-4 z-10 flex flex-wrap gap-2">
      {/* Add Node: open the full NodePropertyEditor in create mode (empty node data).
          If the editor returns a create payload (with iri), forward to onAddNode; otherwise
          fall back to toolbar inputs. */}
      <Button variant="default" size="sm" className="shadow-glass backdrop-blur-sm text-foreground" onClick={() => setIsAddNodeOpen(true)}>
        <Plus className="h-4 w-4 mr-2" />
        Add Node
      </Button>

      <NodePropertyEditor
        open={isAddNodeOpen}
        onOpenChange={(v) => setIsAddNodeOpen(v)}
        // Do NOT prefill owl:NamedIndividual for A-Box here. Let the editor be empty and
        // add the rdf:type triple only when the user saves the dialog.
        nodeData={
          viewMode === 'tbox'
            ? { classType: 'http://www.w3.org/2002/07/owl#Class' }
            : {}
        }
        // Instruct the editor to add owl:NamedIndividual on save for A-Box create flows.
        addNamedIndividualOnSave={viewMode === 'abox'}
        onSave={(payload: any) => {
          try {
            if (payload && payload.iri) {
              // create payload from editor
              onAddNode({
                iri: String(payload.iri),
                classCandidate: payload.classCandidate,
                namespace: payload.namespace,
                annotationProperties: payload.annotationProperties,
                rdfTypes: payload.rdfTypes,
              });
            }
          } catch (_) {
            // ignore add failures here — caller will handle
          } finally {
            setNewNodeIri('');
            setNewNodeClass('');
            setNewNodeNamespace('');
            setIsAddNodeOpen(false);
          }
        }}
        onDelete={undefined}
      />

      {/* Load Ontology Dialog */}
      <Dialog open={isLoadOntologyOpen} onOpenChange={setIsLoadOntologyOpen}>
          <DialogTrigger asChild>
          <Button variant="secondary" size="sm" className="shadow-glass backdrop-blur-sm text-foreground-dark">
            <Upload className="h-4 w-4 mr-2" />
            Load Ontology
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg max-h-[90vh] max-w-[min(90vw,32rem)] overflow-y-auto text-foreground">
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
                value={ontologyUrl}
                onChange={(e) => setOntologyUrl(e.target.value)}
              />
            </div>
            
            <div className="space-y-2">
              <Label>Available Ontologies & Prefixes</Label>

              <div className="space-y-2">
                <Label htmlFor="rdfPaste">Paste RDF (optional)</Label>
                <textarea
                  id="rdfPaste"
                  value={rdfBody}
                  onChange={(e) => setRdfBody(e.target.value)}
                  placeholder="Paste Turtle / RDF/XML / JSON-LD here to register its prefixes and optionally load it as an ontology"
                  className="w-full min-h-24 p-2 bg-input border border-border rounded"
                />
                <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (!rdfBody.trim()) return;
                          try {
                            // Ensure pasted RDF is treated as an ontology by persisting into the ontology graph
                            await loadOntologyFromRDFFn?.(rdfBody, undefined, true, "urn:vg:ontologies");
                            setRdfBody('');
                            setIsLoadOntologyOpen(false);
                            toast.success('RDF content applied as ontology (prefixes registered)');
                          } catch (err) {
                            const message =
                              err instanceof Error ? err.message : String(err ?? 'Unknown error');
                            console.warn('Failed to load RDF content as ontology:', message);
                            toast.error('Failed to load RDF content');
                          }
                        }}
                        disabled={!rdfBody.trim()}
                      >
                        Load RDF
                      </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRdfBody('')}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                {/* Combined list of namespaces and well-known ontologies (deduped by URL) */}
                {combinedOntologyOptions.map((opt, index) => (
                  <Button
                    key={`${opt.url}-${index}`}
                    variant={ontologyUrl === opt.url ? "default" : "outline"}
                    size="sm"
                    className="justify-start text-left h-auto py-2"
                    onClick={() => setOntologyUrl(opt.url)}
                  >
                    <div>
                      <div className="font-medium">{opt.title}</div>
                      <div className="text-xs text-muted-foreground">{opt.url}</div>
                    </div>
                  </Button>
                ))}
              </div>
            </div>

            {loadedOntologies && loadedOntologies.length > 0 && (
              <div className="space-y-2">
                <Label>Loaded Ontologies</Label>
                <div className="flex flex-wrap gap-1">
                  {loadedOntologies.map((ont, index) => (
                    <Badge key={`${ont.url}-${index}`} variant="secondary" className="text-xs">
                      {ont.name || (() => { try { return new URL(ont.url).hostname } catch (_) { return String(ont.url) } })()}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsLoadOntologyOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleLoadOntology} disabled={!ontologyUrl.trim()}>
                Load Ontology
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Mode Toggle */}
        <div className="flex items-center bg-card/80 backdrop-blur-sm border border-border rounded-md shadow-glass">
        <Button
          variant={viewMode === 'abox' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('abox')}
          className="rounded-r-none text-foreground"
        >
          A-Box
        </Button>
        <Button
          variant={viewMode === 'tbox' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('tbox')}
          className="rounded-l-none text-foreground"
        >
          T-Box
        </Button>
      </div>

      {/* Toggle Legend */}
      <Button 
        variant="secondary" 
        size="sm" 
        onClick={onToggleLegend}
        className="shadow-glass backdrop-blur-sm bg-accent hover:bg-accent-hover text-foreground-dark"
      >
        {showLegend ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
        Legend
      </Button>

      <Popover>
          <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-card/80 border border-border shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40 text-foreground"
            aria-expanded="false"
          >
            <Layout className="h-4 w-4" />
            <span className="sr-only">Layout</span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" sideOffset={6} className="w-80 rounded-lg border bg-popover p-4 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">Layouts</div>
            
          </div>

          <div className="">
            {layoutOptions.map((layout) => {
              const IconComponent = getLayoutIcon(layout.icon as any);
              return (
                <button
                  key={layout.type}
                  onClick={() => {
                    {
                      onLayoutChange?.(layout.type, true, { nodeSpacing: config.layoutSpacing });
                    }
                  }}
                  className=""
                >
                  <IconComponent className="h-5 w-5 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{layout.label}</div>
                    <div className="text-xs text-muted-foreground">{layout.description}</div>
                  </div>
                  {currentLayout === layout.type && (
                    <Badge variant="secondary" className="text-xs">Active</Badge>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-3 mb-2 pt-2">
            <div className="text-sm font-medium">Spacing</div>
            <div
              className="flex items-center gap-2 px-2 py-1 bg-card/80 border border-border rounded-md"
              onPointerUp={() => {
                try {
                  const v = tempLayoutSpacing;
                  setLayoutSpacing(v);
                  onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                  toast.success(`Saved spacing: ${v}px`);
                } catch (_) { /* ignore */ }
              }}
              onTouchEnd={() => {
                try {
                  const v = tempLayoutSpacing;
                  setLayoutSpacing(v);
                  onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                  toast.success(`Saved spacing: ${v}px`);
                } catch (_) { /* ignore */ }
              }}
              onMouseUp={() => {
                try {
                  const v = tempLayoutSpacing;
                  setLayoutSpacing(v);
                  onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                  toast.success(`Saved spacing: ${v}px`);
                } catch (_) { /* ignore */ }
              }}
            >
              <div className="text-xs text-muted-foreground">Spacing</div>
              <div className="w-56">
                <Slider
                  value={[tempLayoutSpacing]}
                  onValueChange={([v]) => {
                    { setTempLayoutSpacing(v); }
                    { useAppConfigStore.getState().setLayoutSpacing(v); }
                    { onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v }); }
                  }}
                  min={50}
                  max={500}
                  step={10}
                  className="w-full"
                />
              </div>
              <div className="text-xs font-medium">{tempLayoutSpacing}px</div>
            </div>
          </div>

          <div className="mt-3 pt-2 border-t flex gap-2 items-center">
            <div className="flex-1">
              <div className="text-sm font-medium mb-1">Auto layout</div>
              <div className="text-xs text-muted-foreground">Enable programmatic layout application</div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded text-sm bg-muted"
                onClick={() => {
                  {
                    const v = tempLayoutSpacing;
                    try { useAppConfigStore.getState().setLayoutSpacing(v); } catch (_) { void 0; }
                    onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                  }
                }}
              >
                Apply
              </button>

              <button
                type="button"
                className="px-3 py-1 rounded text-sm bg-muted"
                onClick={() => {
                  {
                    useAppConfigStore.getState().setLayoutSpacing(120);
                    onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: 120 });
                    toast.success('Reset spacing to 120px');
                  }
                }}
              >
                Reset
              </button>

              {/* Auto toggle */}
              <button
                type="button"
                onClick={() => {
                  {
                    const enabled = !layoutEnabled;
                    if (typeof onToggleLayoutEnabled === 'function') {
                      try {
                        onToggleLayoutEnabled(enabled);
                      } catch (_) { /* ignore */ }
                    }
                    toast.success(enabled ? 'Layout toggled ON' : 'Layout toggled OFF');
                  }
                }}
                className={layoutEnabled ? 'px-3 py-1 rounded text-sm border bg-primary text-white' : 'px-3 py-1 rounded text-sm border bg-card'}
                aria-pressed={layoutEnabled}
              >
                Auto
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>



      {/* Load File */}
      <Dialog open={isLoadFileOpen} onOpenChange={setIsLoadFileOpen}>
          <DialogTrigger asChild>
          <Button
            variant="outline" 
            size="sm"
            className="shadow-glass backdrop-blur-sm text-foreground"
          >
            <Upload className="h-4 w-4 mr-2" />
            Load File
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md text-foreground">
          <DialogHeader>
            <DialogTitle>Load RDF File</DialogTitle>
            <DialogDescription>
              Load from a file or URL containing RDF/OWL data.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fileUrl">File URL</Label>
              <div className="flex gap-2">
                <Input
                  id="fileUrl"
                  placeholder="https://example.com/data.ttl"
                  value={fileSource}
                  onChange={(e) => setFileSource(e.target.value)}
                />
                  <Button 
                    onClick={async () => {
                      if (fileSource.trim() && onLoadFile) {
                        try {
                          // Request a one-shot forced layout after the load mapping completes
                          try {
                            if ((window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING) {
                              try { (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING(); } catch (_) { void 0; }
                            }
                          } catch (_) { void 0; }
                          const mockFile = { 
                            url: fileSource.trim(),
                            type: 'url'
                          };
                      await onLoadFile(mockFile as any);
                      setFileSource('');
                      setIsLoadFileOpen(false);
                    } catch (error) {
                      const message =
                        error instanceof Error
                          ? error.message
                          : String(error ?? 'Unknown error');
                      console.warn('Failed to load file from URL:', message);
                    }
                  }
                }}
                disabled={!fileSource.trim()}
                variant="outline"
                  >
                    Load
                  </Button>
              </div>
            </div>
            
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or upload file
                </span>
              </div>
            </div>

            <input
              type="file"
              accept=".ttl,.rdf,.owl,.n3"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file && onLoadFile) {
                  try {
                    // Request a one-shot forced layout after the load mapping completes
                      try {
                        if ((window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING) {
                          try { (window as any).__VG_REQUEST_FORCE_LAYOUT_NEXT_MAPPING(); } catch (_) { void 0; }
                        }
                      } catch (_) { void 0; }
                    await onLoadFile(file);
                    setIsLoadFileOpen(false);
                  } catch (error) {
                    const message =
                      error instanceof Error
                        ? error.message
                        : String(error ?? 'Unknown error');
                    console.warn('Failed to load file:', message);
                    toast.error('Failed to load file');
                  }
                }
              }}
              className="hidden"
              id="file-input"
            />
            <Button
              variant="outline"
              onClick={() => document.getElementById('file-input')?.click()}
              className="w-full"
            >
              Choose File
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Clear Data (remove all triples from urn:vg:data) */}
      <Dialog open={isClearDataOpen} onOpenChange={setIsClearDataOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shadow-glass backdrop-blur-sm text-foreground"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Clear Data
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md text-foreground">
          <DialogHeader>
            <DialogTitle>Clear data</DialogTitle>
            <DialogDescription>
              Remove all triples from the data graph <code>urn:vg:data</code>. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsClearDataOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="border-red-600 text-red-600"
              onClick={handleConfirmClearData}
            >
              Clear Data
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Export Options */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="shadow-glass backdrop-blur-sm text-foreground">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem data-testid="export-svg-full" onClick={() => onExportSvg?.()}>
            Export SVG — Full
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="export-png-full" onClick={() => onExportPng?.(2)}>
            Export PNG — Full
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onExport('turtle')}>
            Turtle (.ttl)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport('owl-xml')}>
            OWL/XML (.owl)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport('json-ld')}>
            JSON-LD (.jsonld)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Loaded Ontologies (interactive) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shadow-glass backdrop-blur-sm flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{registeredCount} ontologies ({configuredCount} configured)</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-h-64 overflow-y-auto z-50">
          <div className="p-2">
            <div className="text-xs text-muted-foreground mb-2">Loaded ontologies and auto-load status</div>
              {explicitLoaded.length === 0 ? (
              <div className="text-xs text-muted-foreground">No ontologies loaded</div>
            ) : (
              explicitLoaded.map((ont, idx) => {
                const isAuto = (useAppConfigStore.getState().config.additionalOntologies || []).some((a) => canonical(a) === canonical(ont.url));
                const status = (ont as any).loadStatus || "ok";
                const source = (ont as any).source || "requested";
                const loadError = (ont as any).loadError;

                // Use toPrefixed to get a proper prefixed name for the ontology URL
                const getPrefixedName = (url: string): string => {
                  try {
                    const namespaceRegistry = useOntologyStore.getState().namespaceRegistry || [];

                    // Try matching with the URL as-is
                    let prefixed = toPrefixed(url, namespaceRegistry);

                    // If no match, try with trailing slash (common discrepancy)
                    if (prefixed === url && !url.endsWith('/')) {
                      prefixed = toPrefixed(url + '/', namespaceRegistry);
                    }

                    // If still no match, try without trailing slash
                    if (prefixed === url && url.endsWith('/')) {
                      prefixed = toPrefixed(url.slice(0, -1), namespaceRegistry);
                    }

                    // If still no match, try with http/https protocol swap (common discrepancy)
                    if (prefixed === url || prefixed === url + '/' || prefixed === url.slice(0, -1)) {
                      const swappedUrl = url.startsWith('https://') ? url.replace('https://', 'http://') :
                                        url.startsWith('http://') ? url.replace('http://', 'https://') : url;
                      if (swappedUrl !== url) {
                        prefixed = toPrefixed(swappedUrl, namespaceRegistry);
                        // Also try swapped URL with trailing slash variations
                        if (prefixed === swappedUrl && !swappedUrl.endsWith('/')) {
                          prefixed = toPrefixed(swappedUrl + '/', namespaceRegistry);
                        }
                        if (prefixed === swappedUrl && swappedUrl.endsWith('/')) {
                          prefixed = toPrefixed(swappedUrl.slice(0, -1), namespaceRegistry);
                        }
                      }
                    }

                    // Check if toPrefixed actually found a prefix (result is different and is NOT a URL)
                    const isUrl = prefixed.toLowerCase().startsWith('http://') || prefixed.toLowerCase().startsWith('https://');
                    if (!isUrl && prefixed.includes(':')) {
                      // Extract just the prefix part (before the colon) and capitalize it
                      const prefix = prefixed.split(':')[0];
                      return prefix ? prefix.toUpperCase() + ':' : url;
                    }
                    // If no prefix found (toPrefixed returns the URL unchanged), return the URL
                    return url;
                  } catch {
                    return url;
                  }
                };

                const prefixedName = getPrefixedName(ont.url);
                // Use prefixedName directly (it will be either the capitalized prefix or the full URL)
                const displayName = prefixedName;

                return (
                      <div key={`${ont.url}-${idx}`} className="flex flex-col gap-1 p-2 rounded hover:bg-accent/5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium" title={ont.url}>
                              {displayName}
                            </div>
                            <div className="text-xs text-muted-foreground truncate" title={ont.url}>{ont.url}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            {status === "fail" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs h-6 px-2"
                                onClick={async () => {
                                  try {
                                    await loadOntology(ont.url, { autoload: false });
                                    toast.success('Retry successful');
                                  } catch (e) {
                                    toast.error('Retry failed');
                                  }
                                }}
                                title="Retry loading"
                              >
                                🔄
                              </Button>
                            )}
                            {isAuto ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs"
                                onClick={() => {
                                  try {
                                    useAppConfigStore.getState().removeAdditionalOntology(ont.url);
                                    toast.success('Removed from auto-load');
                                  } catch (e) {
                                    toast.error('Failed to update');
                                  }
                                }}
                              >
                                Auto (Remove)
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-xs"
                                onClick={() => {
                                  try {
                                    useAppConfigStore.getState().addAdditionalOntology(ont.url);
                                    toast.success('Added to auto-load');
                                  } catch (e) {
                                    toast.error('Failed to update');
                                  }
                                }}
                              >
                                Add Auto
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {/* Load status badge - shown first */}
                          {status === "ok" && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
                              ✓ Loaded
                            </Badge>
                          )}
                          {status === "fail" && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800">
                              ✗ Failed
                            </Badge>
                          )}
                          {status === "pending" && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-400 dark:border-yellow-800">
                              ⏳ Pending
                            </Badge>
                          )}

                          {/* Source type badge - shown second */}
                          {source === "auto" && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800">
                              ⚡ Auto
                            </Badge>
                          )}
                          {source === "discovered" && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-800">
                              🔍 Discovered
                            </Badge>
                          )}
                          {(source === "fetched" || source === "requested") && !isAuto && (
                            <Badge variant="outline" className="text-xs px-1 py-0 bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-950 dark:text-gray-400 dark:border-gray-800">
                              Manual
                            </Badge>
                          )}
                        </div>
                        {status === "fail" && loadError && (
                          <div className="text-xs text-red-600 dark:text-red-400" title={loadError}>
                            {loadError}
                          </div>
                        )}
                      </div>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="text-foreground ml-auto flex items-center">
        <ConfigurationPanel triggerVariant="inline-icon" />
      </div>
    </div>
  );
};
