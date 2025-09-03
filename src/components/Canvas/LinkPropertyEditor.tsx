import { useState } from 'react';
import { Button } from '../ui/button';
import { AutoComplete } from '../ui/AutoComplete';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useOntologyStore } from '../../stores/ontologyStore';

interface LinkPropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkData: any;
  sourceNode: any;
  targetNode: any;
  onSave: (propertyType: string, label: string) => void;
}

export const LinkPropertyEditor = ({ 
  open, 
  onOpenChange, 
  linkData, 
  sourceNode,
  targetNode,
  onSave 
}: LinkPropertyEditorProps) => {
  const [selectedProperty, setSelectedProperty] = useState(linkData?.propertyType || '');
  
  const { loadedOntologies } = useOntologyStore();
  
  // Get all object properties for autocomplete
  const allObjectProperties = loadedOntologies.flatMap(ont => 
    ont.properties.filter(prop => prop.uri.includes('ObjectProperty')).map(prop => ({
      value: prop.uri,
      label: prop.label,
      description: `Object property from ${ont.name}`
    }))
  );

  const handleSave = () => {
    if (selectedProperty) {
      const property = allObjectProperties.find(p => p.value === selectedProperty);
      onSave(selectedProperty, property?.label || selectedProperty);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Connection Property</DialogTitle>
          <DialogDescription>
            Select the relationship type between these nodes
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Connection Info */}
          <div className="bg-muted/50 p-3 rounded-lg">
            <div className="text-sm font-medium">
              {sourceNode?.individualName} → {targetNode?.individualName}
            </div>
            <div className="text-xs text-muted-foreground">
              {sourceNode?.namespace}:{sourceNode?.classType} → {targetNode?.namespace}:{targetNode?.classType}
            </div>
          </div>

          {/* Property Selection */}
          <div className="space-y-2">
            <Label>Relationship Property</Label>
            <AutoComplete
              options={allObjectProperties}
              value={selectedProperty}
              onValueChange={setSelectedProperty}
              placeholder="Type to search for object properties..."
              emptyMessage="No object properties found. Load an ontology first."
              className="w-full"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSave}
              disabled={!selectedProperty}
            >
              Save Connection
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};