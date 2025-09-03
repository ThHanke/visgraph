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
} from 'lucide-react';
import { useOntologyStore } from '../../stores/ontologyStore';
import { EntityAutocomplete } from '../ui/EntityAutocomplete';

interface CanvasToolbarProps {
  onAddNode: (entityUri: string) => void;
  onToggleLegend: () => void;
  showLegend: boolean;
  onExport: (format: 'turtle' | 'owl-xml' | 'json-ld') => void;
  onLoadFile?: (file: File) => void;
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  availableEntities: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

export const CanvasToolbar = ({ onAddNode, onToggleLegend, showLegend, onExport, onLoadFile, viewMode, onViewModeChange, availableEntities }: CanvasToolbarProps) => {
  const [isAddNodeOpen, setIsAddNodeOpen] = useState(false);
  const [isLoadOntologyOpen, setIsLoadOntologyOpen] = useState(false);
  const [ontologyUrl, setOntologyUrl] = useState('');
  const [newNodeClass, setNewNodeClass] = useState('');
  const [newNodeNamespace, setNewNodeNamespace] = useState('');
  
  const { loadedOntologies, loadOntology, availableClasses } = useOntologyStore();

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
        <DialogContent className="sm:max-w-lg">
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
              <Label>Common Ontologies</Label>
              <div className="grid gap-2">
                {commonOntologies.map((ont) => (
                  <Button
                    key={ont.url}
                    variant="outline"
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
      <input
        type="file"
        accept=".ttl,.rdf,.owl,.n3"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onLoadFile) {
            onLoadFile(file);
          }
        }}
        className="hidden"
        id="file-input"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => document.getElementById('file-input')?.click()}
        className="shadow-glass backdrop-blur-sm"
      >
        <Upload className="h-4 w-4 mr-2" />
        Load File
      </Button>

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