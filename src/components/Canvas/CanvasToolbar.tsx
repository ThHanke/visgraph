import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { AutoComplete } from '../ui/AutoComplete';
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
  Sparkles,
} from 'lucide-react';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { EntityAutocomplete } from '../ui/EntityAutocomplete';
import { fallback } from '../../utils/startupDebug';
import { LayoutManager } from './LayoutManager';
import { WELL_KNOWN_PREFIXES } from '../../utils/wellKnownOntologies';
import { ConfigurationPanel } from './ConfigurationPanel';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';

interface CanvasToolbarProps {
  onAddNode: (entityUri: string) => void;
  onToggleLegend: () => void;
  showLegend: boolean;
  onExport: (format: 'turtle' | 'owl-xml' | 'json-ld') => void;
  onLoadFile?: (file: File) => void;
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  onLayoutChange?: (layoutType: string, force?: boolean, options?: { nodeSpacing?: number }) => void;
  currentLayout?: string;
  // layoutEnabled: whether programmatic/layout application is enabled (toggle supplied by parent)
  layoutEnabled?: boolean;
  // callback when the layoutEnabled toggle changes
  onToggleLayoutEnabled?: (enabled: boolean) => void;
  // New: allow CanvasToolbar to display programmatic layout application (control removed)
  availableEntities: Array<{
   iri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onLoadFile, viewMode, onViewModeChange, onLayoutChange, currentLayout = 'horizontal', layoutEnabled = false, onToggleLayoutEnabled, availableEntities }: CanvasToolbarProps) => {
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isLoadOntologyOpen, setIsLoadOntologyOpen] = useState(false);
  const [isLoadFileOpen, setIsLoadFileOpen] = useState(false);
  const [ontologyUrl, setOntologyUrl] = useState('');
  const [newNodeClass, setNewNodeClass] = useState('');
  const [newNodeNamespace, setNewNodeNamespace] = useState('');
  // New: allow entering an explicit IRI (or prefixed form) when adding a node.
  const [newNodeIri, setNewNodeIri] = useState('');
  const [fileSource, setFileSource] = useState('');
  const [rdfBody, setRdfBody] = useState('');
  
  const { loadedOntologies, loadOntology, availableClasses, loadKnowledgeGraph, loadOntologyFromRDF, getRdfManager } = useOntologyStore();

  // Build a merged list of namespaces: prefer namespaces discovered in the RDF manager
  // but include namespaces from loaded ontology metadata as a fallback.
  const namespacesFromLoaded = loadedOntologies.reduce((acc, ont) => ({ ...acc, ...ont.namespaces }), {} as Record<string, string>);
  const rdfManagerNamespaces = (getRdfManager && typeof getRdfManager === 'function') ? (getRdfManager()?.getNamespaces?.() || {}) : {};
  const mergedNamespaces = { ...namespacesFromLoaded, ...rdfManagerNamespaces };

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
        ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load ontology:', error);
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
      onAddNode(iriToAdd);
      // Clear inputs
      setNewNodeClass('');
      setNewNodeNamespace('');
      setNewNodeIri('');
      setIsAddNodeOpen(false);
    } catch (e) {
      ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to add node:', e);
    }
  };

  // Build unified list of options by joining RDF manager namespaces with well-known ontologies (deduped by URL).
  // Normalize URLs for matching so http/https and trailing slash differences don't create duplicates.
  const normalizeNamespaceKey = (u?: string) => {
    if (!u) return '';
    try {
      // Remove protocol and any trailing slashes or hash characters for a stable comparison key.
      // This helps collapse variants like "http://.../", "https://.../", and "...#" to the same key.
      return String(u).replace(/^https?:\/\//, '').replace(new RegExp('[/#]+$'), '');
    } catch {
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
      {/* Add Node Dialog */}
      <Dialog open={isAddNodeOpen} onOpenChange={setIsAddNodeOpen}>
        <DialogTrigger asChild>
          <Button variant="default" size="sm" className="shadow-glass backdrop-blur-sm">
            <Plus className="h-4 w-4 mr-2" />
            Add Node
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Node</DialogTitle>
            <DialogDescription>
              Create a new individual of an ontology class.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="nodeIri">Entity IRI (required) or prefixed form</Label>
              <Input
                id="nodeIri"
                placeholder="https://example.org/resource or ex:LocalName"
                value={newNodeIri}
                onChange={(e) => setNewNodeIri(e.target.value)}
                className="w-full"
              />
              <div className="text-xs text-muted-foreground">
                You may enter a full IRI or a registered prefix form (e.g. ex:Local). If omitted, the selected class IRI will be used.
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="classType">Class Type (optional)</Label>
              <EntityAutocomplete 
                entities={availableEntities.filter(e => e.rdfType === 'owl:Class')}
                value={newNodeClass}
                onValueChange={setNewNodeClass}
                placeholder="Type to search for classes..."
                emptyMessage="No OWL classes found. Load an ontology first."
                className="w-full"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsAddNodeOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleAddNode} disabled={!newNodeIri && !newNodeClass}>
                Add Node
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Load Ontology Dialog */}
      <Dialog open={isLoadOntologyOpen} onOpenChange={setIsLoadOntologyOpen}>
        <DialogTrigger asChild>
          <Button variant="secondary" size="sm" className="shadow-glass backdrop-blur-sm">
            <Upload className="h-4 w-4 mr-2" />
            Load Ontology
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg max-h-[90vh] max-w-[min(90vw,32rem)] overflow-y-auto">
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
                  className="w-full min-h-[6rem] p-2 bg-input border border-border rounded"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (!rdfBody.trim()) return;
                      try {
                        await loadOntologyFromRDF?.(rdfBody, undefined, true);
                        setRdfBody('');
                        setIsLoadOntologyOpen(false);
                        toast.success('RDF content applied as ontology (prefixes registered)');
                      } catch (err) {
                        ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load RDF content as ontology:', err);
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

            {loadedOntologies.length > 0 && (
              <div className="space-y-2">
                <Label>Loaded Ontologies</Label>
                <div className="flex flex-wrap gap-1">
                  {loadedOntologies.map((ont, index) => (
                    <Badge key={`${ont.url}-${index}`} variant="secondary" className="text-xs">
                      {ont.name || new URL(ont.url).hostname}
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
          className="rounded-r-none"
        >
          A-Box
        </Button>
        <Button
          variant={viewMode === 'tbox' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('tbox')}
          className="rounded-l-none"
        >
          T-Box
        </Button>
      </div>

      {/* Toggle Legend */}
      <Button 
        variant="secondary" 
        size="sm" 
        onClick={onToggleLegend}
        className="shadow-glass backdrop-blur-sm bg-accent hover:bg-accent-hover"
      >
        {showLegend ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
        Legend
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-card/80 border border-border shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40"
            aria-expanded="false"
          >
            <Layout className="h-4 w-4" />
            <span className="sr-only">Layout</span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" sideOffset={6} className="w-80 rounded-lg border bg-popover p-4 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">Layouts</div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                // no-op: PopoverContent will close when trigger toggles or on outside click
              }}
            >
              Close
            </button>
          </div>

          <div className="space-y-2">
            {layoutOptions.map((layout) => {
              const IconComponent = getLayoutIcon(layout.icon as any);
              return (
                <button
                  key={layout.type}
                  onClick={() => {
                    try {
                      onLayoutChange?.(layout.type, true, { nodeSpacing: config.layoutSpacing });
                    } catch (_) { /* ignore */ }
                  }}
                  className="w-full text-left flex items-start gap-3 p-2 rounded hover:bg-accent"
                >
                  <IconComponent className="h-5 w-5 mt-0.5 flex-shrink-0" />
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
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                } catch (_) { /* ignore */ }
              }}
              onTouchEnd={() => {
                try {
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                } catch (_) { /* ignore */ }
              }}
              onMouseUp={() => {
                try {
                  setTimeout(() => {
                    try {
                      const v = tempLayoutSpacing;
                      setLayoutSpacing(v);
                      onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: v });
                      toast.success(`Saved spacing: ${v}px`);
                    } catch (_) { /* ignore */ }
                  }, 0);
                } catch (_) { /* ignore */ }
              }}
            >
              <div className="text-xs text-muted-foreground">Spacing</div>
              <div className="w-56">
                <Slider
                  value={[tempLayoutSpacing]}
                  onValueChange={([v]) => setTempLayoutSpacing(v)}
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
                className={`px-3 py-1 rounded text-sm ${currentLayout ? 'bg-muted' : 'bg-muted'}`}
                onClick={() => {
                  try {
                    onLayoutChange?.(currentLayout || 'horizontal', true);
                  } catch (_) { /* ignore */ }
                }}
              >
                Apply
              </button>

              <button
                type="button"
                className="px-3 py-1 rounded text-sm bg-muted"
                onClick={() => {
                  try {
                    useAppConfigStore.getState().setLayoutSpacing(120);
                    onLayoutChange?.(currentLayout || 'horizontal', true, { nodeSpacing: 120 });
                    toast.success('Reset spacing to 120px');
                  } catch (_) { /* ignore */ }
                }}
              >
                Reset
              </button>

              {/* Auto toggle */}
              <button
                type="button"
                onClick={() => {
                  try {
                    const enabled = !layoutEnabled;
                    if (typeof onToggleLayoutEnabled === 'function') {
                      try {
                        onToggleLayoutEnabled(enabled);
                      } catch (_) { /* ignore */ }
                    }
                    toast.success(enabled ? 'Layout toggled ON' : 'Layout toggled OFF');
                  } catch (_) {
                    /* ignore */
                  }
                }}
                className={`px-3 py-1 rounded text-sm border ${ layoutEnabled ? 'bg-primary text-white' : 'bg-card' }`}
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
            className="shadow-glass backdrop-blur-sm"
          >
            <Upload className="h-4 w-4 mr-2" />
            Load File
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
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
                        const mockFile = { 
                          url: fileSource.trim(),
                          type: 'url'
                        };
                        await onLoadFile(mockFile as any);
                        setFileSource('');
                        setIsLoadFileOpen(false);
                      } catch (error) {
                        ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load file:', error);
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
                    await onLoadFile(file);
                    setIsLoadFileOpen(false);
                  } catch (error) {
                    ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to load file:', error);
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

      {/* Export Options */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="shadow-glass backdrop-blur-sm">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
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
            <span className="text-sm text-muted-foreground">{loadedOntologies.length} ontologies</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-h-64 overflow-y-auto z-50">
          <div className="p-2">
            <div className="text-xs text-muted-foreground mb-2">Loaded ontologies and auto-load status</div>
            {loadedOntologies.length === 0 ? (
              <div className="text-xs text-muted-foreground">No ontologies loaded</div>
            ) : (
              loadedOntologies.map((ont, idx) => {
                const isAuto = (useAppConfigStore.getState().config.additionalOntologies || []).includes(ont.url);
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
                              ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to remove additional ontology', e);
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
                              ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to add additional ontology', e);
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

      <div className="ml-auto flex items-center">
        <ConfigurationPanel triggerVariant="inline-icon" />
      </div>
    </div>
  );
};
