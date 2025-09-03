/**
 * @fileoverview Enhanced Node Property Editor
 * Allows editing of node type, IRI, and annotation properties with proper XSD type support
 * Handles multiple rdf:types correctly for A-box individuals
 */

import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { AutoComplete } from '../ui/AutoComplete';
import { EntityAutocomplete } from '../ui/EntityAutocomplete';
import { useOntologyStore } from '../../stores/ontologyStore';
import { X, Plus } from 'lucide-react';

/**
 * Represents a literal property with value and type
 */
interface LiteralProperty {
  key: string;
  value: string;
  type?: string;
}

/**
 * Props for the NodePropertyEditor component
 */
interface NodePropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeData: any;
  onSave: (updatedData: any) => void;
  availableEntities: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

/**
 * Node Property Editor Component
 * Allows editing of node properties including type, IRI, and annotation properties
 */
export const NodePropertyEditor = ({ 
  open, 
  onOpenChange, 
  nodeData, 
  onSave, 
  availableEntities 
}: NodePropertyEditorProps) => {
  const [nodeType, setNodeType] = useState('');
  const [nodeIri, setNodeIri] = useState('');
  const [properties, setProperties] = useState<LiteralProperty[]>([]);

  const { availableProperties } = useOntologyStore();

  // Memoize class entities to prevent constant re-renders
  const classEntities = useMemo(() => 
    availableEntities.filter(entity => entity.rdfType === 'owl:Class'),
    [availableEntities]
  );

  // Reset form when nodeData changes
  useEffect(() => {
    if (nodeData && open) {
      console.log('NodePropertyEditor: Resetting form with nodeData:', nodeData);
      
      // Set the class type (first non-owl:NamedIndividual type or fall back to iri)
      const types = nodeData.rdfTypes || [];
      const classType = types.find((type: string) => !type.includes('NamedIndividual')) || nodeData.iri;
      setNodeType(classType);
      
      setNodeIri(nodeData.iri || '');
      
      // Map annotation properties to our format
      const existingProps = nodeData.annotationProperties || [];
      const mappedProps = existingProps.map((prop: any) => ({
        key: prop.property || prop.key || '',
        value: prop.value || '',
        type: prop.type || 'xsd:string'
      }));
      
      setProperties(mappedProps);
    }
  }, [nodeData, open]);

  /**
   * Get available annotation properties for autocomplete
   */
  const getAnnotationProperties = () => {
    const annotationProps = availableProperties
      .filter(prop => 
        prop.uri.includes('AnnotationProperty') || 
        ['http://www.w3.org/2000/01/rdf-schema#label', 
         'http://www.w3.org/2000/01/rdf-schema#comment',
         'http://purl.org/dc/elements/1.1/title',
         'http://purl.org/dc/elements/1.1/description'
        ].includes(prop.uri)
      )
      .map(prop => ({
        value: prop.uri,
        label: prop.label || prop.uri.split(/[#\/]/).pop() || prop.uri
      }));

    // Add common annotation properties if not already present
    const commonProps = [
      { value: 'rdfs:label', label: 'rdfs:label' },
      { value: 'rdfs:comment', label: 'rdfs:comment' },
      { value: 'dc:title', label: 'dc:title' },
      { value: 'dc:description', label: 'dc:description' }
    ];

    const existingUris = new Set(annotationProps.map(p => p.value));
    const uniqueCommonProps = commonProps.filter(p => !existingUris.has(p.value));

    return [...annotationProps, ...uniqueCommonProps];
  };

  /**
   * Add a new property to the list
   */
  const handleAddProperty = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties([...properties, { key: '', value: '', type: 'xsd:string' }]);
  };

  /**
   * Remove a property by index
   */
  const handleRemoveProperty = (index: number) => {
    setProperties(properties.filter((_, i) => i !== index));
  };

  /**
   * Update a property field by index
   */
  const handleUpdateProperty = (index: number, field: keyof LiteralProperty, value: string) => {
    const updated = properties.map((prop, i) => 
      i === index ? { ...prop, [field]: value } : prop
    );
    setProperties(updated);
  };

  /**
   * Validate form - all properties must have keys
   */
  const isFormValid = () => {
    return properties.every(prop => prop.key.trim() !== '');
  };

  /**
   * Save changes and close dialog
   */
  const handleSave = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    
    // Validate form before saving
    if (!isFormValid()) {
      toast.error('Please provide a property name for all annotation properties or remove empty ones.');
      return;
    }
    
    // Convert URI back to label for classType if we have a matching entity
    const selectedEntity = classEntities.find(entity => entity.uri === nodeType);
    const classTypeLabel = selectedEntity ? selectedEntity.label : nodeType;
    
    // Build updated rdf:types array
    const updatedRdfTypes = [
      'owl:NamedIndividual', // Always include NamedIndividual for A-box entities
      nodeType // The selected class type
    ].filter(type => type && type.trim() !== '');

    const updatedData = {
      ...nodeData,
      classType: classTypeLabel,
      displayType: classTypeLabel, // Use the label for display
      nodeType: nodeType, // Keep URI for internal use
      rdfTypes: updatedRdfTypes, // Update the types array
      uri: nodeIri,
      iri: nodeIri,
      annotationProperties: properties.filter(prop => prop.key.trim()).map(prop => ({
        property: prop.key,
        key: prop.key,
        value: prop.value,
        type: prop.type || 'xsd:string'
      }))
    };

    console.log('NodePropertyEditor: Saving data:', updatedData);
    onSave(updatedData);
    onOpenChange(false);
  };

  if (!nodeData) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Node Properties</DialogTitle>
          <DialogDescription>
            Modify the node's class type, IRI, and annotation properties.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-6">
          {/* Node Type Selection */}
          <div className="space-y-2">
            <Label htmlFor="nodeType">Class Type *</Label>
            <EntityAutocomplete 
              entities={classEntities}
              value={nodeType}
              onValueChange={setNodeType}
              placeholder="Select a class type..."
              emptyMessage="No classes available. Load an ontology first."
              className="w-full"
            />
          </div>

          {/* Node IRI */}
          <div className="space-y-2">
            <Label htmlFor="nodeIri">IRI</Label>
            <Input
              id="nodeIri"
              value={nodeIri}
              onChange={(e) => setNodeIri(e.target.value)}
              placeholder="https://example.com/entity"
            />
          </div>

          {/* Annotation Properties */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Annotation Properties</Label>
              <Button 
                type="button" 
                variant="outline" 
                size="sm"
                onClick={(e) => handleAddProperty(e)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Property
              </Button>
            </div>

            <div className="space-y-3">
              {properties.map((property, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    <Label className="text-xs">Property *</Label>
                    <AutoComplete
                      options={getAnnotationProperties()}
                      value={property.key}
                      onValueChange={(value) => handleUpdateProperty(index, 'key', value)}
                      placeholder="Select property..."
                      className={!property.key.trim() ? "border-red-500" : ""}
                    />
                    {!property.key.trim() && (
                      <p className="text-xs text-red-500 mt-1">Property is required</p>
                    )}
                  </div>
                  
                  <div className="col-span-5">
                    <Label className="text-xs">Value</Label>
                    <Input
                      value={property.value}
                      onChange={(e) => handleUpdateProperty(index, 'value', e.target.value)}
                      placeholder="Property value..."
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <Label className="text-xs">Type</Label>
                    <Select 
                      value={property.type || 'xsd:string'} 
                      onValueChange={(value) => handleUpdateProperty(index, 'type', value)}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="xsd:string">xsd:string</SelectItem>
                        <SelectItem value="xsd:integer">xsd:integer</SelectItem>
                        <SelectItem value="xsd:decimal">xsd:decimal</SelectItem>
                        <SelectItem value="xsd:boolean">xsd:boolean</SelectItem>
                        <SelectItem value="xsd:date">xsd:date</SelectItem>
                        <SelectItem value="xsd:dateTime">xsd:dateTime</SelectItem>
                        <SelectItem value="xsd:anyURI">xsd:anyURI</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveProperty(index)}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              
              {properties.length === 0 && (
                <div className="text-center py-4 text-muted-foreground border-2 border-dashed border-border rounded-lg">
                  <p className="text-sm">No annotation properties</p>
                  <p className="text-xs">Click "Add Property" to add annotation properties</p>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" onClick={(e) => handleSave(e)} disabled={!isFormValid()}>
              Save Changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};