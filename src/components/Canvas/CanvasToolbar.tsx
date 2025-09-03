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
import { EntityAutocomplete } from '../ui/EntityAutocomplete';
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
  availableEntities: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onLoadFile, viewMode, onViewModeChange, onLayoutChange, currentLayout = 'force-directed', availableEntities }: CanvasToolbarProps) => {
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isLoadOntologyOpen, setIsLoadOntologyOpen] = useState(false);
  const [isLoadFileOpen, setIsLoadFileOpen] = useState(false);
  const [ontologyUrl, setOntologyUrl] = useState('');
  const [newNodeClass, setNewNodeClass] = useState('');
  const [newNodeNamespace, setNewNodeNamespace] = useState('');
  const [fileSource, setFileSource] = useState('');
  
  const { loadedOntologies, loadOntology, availableClasses, loadKnowledgeGraph } = useOntologyStore();

  const layoutOptions = [
    { type: 'force-directed', label: 'Force Directed', icon: Circle, description: 'Nodes repel each other and connected nodes attract' },
    { type: 'hierarchical', label: 'Hierarchical', icon: TreePine, description: 'Tree-like structure with clear parent-child relationships' },
    { type: 'circular', label: 'Circular', icon: Circle, description: 'Nodes arranged in a circular pattern' },
    { type: 'grid', label: 'Grid', icon: Grid, description: 'Nodes arranged in a regular grid pattern' },
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
      } catch (error) {
        console.error('Failed to load ontology:', error);
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
              <Label>Available Ontologies</Label>
              <div className="grid gap-2">
                {/* Show ontologies from loaded graph */}
                {Object.entries(loadedOntologies.reduce((acc, ont) => ({ ...acc, ...ont.namespaces }), {} as Record<string, string>)).map(([prefix, namespace]) => (
                  <Button
                    key={namespace}
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
                {commonOntologies.map((ont) => (
                  <Button
                    key={ont.url}
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
                  {loadedOntologies.map((ont) => (
                    <Badge key={ont.url} variant="secondary" className="text-xs">
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
                        console.error('Failed to load file:', error);
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
                    console.error('Failed to load file:', error);
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

      {/* Graph Stats */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-card/80 backdrop-blur-sm border border-border rounded-md shadow-glass">
        <Network className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          {loadedOntologies.length} ontologies loaded
        </span>
      </div>
    </div>
  );
};