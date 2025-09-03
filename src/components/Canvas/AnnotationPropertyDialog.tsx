import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { EntityAutocomplete, EntityOption } from '../ui/EntityAutocomplete';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

interface AnnotationProperty {
  propertyUri: string;
  value: string;
}

interface AnnotationPropertyDialogProps {
  nodeId: string;
  availableProperties: EntityOption[];
  currentProperties: AnnotationProperty[];
  onSave: (properties: AnnotationProperty[]) => void;
}

export const AnnotationPropertyDialog = ({
  nodeId,
  availableProperties,
  currentProperties,
  onSave
}: AnnotationPropertyDialogProps) => {
  const [open, setOpen] = useState(false);
  const [properties, setProperties] = useState<AnnotationProperty[]>(currentProperties);
  const [newPropertyUri, setNewPropertyUri] = useState('');
  const [newPropertyValue, setNewPropertyValue] = useState('');

  const handleAddProperty = () => {
    if (!newPropertyUri || !newPropertyValue) {
      toast.error('Please select a property and enter a value');
      return;
    }

    const newProperty: AnnotationProperty = {
      propertyUri: newPropertyUri,
      value: newPropertyValue
    };

    setProperties([...properties, newProperty]);
    setNewPropertyUri('');
    setNewPropertyValue('');
  };

  const handleRemoveProperty = (index: number) => {
    setProperties(properties.filter((_, i) => i !== index));
  };

  const handleSave = () => {
    onSave(properties);
    setOpen(false);
    toast.success('Annotation properties updated');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Annotations
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Annotation Properties</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Current Properties */}
          <div className="space-y-2">
            <Label>Current Annotation Properties</Label>
            {properties.length === 0 ? (
              <p className="text-sm text-muted-foreground">No annotation properties added</p>
            ) : (
              <div className="space-y-2">
                {properties.map((prop, index) => {
                  const entity = availableProperties.find(e => e.uri === prop.propertyUri);
                  return (
                    <div key={index} className="flex items-center justify-between p-2 border rounded">
                      <div>
                        <span className="font-medium">{entity?.label || prop.propertyUri}</span>
                        <span className="ml-2 text-sm text-muted-foreground">= {prop.value}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveProperty(index)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add New Property */}
          <div className="space-y-3 border-t pt-4">
            <Label>Add New Annotation Property</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="property-type">Property Type</Label>
                <EntityAutocomplete
                  entities={availableProperties}
                  value={newPropertyUri}
                  onValueChange={setNewPropertyUri}
                  placeholder="Select annotation property..."
                  filterByType="owl:AnnotationProperty"
                  className="w-full"
                />
              </div>
              <div>
                <Label htmlFor="property-value">Value</Label>
                <Input
                  id="property-value"
                  value={newPropertyValue}
                  onChange={(e) => setNewPropertyValue(e.target.value)}
                  placeholder="Enter property value..."
                />
              </div>
            </div>
            <Button onClick={handleAddProperty} disabled={!newPropertyUri || !newPropertyValue}>
              <Plus className="h-4 w-4 mr-2" />
              Add Property
            </Button>
          </div>

          {/* Save Button */}
          <div className="flex justify-end space-x-2 border-t pt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save Changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};