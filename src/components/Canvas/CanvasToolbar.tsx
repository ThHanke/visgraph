import React, { useState, useEffect, useMemo } from 'react';
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
import { fallback } from '../../utils/startupDebug';
import { LayoutManager } from './LayoutManager';
import { WELL_KNOWN_PREFIXES } from '../../utils/wellKnownOntologies';
import { ConfigurationPanel } from './ConfigurationPanel';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';

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
  // New: allow CanvasToolbar to display programmatic layout application (control removed)
  availableEntities: Array<{
   iri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onExportSvg, onExportPng, onLoadFile, onClearData, viewMode, onViewModeChange, onLayoutChange, currentLayout = 'horizontal', layoutEnabled = false, onToggleLayoutEnabled, availableEntities }: CanvasToolbarProps) => {
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
  
  // Select functions from the store as stable callbacks; subscribe separately to the loadedOntologies array
  const { loadOntology, availableClasses, loadKnowledgeGraph, getRdfManager } = useOntologyStore();
  // Backwards-compatible selector: tests may set either loadOntologyFromRDF or loadOntologyRDFtoGraph on the store.
  const loadOntologyFromRDFFn = useOntologyStore((s: any) => (typeof s.loadOntologyFromRDF === "function" ? s.loadOntologyFromRDF : s.loadOntologyRDFtoGraph));
  const loadedOntologies = useOntologyStore((s) => s.loadedOntologies);
  // registeredCount excludes core vocabularies; configuredCount shows user-configured autoload list size
  // Count all loaded ontologies except explicit core vocabularies.
  // Some entries may not have a 'source' field set reliably, so detect core
  // vocabularies by URL as a fallback (W3C RDF/RDFS/OWL namespaces).
  const isCoreUrl = (u?: string | null) => {
    if (!u) return false;
    try {
      const s = String(u);
      return (
        s.includes("www.w3.org/2002/07/owl") ||
        s.includes("www.w3.org/1999/02/22-rdf-syntax-ns") ||
        s.includes("www.w3.org/2000/01/rdf-schema") ||
        s.includes("www.w3.org/XML/1998/namespace") ||
        s.includes("www.w3.org/2001/XMLSchema")
      );
    } catch {
      return false;
    }
  };

  // Count non-core loaded ontologies robustly.
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
  const loadedNonCore = (loadedList || []).filter((o: any) => {
    try {
      if (!o) return false;
      if ((o.source as any) && String(o.source) === "core") return false;
      if (isCoreUrl(o.url)) return false;
      return true;
    } catch {
      return false;
    }
  });

  const loadedKeys = new Set<string>((loadedNonCore || []).map((o: any) => normalizeForCompare(o.url)));

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

  // Only count/store the explicitly-registered ontologies created by user-requested or fetched loads.
  // This makes the toolbar show exactly what's been intentionally added (requested || fetched).
  const explicitLoaded = (loadedList || []).filter((o: any) => {
    try {
      const s = (o && (o.source as any)) || "";
      return String(s) === "requested" || String(s) === "fetched";
    } catch {
      return false;
    }
  });

  const registeredCount = explicitLoaded.length;

  const configuredCount = configuredList.length;

  // Debug subscription: surface loadedOntologies/loadedCount changes to console so we can trace why the toolbar count may stay at 0.
  React.useEffect(() => {
    {
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug("[VG_DEBUG] CanvasToolbar.loadedOntologies change", {
          registeredCount,
          configuredCount,
          sample: Array.isArray(loadedOntologies) ? loadedOntologies.slice(0, 6).map(o => ({ url: o.url, name: o.name, source: (o as any).source })) : loadedOntologies,
        });
      }
    }
  }, [registeredCount, loadedOntologies, configuredCount]);

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
  const { config, setLayoutSpacing } = useAppConfigStore();
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
    if (ontologyUrl.trim()) {
      try {
        await loadOntology(ontologyUrl);
        setOntologyUrl('');
        setIsLoadOntologyOpen(false);
        toast.success('Ontology loaded');
      } catch (error: any) {
        try {
          if (typeof fallback === "function") {
            try {
              fallback('console.error', { args: [(error && error.message) ? error.message : String(error)] }, { level: 'error', captureStack: true });
            } catch (_) { void 0; }
          }
        } catch (_) { void 0; }
        console.error('Failed to load ontology:', error);
        const msg = (error && error.message) ? error.message : String(error);
        // Keep the dialog open and show a helpful, actionable message to the user.
        // Many CORS/redirect problems return HTML or are blocked by the browser — offer the Paste RDF fallback.
        toast.error(`Failed to load ontology: ${msg}`, {
          description: 'If this looks like a cross-origin or redirect issue, try pasting the RDF into "Paste RDF" below or upload the file. You can also use a proxy-hosted URL if available.'
        });
        // keep the dialog open so the user can paste/upload RDF or try another URL
      }
    }
  };

  const handleAddNode = () => {
    // Prefer explicit IRI input if provided, otherwise fall back to selected class IRI.
    const iriToAdd = (newNodeIri && String(newNodeIri).trim()) ? String(newNodeIri).trim() : String(newNodeClass || '').trim();
    if (!iriToAdd) return;

    try {
      // Pass full payload (IRI + optional class/namespace) so the canvas can persist rdf:type + label
      onAddNode({
        iri: iriToAdd,
        classCandidate: newNodeClass ? String(newNodeClass) : undefined,
        namespace: newNodeNamespace ? String(newNodeNamespace) : undefined,
      } as any);
      // Clear inputs
      setNewNodeClass('');
      setNewNodeNamespace('');
      setNewNodeIri('');
      setIsAddNodeOpen(false);
      } catch (e) {
      try {
        if (typeof fallback === "function") {
          try {
            fallback('console.error', { args: [(e && e.message) ? e.message : String(e)] }, { level: 'error', captureStack: true });
          } catch (_) { void 0; }
        }
      } catch (_) { void 0; }
      console.error('Failed to add node:', e);
    }
  };

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
        nodeData={{}} // empty => create flow; editor will generate blank node if left empty on save
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
            } else {
              // fallback: use toolbar inputs if editor returned legacy shape
              const iriToAdd = (newNodeIri && String(newNodeIri).trim()) ? String(newNodeIri).trim() : String(newNodeClass || '').trim();
              if (iriToAdd) {
                onAddNode({
                  iri: iriToAdd,
                  classCandidate: newNodeClass ? String(newNodeClass) : undefined,
                  namespace: newNodeNamespace ? String(newNodeNamespace) : undefined,
                });
              }
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
                            try {
                              try {
                                if (typeof fallback === "function") {
                                  try {
                                    fallback('console.error', { args: [(err && err.message) ? err.message : String(err)] }, { level: 'error', captureStack: true });
                                  } catch (_) { void 0; }
                                }
                              } catch (_) { void 0; }
                              console.error('Failed to load RDF content as ontology:', err);
                            } catch (_) { void 0; }
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
                {
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                }
              }}
              onTouchEnd={() => {
                {
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                }
              }}
              onMouseUp={() => {
                {
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                }
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
                          try {
  try {
    if (typeof fallback === "function") {
      try {
        fallback('console.error', { args: [(error && error.message) ? error.message : String(error)] }, { level: 'error', captureStack: true });
      } catch (_) { void 0; }
    }
  } catch (_) { void 0; }
  console.error('Failed to load file:', error);
} catch (_) { void 0; }
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
                    try {
  try {
    if (typeof fallback === "function") {
      try {
        fallback('console.error', { args: [(error && error.message) ? error.message : String(error)] }, { level: 'error', captureStack: true });
      } catch (_) { void 0; }
    }
  } catch (_) { void 0; }
  console.error('Failed to load file:', error);
} catch (_) { void 0; }
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
                return (
                      <div key={`${ont.url}-${idx}`} className="flex items-center justify-between gap-2 p-2 rounded hover:bg-accent/5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" title={ont.url}>
                            {ont.name || ont.url.split('/').pop() || ont.url}
                          </div>
                          <div className="text-xs text-muted-foreground truncate" title={ont.url}>{ont.url}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isAuto ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs"
                              onClick={() => {
                                try {
                                  useAppConfigStore.getState().removeAdditionalOntology(ont.url);
                                  toast.success('Removed ontology from auto-load list');
                                } catch (e) {
                                  try {
  try {
    if (typeof fallback === "function") {
      try {
        fallback('console.warn', { args: [(e && e.message) ? e.message : String(e)] }, { level: 'warn' });
      } catch (_) { void 0; }
    }
  } catch (_) { void 0; }
  console.warn('Failed to remove additional ontology', e);
} catch (_) { void 0; }
                                  toast.error('Failed to update auto-load list');
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
                                  toast.success('Added ontology to auto-load list');
                                } catch (e) {
                                  try {
  try {
    if (typeof fallback === "function") {
      try {
        fallback('console.warn', { args: [(e && e.message) ? e.message : String(e)] }, { level: 'warn' });
      } catch (_) { void 0; }
    }
  } catch (_) { void 0; }
  console.warn('Failed to add additional ontology', e);
} catch (_) { void 0; }
                                  toast.error('Failed to update auto-load list');
                                }
                              }}
                            >
                              Add Auto
                            </Button>
                          )}
                        </div>
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
