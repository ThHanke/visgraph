import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
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
  GitBranch,
  TreePine,
  Circle,
  Grid3X3,
  Layers,
  TreeDeciduous
} from 'lucide-react';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { EntityAutocomplete } from '../ui/EntityAutocomplete';
import { fallback } from '../../utils/startupDebug';
import { ConfigurationPanel } from './ConfigurationPanel';
import { toast } from 'sonner';

interface CanvasToolbarProps {
  onAddNode: (entityUri: string) => void;
  onToggleLegend: () => void;
  showLegend: boolean;
  onExport: (format: 'turtle' | 'owl-xml' | 'json-ld') => void;
  onLoadFile?: (file: File) => void;
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  onLayoutChange?: (layoutType: string) => void;
  currentLayout?: string;
  // New: allow CanvasToolbar to display and toggle programmatic layout application
  layoutEnabled?: boolean;
  onToggleLayoutEnable?: (enabled: boolean) => void;
  availableEntities: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onLoadFile, viewMode, onViewModeChange, onLayoutChange, currentLayout = 'force-directed', availableEntities, layoutEnabled = false, onToggleLayoutEnable }: CanvasToolbarProps) => {
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isLoadOntologyOpen, setIsLoadOntologyOpen] = useState(false);
  const [isLoadFileOpen, setIsLoadFileOpen] = useState(false);
  const [ontologyUrl, setOntologyUrl] = useState('');
  const [newNodeClass, setNewNodeClass] = useState('');
  const [newNodeNamespace, setNewNodeNamespace] = useState('');
  const [fileSource, setFileSource] = useState('');
  const [rdfBody, setRdfBody] = useState('');
  
  const { loadedOntologies, loadOntology, availableClasses, loadKnowledgeGraph, loadOntologyFromRDF, getRdfManager } = useOntologyStore();

  // Build a merged list of namespaces: prefer namespaces discovered in the RDF manager
  // but include namespaces from loaded ontology metadata as a fallback.
  const namespacesFromLoaded = loadedOntologies.reduce((acc, ont) => ({ ...acc, ...ont.namespaces }), {} as Record<string, string>);
  const rdfManagerNamespaces = (getRdfManager && typeof getRdfManager === 'function') ? (getRdfManager()?.getNamespaces?.() || {}) : {};
  const mergedNamespaces = { ...namespacesFromLoaded, ...rdfManagerNamespaces };

  const layoutOptions = [
    { type: 'force-directed', label: 'Force Directed', icon: Circle, description: 'Nodes repel each other and connected nodes attract' },
    { type: 'hierarchical', label: 'Hierarchical', icon: TreePine, description: 'Tree-like structure with clear parent-child relationships' },
    { type: 'circular', label: 'Circular', icon: Circle, description: 'Nodes arranged in a circular pattern' },
    { type: 'grid', label: 'Grid', icon: Grid3X3, description: 'Nodes arranged in a regular grid pattern' },
    { type: 'layered-digraph', label: 'Layered Graph', icon: Layers, description: 'Directed graph with nodes in distinct layers' },
    { type: 'tree', label: 'Tree', icon: TreeDeciduous, description: 'Traditional tree layout with root at top' }
  ];

  const handleLayoutChange = (layoutType: string) => {
    onLayoutChange?.(layoutType);
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
    if (newNodeClass) {
      onAddNode(newNodeClass);
      setNewNodeClass('');
      setNewNodeNamespace('');
      setIsAddNodeOpen(false);
    }
  };

  const commonOntologies = [
    { url: 'http://xmlns.com/foaf/0.1/', name: 'FOAF (Friend of a Friend)' },
    { url: 'https://www.w3.org/TR/vocab-org/', name: 'Organization Ontology' },
    { url: 'http://purl.org/dc/elements/1.1/', name: 'Dublin Core' },
    { url: 'http://www.w3.org/2004/02/skos/core#', name: 'SKOS Core' },
  ];

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
              <Label htmlFor="classType">Class Type</Label>
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
              <Button onClick={handleAddNode} disabled={!newNodeClass}>
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
                {/* Show merged namespaces from RDF manager and loaded ontologies */}
                {Object.entries(mergedNamespaces || {}).map(([prefix, namespace]) => (
                  <Button
                    key={`${prefix}-${namespace}`}
                    variant={ontologyUrl === namespace ? "default" : "outline"}
                    size="sm"
                    className="justify-start text-left h-auto py-2"
                    onClick={() => setOntologyUrl(namespace)}
                  >
                    <div>
                      <div className="font-medium">{prefix}</div>
                      <div className="text-xs text-muted-foreground">{namespace}</div>
                    </div>
                  </Button>
                ))}

                {/* Common ontologies */}
                {commonOntologies.map((ont, index) => (
                  <Button
                    key={`${ont.url}-${index}`}
                    variant={ontologyUrl === ont.url ? "default" : "outline"}
                    size="sm"
                    className="justify-start text-left h-auto py-2"
                    onClick={() => setOntologyUrl(ont.url)}
                  >
                    <div>
                      <div className="font-medium">{ont.name}</div>
                      <div className="text-xs text-muted-foreground">{ont.url}</div>
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

      {/* Layout Selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="shadow-glass backdrop-blur-sm">
            <Layout className="h-4 w-4 mr-2" />
            Layout
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 bg-popover border z-50">
          {layoutOptions.map((layout) => {
            const IconComponent = layout.icon;
            return (
              <DropdownMenuItem
                key={layout.type}
                onClick={() => handleLayoutChange(layout.type)}
                className="flex items-start gap-3 p-3 cursor-pointer hover:bg-accent"
              >
                <IconComponent className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{layout.label}</span>
                    {currentLayout === layout.type && (
                      <Badge variant="secondary" className="text-xs">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {layout.description}
                  </p>
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Programmatic layout toggle (guards automatic application) */}
      <Button
        variant={layoutEnabled ? 'default' : 'outline'}
        size="sm"
        onClick={() => onToggleLayoutEnable?.(!layoutEnabled)}
        className="shadow-glass backdrop-blur-sm"
        title={layoutEnabled ? 'Disable programmatic layout' : 'Enable programmatic layout'}
      >
        <Layout className="h-4 w-4 mr-2" />
        {layoutEnabled ? 'Layout: On' : 'Layout: Off'}
      </Button>

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

      {/* Configuration Panel */}
      <ConfigurationPanel />
    </div>
  );
};
