import { useState, useEffect, useMemo } from 'react';
import { DataFactory } from 'n3';
const { namedNode, quad } = DataFactory;
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
import { shortLocalName } from '../../utils/termUtils';

interface LinkPropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkData: any;
  sourceNode: any;
  targetNode: any;
  onSave: (propertyType: string, label: string) => void;
}

/**
 * Streamlined LinkPropertyEditor
 *
 * - Relies on fat-map (entityIndex / availableProperties) for autocomplete and labels.
 * - Uses sourceNode/targetNode props as authoritative endpoints.
 * - On save/delete performs write-only mutations to urn:vg:data (via rdfManager) and does NOT
 *   mutate ontologyStore.currentGraph directly. Canvas updates happen via the RDF manager's
 *   incremental mapping pipeline.
 * - Avoids any RDF store reads for display-time lookups.
 */
export const LinkPropertyEditor = ({
  open,
  onOpenChange,
  linkData,
  sourceNode,
  targetNode,
  onSave,
}: LinkPropertyEditorProps) => {
  const [selectedProperty, setSelectedProperty] = useState(
    linkData?.data?.propertyUri ||
      linkData?.data?.propertyType ||
      linkData?.propertyType ||
      linkData?.propertyUri ||
      ''
  );
  const displayValue =
    selectedProperty ||
    linkData?.data?.propertyUri ||
    linkData?.propertyUri ||
    linkData?.data?.propertyType ||
    linkData?.propertyType ||
    '';

  const availableProperties = useOntologyStore((s) => s.availableProperties);
  // Subscribe to the entityIndex object (stable reference) and derive suggestions via useMemo.
  // Returning a nested array directly from the selector can create a new array each render
  // and lead to the "getSnapshot should be cached" / infinite update warning from Zustand.
  const entityIndex = useOntologyStore((s) => (s as any).entityIndex);
  const entitySuggestions = useMemo(() => {
    return Array.isArray(entityIndex?.suggestions) ? entityIndex!.suggestions : [];
  }, [entityIndex]);

  const allObjectProperties = useMemo(() => {
    if (Array.isArray(entitySuggestions) && entitySuggestions.length > 0) {
      return entitySuggestions.map((ent: any) => ({
        value: ent.iri,
        label: ent.label || ent.iri,
        description: ent.display || undefined,
      }));
    }
    return (availableProperties || []).map((prop: any) => ({
      value: prop.iri,
      label: prop.label || prop.iri,
      description: prop.namespace ? `From ${prop.namespace}` : undefined,
    }));
  }, [entitySuggestions, availableProperties]);

  useEffect(() => {
    const resolved =
      (linkData &&
        (linkData.data?.propertyUri ||
          linkData.data?.propertyType ||
          linkData.propertyUri ||
          linkData.propertyType)) ||
      '';
    const resolvedStr = String(resolved || '');
    // Only update local state if the resolved value actually differs to avoid redundant setState loops.
    if (resolvedStr !== selectedProperty) {
      setSelectedProperty(resolvedStr);
    }
  }, [
    linkData?.id,
    linkData?.key,
    linkData?.propertyUri,
    linkData?.propertyType,
    linkData?.data?.propertyUri,
    linkData?.data?.propertyType,
    selectedProperty,
  ]);

  useEffect(() => {
    try {
      if (!linkData) return;
      console.debug('[VG] LinkPropertyEditor.linkData', {
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

  const handleSave = async () => {
    const uriToSave = selectedProperty || displayValue;
    if (!uriToSave) return;

    // Resolve manager + subject/object IRIs (endpoints must come from props)
    const mgrState = useOntologyStore.getState();
    const mgr =
      typeof (mgrState as any).getRdfManager === 'function'
        ? (mgrState as any).getRdfManager()
        : (mgrState as any).rdfManager;

    const subjIri = (sourceNode && ((sourceNode as any).iri || (sourceNode as any).key)) || '';
    const objIri = (targetNode && ((targetNode as any).iri || (targetNode as any).key)) || '';

    try {
      if (mgr && subjIri && objIri) {
        const predFull =
          mgr && typeof mgr.expandPrefix === 'function' ? String(mgr.expandPrefix(uriToSave)) : String(uriToSave);

        const subjEsc = `<${String(subjIri)}>`;
        const predEsc = `<${String(predFull)}>`;
        const objEsc = `<${String(objIri)}>`;
        const ttl = `${subjEsc} ${predEsc} ${objEsc} .\n`;

        try {
          if (typeof mgr.loadRDFIntoGraph === 'function') {
            await mgr.loadRDFIntoGraph(ttl, 'urn:vg:data');
          } else if (typeof mgr.loadRDF === 'function') {
            // Best-effort fallback
            await mgr.loadRDF(ttl);
          } else {
            // Direct store write as last resort (write-only)
            const store = mgr.getStore && mgr.getStore();
            if (store) {
              const subjTerm = namedNode(String(subjIri));
              const predTerm = namedNode(String(predFull));
              const objTerm = namedNode(String(objIri));
              const g = namedNode('urn:vg:data');
              const exists = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
              if (!exists || exists.length === 0) {
                try {
                  store.addQuad(quad(subjTerm, predTerm, objTerm, g));
                } catch (_) {
                  /* ignore */
                }
              }
            }
          }
        } catch (err) {
          try {
            console.error('[VG] LinkPropertyEditor.persistQuad.failed', err);
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) {
      /* ignore persistence errors */
    }

    // Notify parent; canvas mapping will pick up the change via RDF manager
    const property = allObjectProperties.find((p) => p.value === uriToSave);
    onSave(uriToSave, property?.label || uriToSave);
    onOpenChange(false);
  };

  const handleDelete = async () => {
    if (!confirm('Delete this connection? This will remove the corresponding triple from the data graph.')) return;

    try {
      const mgrState = useOntologyStore.getState();
      const mgr =
        typeof (mgrState as any).getRdfManager === 'function'
          ? (mgrState as any).getRdfManager()
          : (mgrState as any).rdfManager;
      if (!mgr) throw new Error('RDF manager unavailable');

      const store = mgr.getStore && mgr.getStore();
      if (!store) throw new Error('RDF store unavailable');

      const subjIri = (sourceNode && ((sourceNode as any).iri || (sourceNode as any).key)) || '';
      const objIri = (targetNode && ((targetNode as any).iri || (targetNode as any).key)) || '';
      const predicateRaw = selectedProperty || displayValue;
      const predFull = mgr && typeof mgr.expandPrefix === 'function' ? String(mgr.expandPrefix(predicateRaw)) : String(predicateRaw);

      // Remove matching quads from urn:vg:data (writes only)
      try {
        const g = namedNode('urn:vg:data');
        const subjTerm = namedNode(String(subjIri));
        const predTerm = namedNode(String(predFull));
        const objTerm = namedNode(String(objIri));
        const quads = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
        for (const q of quads) {
          try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
        }
      } catch (_) {
        // fallback: remove across graphs
        try {
          const subjTerm = namedNode(String(subjIri));
          const predTerm = namedNode(String(predFull));
          const objTerm = namedNode(String(objIri));
          const quads = store.getQuads(subjTerm, predTerm, objTerm, null) || [];
          for (const q of quads) {
            try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
          }
        } catch (_) { /* ignore */ }
      }

      // Notify RDF manager subscribers (best-effort)
      try {
        if ((mgr as any).notifyChange) {
          try { (mgr as any).notifyChange(); } catch (_) { /* ignore */ }
        } else if (typeof mgr.notifyChange === 'function') {
          try { (mgr as any).notifyChange(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }

      onOpenChange(false);
    } catch (err) {
      try {
        console.error('Failed to delete edge', err);
      } catch (_) { /* ignore */ }
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{linkData?.operation === 'create' ? 'Create Connection' : 'Edit Connection Property'}</DialogTitle>
          <DialogDescription>Select the relationship type between these nodes</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-muted/50 p-3 rounded-lg">
            <div className="text-sm font-medium">
              {(() => {
                // Prefer the canvas-provided nodes for display. Avoid any RDF store lookups.
                const sIri = String(sourceNode?.iri ?? sourceNode?.key ?? '');
                const tIri = String(targetNode?.iri ?? targetNode?.key ?? '');
                const format = (iri: string) => {
                  if (!iri) return '';
                  if (iri.startsWith('_:')) return iri;
                  return shortLocalName(iri).replace(/^(https?:\/\/)?(www\.)?/, '');
                };
                const sDisplay = format(sIri);
                const tDisplay = format(tIri);
                return `${sDisplay} → ${tDisplay}`;
              })()}
            </div>
            <div className="text-xs text-muted-foreground">
              {(sourceNode?.classType ?? sourceNode?.displayType ?? (Array.isArray(sourceNode?.rdfTypes) ? sourceNode.rdfTypes[0] : 'unknown'))} → {(targetNode?.classType ?? targetNode?.displayType ?? (Array.isArray(targetNode?.rdfTypes) ? targetNode.rdfTypes[0] : 'unknown'))}
            </div>
          </div>

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

          <div className="flex justify-end gap-2">
            <Button type="button" variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!(selectedProperty || displayValue)}>
              {linkData?.operation === 'create' ? 'Create Connection' : 'Save Connection'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
