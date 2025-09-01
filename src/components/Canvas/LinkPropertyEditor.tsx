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
  
  const { availableProperties, getCompatibleProperties } = useOntologyStore();

  const getAvailableProperties = () => {
    if (!sourceNode || !targetNode) return [];

    const sourceClass = `${sourceNode.namespace}:${sourceNode.classType}`;
    const targetClass = `${targetNode.namespace}:${targetNode.classType}`;
    
    // Get properties that are compatible with source and target classes
    const compatibleProps = getCompatibleProperties(sourceClass, targetClass);
    
    // If no compatible properties, show all available properties
    const propsToShow = compatibleProps.length > 0 ? compatibleProps : availableProperties;
    
    return propsToShow.map(prop => ({
      value: prop.uri,
      label: prop.label,
      description: `Domain: ${prop.domain.join(', ') || 'Any'} | Range: ${prop.range.join(', ') || 'Any'}`
    }));
  };

  const handleSave = () => {
    if (selectedProperty) {
      const property = availableProperties.find(p => p.uri === selectedProperty);
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
              options={getAvailableProperties()}
              value={selectedProperty}
              onValueChange={setSelectedProperty}
              placeholder="Select property type..."
              emptyMessage="No compatible properties found. Check domain/range restrictions."
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!selectedProperty}>
              Save Connection
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};