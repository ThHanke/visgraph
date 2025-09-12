import { useState, useEffect } from 'react';
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
import { defaultURIShortener } from '../../utils/uriShortener';

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
  const [selectedProperty, setSelectedProperty] = useState(linkData?.data?.propertyUri || linkData?.data?.propertyType || linkData?.propertyType || linkData?.propertyUri || '');
  // displayValue prefers explicit selectedProperty state, but falls back to any predicate present on the linkData
  const displayValue = selectedProperty || linkData?.data?.propertyUri || linkData?.propertyUri || linkData?.data?.propertyType || linkData?.propertyType || '';
  
  const availableProperties = useOntologyStore((s) => s.availableProperties);
  const ontologiesVersion = useOntologyStore((s) => (s as any).ontologiesVersion);

  // Build autocomplete options from availableProperties (derived from RDF store).
  // availableProperties items are expected to have { uri, label, namespace, domain, range }
  const allObjectProperties = (availableProperties || []).map((prop) => ({
    value: prop.iri,
    label: prop.label || prop.iri,
    description: prop.namespace ? `From ${prop.namespace}` : undefined,
  }));

  // Keep selectedProperty synced when the dialog opens for a different link.
  // Support multiple shapes: linkData may store predicate at top-level (propertyUri/propertyType)
  // or nested under linkData.data (propertyUri/propertyType).
  useEffect(() => {
    const resolved =
      (linkData &&
        (linkData.data?.propertyUri ||
          linkData.data?.propertyType ||
          linkData.propertyUri ||
          linkData.propertyType)) ||
      "";
    setSelectedProperty(String(resolved || ""));
  }, [
    linkData?.id,
    linkData?.key,
    linkData?.propertyUri,
    linkData?.propertyType,
    linkData?.data?.propertyUri,
    linkData?.data?.propertyType,
  ]);

  // Diagnostic: log link payloads when the editor opens or the linkData changes.
  // This helps debug timing/shape mismatches that can cause the Type field to appear empty.
  useEffect(() => {
    try {
      if (!linkData) return;
      // eslint-disable-next-line no-console
      console.debug("[VG] LinkPropertyEditor.linkData", {
        open,
        linkData,
        resolved: {
          selectedProperty,
          displayValue,
        },
        sourceNode,
        targetNode,
      });
    } catch (_) {
      /* ignore logging failures */
    }
  }, [open, linkData, selectedProperty, displayValue, sourceNode, targetNode]);

  const handleSave = () => {
    const uriToSave = selectedProperty || displayValue;
    if (uriToSave) {
      const property = allObjectProperties.find(p => p.value === uriToSave);
      onSave(uriToSave, property?.label || uriToSave);
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
            {(() => {
              const sIri = String(sourceNode?.iri ?? sourceNode?.iri ?? '');
              const tIri = String(targetNode?.iri ?? targetNode?.iri ?? '');
              const sDisplay = sIri.startsWith('_:') ? sIri : defaultURIShortener.shortenURI(sIri).replace(/^(https?:\/\/)?(www\.)?/, '');
              const tDisplay = tIri.startsWith('_:') ? tIri : defaultURIShortener.shortenURI(tIri).replace(/^(https?:\/\/)?(www\.)?/, '');
              return `${sDisplay} → ${tDisplay}`;
            })()}
          </div>
          <div className="text-xs text-muted-foreground">
            {(sourceNode?.classType ?? sourceNode?.displayType ?? (Array.isArray(sourceNode?.rdfTypes) ? sourceNode.rdfTypes[0] : 'unknown'))} → {(targetNode?.classType ?? targetNode?.displayType ?? (Array.isArray(targetNode?.rdfTypes) ? targetNode.rdfTypes[0] : 'unknown'))}
          </div>
          </div>

          {/* Property Selection */}
          <div className="space-y-2">
            <Label>Type</Label>
            <AutoComplete
              options={allObjectProperties}
              value={displayValue}
              onValueChange={setSelectedProperty}
              placeholder="Type to search for object properties..."
              emptyMessage="No object properties found. Load an ontology first."
              className="w-full"
              autoOpen={open}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSave}
              disabled={!(selectedProperty || displayValue)}
            >
              Save Connection
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
