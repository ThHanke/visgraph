import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { AutoComplete } from '../ui/AutoComplete';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useOntologyStore } from '../../stores/ontologyStore';

interface LiteralProperty {
  key: string;
  value: string;
  type?: string;
}

interface NodePropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeData: any;
  onSave: (properties: LiteralProperty[]) => void;
}

export const NodePropertyEditor = ({ 
  open, 
  onOpenChange, 
  nodeData, 
  onSave 
}: NodePropertyEditorProps) => {
  const [properties, setProperties] = useState<LiteralProperty[]>(
    nodeData?.literalProperties || []
  );
  const [newPropertyKey, setNewPropertyKey] = useState('');
  const [newPropertyValue, setNewPropertyValue] = useState('');

  const { availableClasses } = useOntologyStore();

  // Get annotation properties for the current class
  const getAnnotationProperties = () => {
    const currentClass = availableClasses.find(
      cls => cls.label === nodeData?.classType && cls.namespace === nodeData?.namespace
    );
    
    const commonAnnotations = [
      { value: 'rdfs:label', label: 'label', description: 'Human readable label' },
      { value: 'rdfs:comment', label: 'comment', description: 'Human readable description' },
      { value: 'dc:title', label: 'title', description: 'Dublin Core title' },
      { value: 'dc:description', label: 'description', description: 'Dublin Core description' },
      { value: 'foaf:name', label: 'name', description: 'FOAF name' },
      { value: 'skos:prefLabel', label: 'preferred label', description: 'SKOS preferred label' },
    ];

    if (currentClass?.properties) {
      const classProps = currentClass.properties.map(prop => ({
        value: prop,
        label: prop.split(':')[1] || prop,
        description: `Property from ${currentClass.namespace} ontology`
      }));
      return [...commonAnnotations, ...classProps];
    }

    return commonAnnotations;
  };

  const handleAddProperty = () => {
    if (newPropertyKey && newPropertyValue) {
      setProperties([...properties, {
        key: newPropertyKey,
        value: newPropertyValue,
        type: 'xsd:string'
      }]);
      setNewPropertyKey('');
      setNewPropertyValue('');
    }
  };

  const handleRemoveProperty = (index: number) => {
    setProperties(properties.filter((_, i) => i !== index));
  };

  const handleUpdateProperty = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...properties];
    updated[index] = { ...updated[index], [field]: value };
    setProperties(updated);
  };

  const handleSave = () => {
    onSave(properties);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Node Properties</DialogTitle>
          <DialogDescription>
            Add and edit literal properties for {nodeData?.individualName}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Node Info */}
          <div className="bg-muted/50 p-3 rounded-lg">
            <div className="text-sm font-medium">
              {nodeData?.namespace}:{nodeData?.classType}
            </div>
            <div className="text-xs text-muted-foreground">
              Individual: {nodeData?.individualName}
            </div>
          </div>

          {/* Existing Properties */}
          <div className="space-y-2">
            <Label>Current Properties</Label>
            {properties.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
                No properties defined
              </div>
            ) : (
              <div className="space-y-2">
                {properties.map((prop, index) => (
                  <div key={index} className="flex gap-2 items-center p-2 border rounded-lg">
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <Input
                        placeholder="Property"
                        value={prop.key}
                        onChange={(e) => handleUpdateProperty(index, 'key', e.target.value)}
                        className="text-xs"
                      />
                      <Input
                        placeholder="Value"
                        value={prop.value}
                        onChange={(e) => handleUpdateProperty(index, 'value', e.target.value)}
                        className="text-xs"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveProperty(index)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add New Property */}
          <div className="space-y-2">
            <Label>Add New Property</Label>
            <div className="space-y-2">
              <AutoComplete
                options={getAnnotationProperties()}
                value={newPropertyKey}
                onValueChange={setNewPropertyKey}
                placeholder="Select property..."
                emptyMessage="No annotation properties found"
              />
              <Input
                placeholder="Property value"
                value={newPropertyValue}
                onChange={(e) => setNewPropertyValue(e.target.value)}
              />
              <Button
                onClick={handleAddProperty}
                disabled={!newPropertyKey || !newPropertyValue}
                className="w-full"
                size="sm"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Property
              </Button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save Properties
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
