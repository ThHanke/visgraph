/**
 * @fileoverview Enhanced Node Property Editor
 * Allows editing of node type, IRI, and annotation properties with proper XSD type support
 */

import { useState, useEffect } from 'react';
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
 * Enhanced node property editor that allows changing type and editing annotation properties
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
  
  const { availableClasses } = useOntologyStore();

  // Initialize form data when dialog opens
  useEffect(() => {
    if (open && nodeData) {
      setNodeType(nodeData.classType || '');
      setNodeIri(nodeData.uri || nodeData.iri || '');
      
      // Convert existing annotation properties to the form format
      const existingProps: LiteralProperty[] = [];
      if (nodeData.annotationProperties) {
        nodeData.annotationProperties.forEach((prop: any) => {
          existingProps.push({
            key: prop.property || prop.key,
            value: prop.value,
            type: prop.type || 'xsd:string'
          });
        });
      }
      setProperties(existingProps);
    }
  }, [open, nodeData]);

  /**
   * Add a new property row
   */
  const handleAddProperty = () => {
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
   * Save changes and close dialog
   */
  const handleSave = () => {
    const updatedNodeData = {
      ...nodeData,
      classType: nodeType,
      uri: nodeIri,
      iri: nodeIri,
      annotationProperties: properties.map(prop => ({
        property: prop.key,
        key: prop.key,
        value: prop.value,
        type: prop.type
      }))
    };

    onSave(updatedNodeData);
    onOpenChange(false);
  };

  /**
   * Get common annotation properties for autocomplete
   */
  const getAnnotationProperties = () => {
    const commonProps = [
      'rdfs:label',
      'rdfs:comment',
      'dc:description',
      'dc:title',
      'dc:creator',
      'dc:date',
      'dc:identifier',
      'owl:sameAs',
      'skos:prefLabel',
      'skos:altLabel',
      'skos:definition'
    ];

    // Add class-specific properties from loaded ontologies
    const classSpecific = availableClasses
      .filter(cls => cls.label === nodeType)
      .flatMap(cls => cls.properties);

    return [...commonProps, ...classSpecific].map(prop => ({
      value: prop,
      label: prop
    }));
  };

  /**
   * Get available XSD data types
   */
  const getXSDTypes = () => [
    'xsd:string',
    'xsd:boolean',
    'xsd:integer',
    'xsd:decimal',
    'xsd:double',
    'xsd:float',
    'xsd:date',
    'xsd:dateTime',
    'xsd:time',
    'xsd:anyURI'
  ];

  const classEntities = availableEntities.filter(e => e.rdfType === 'owl:Class');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Node Properties</DialogTitle>
          <DialogDescription>
            Change the type, IRI, and annotation properties of this node.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Node Type Selection */}
          <div className="space-y-2">
            <Label htmlFor="nodeType">Node Type</Label>
            <EntityAutocomplete 
              entities={classEntities}
              value={nodeType}
              onValueChange={setNodeType}
              placeholder="Type to search for classes..."
              emptyMessage="No OWL classes found. Load an ontology first."
              className="w-full"
            />
          </div>

          {/* Node IRI */}
          <div className="space-y-2">
            <Label htmlFor="nodeIri">Node IRI</Label>
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
                onClick={handleAddProperty}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Property
              </Button>
            </div>

            <div className="space-y-3">
              {properties.map((property, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    <Label className="text-xs">Property</Label>
                    <AutoComplete
                      options={getAnnotationProperties()}
                      value={property.key}
                      onValueChange={(value) => handleUpdateProperty(index, 'key', value)}
                      placeholder="Select property..."
                    />
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
                      value={property.type} 
                      onValueChange={(value) => handleUpdateProperty(index, 'type', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {getXSDTypes().map(type => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveProperty(index)}
                      className="h-9 px-2"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              
              {properties.length === 0 && (
                <div className="text-center py-4 text-muted-foreground border-2 border-dashed rounded-lg">
                  <p className="text-sm">No annotation properties</p>
                  <p className="text-xs">Click "Add Property" to add annotation properties</p>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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