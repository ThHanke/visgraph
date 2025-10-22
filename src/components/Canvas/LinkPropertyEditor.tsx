import { useState, useEffect, useMemo } from 'react';
import { DataFactory } from 'n3';
const { namedNode, quad } = DataFactory;
import { Button } from '../ui/button';
import EntityAutoComplete from '../ui/EntityAutoComplete';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { useOntologyStore } from '../../stores/ontologyStore';
import { toPrefixed } from '../../utils/termUtils';
import { rdfManager as fallbackRdfManager } from '../../utils/rdfManager';

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

  // Read suggestions directly from the store each render (no snapshots).
  const availableProperties = useOntologyStore((s) => s.availableProperties);
  const entityIndex = useOntologyStore((s) => (s as any).entityIndex);
  const entitySuggestions = Array.isArray(entityIndex?.suggestions) ? entityIndex.suggestions : [];
  const computedAllObjectProperties = Array.isArray(entitySuggestions) && entitySuggestions.length > 0
    ? entitySuggestions.map((ent: any) => ({
        iri: String(ent.iri || ent || ''),
        label: ent.label || undefined,
        description: ent.display || ent.description,
        rdfType: ent.rdfType,
        prefixed: ent.prefixed,
        __native: ent,
      }))
    : (Array.isArray(availableProperties) ? availableProperties.map((prop: any) => ({
        iri: String(prop.iri || prop || ''),
        label: prop.label || undefined,
        description: prop.description || prop.namespace || undefined,
        rdfType: prop.rdfType || prop.type,
        prefixed: prop.prefixed,
        __native: prop,
      })) : []);

  // Use the memoized computedAllObjectProperties directly as the AutoComplete options.
  // This avoids keeping a duplicate state copy; computedAllObjectProperties is memoized and stable.

  // No React Flow selection fallback in this streamlined editor; source/target must be provided via props.

  useEffect(() => {
    const candidate = linkData || {};
    const resolved =
      (candidate &&
        (candidate.data?.propertyUri ||
          candidate.data?.propertyType ||
          candidate.propertyUri ||
          candidate.propertyType)) ||
      '';
    const resolvedStr = String(resolved || '');
    // Only update local state if the resolved value actually differs to avoid redundant setState loops.
    if (resolvedStr !== selectedProperty) {
      setSelectedProperty(resolvedStr);
    }
  }, [
    // Re-run when the dialog is opened or when linkData identity/fields change.
    open,
    linkData?.id,
    linkData?.key,
    linkData?.propertyUri,
    linkData?.propertyType,
    linkData?.data?.propertyUri,
    linkData?.data?.propertyType,
  ]);

  // If the editor opens and there is no selectedProperty yet, but available properties exist,
  // prefill the selector with the first available property so UI tests and users immediately
  // see a sensible default. Use the memoized computedAllObjectProperties directly.
  useEffect(() => {
    if ((!selectedProperty || String(selectedProperty).trim() === "") && Array.isArray(computedAllObjectProperties) && computedAllObjectProperties.length > 0) {
      const first = computedAllObjectProperties[0];
      if (first && first.iri) {
        setSelectedProperty(String(first.iri));
      }
    }
  }, [computedAllObjectProperties, selectedProperty, open]);

  useEffect(() => {
    {
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
    }
  }, [open, linkData, selectedProperty, displayValue, sourceNode, targetNode]);

  const handleSave = async () => {
    const uriToSave = selectedProperty || displayValue;
    if (!uriToSave) return;

    // Resolve manager + subject/object IRIs (endpoints must come from props)
    const mgrState = useOntologyStore.getState();
    let mgr: any = undefined;
    if (typeof (mgrState as any).getRdfManager === "function") {
      try {
        mgr = (mgrState as any).getRdfManager();
      } catch (_) {
        mgr = undefined;
      }
    }
    if (!mgr) {
      mgr = (mgrState as any).rdfManager || fallbackRdfManager;
    }

    const subjIri = (sourceNode && ((sourceNode as any).iri));
    const objIri = (targetNode && ((targetNode as any).iri));
    const oldPredIRI = linkData.data?.propertyUri;
    if (mgr && subjIri && objIri) {
      const predFull =
        mgr && typeof mgr.expandPrefix === 'function' ? String(mgr.expandPrefix(uriToSave)) : String(uriToSave);

      const g = 'urn:vg:data';

      // Creation vs update:
      // - If there is no existing predicate (create), only add the new triple.
      // - If there is an existing predicate and it differs, remove exactly that triple and add the new one.
      // Do NOT perform any removals when creating a link (oldPredIRI is absent) to avoid removing unrelated triples.
      if (!oldPredIRI) {
        {
          if (typeof mgr.addTriple === "function") {
            mgr.addTriple(subjIri, predFull, objIri, g);
          }
        }
      } else if (String(oldPredIRI) !== String(predFull)) {
        {
          if (typeof mgr.removeTriple === "function") {
            mgr.removeTriple(subjIri, oldPredIRI, objIri, g);
          }
        }
        {
          if (typeof mgr.addTriple === "function") {
            mgr.addTriple(subjIri, predFull, objIri, g);
          }
        }
      }
    }
    // Notify parent; canvas mapping will pick up the change via RDF manager
    const property = (computedAllObjectProperties || []).find((p) => String(p.iri || '') === String(uriToSave));
    onSave(uriToSave, property?.label || uriToSave);
    onOpenChange(false);
  };

  const handleDelete = async () => {
    if (!confirm('Delete this connection? This will remove the corresponding triple from the data graph.')) return;

    // Mirror handleSave's robust manager resolution: prefer store-provided manager, fall back to a global rdfManager helper.
    const mgrState = useOntologyStore.getState();
    let mgr: any = undefined;
    if (typeof (mgrState as any).getRdfManager === "function") {
      try {
        mgr = (mgrState as any).getRdfManager();
      } catch (_) {
        mgr = undefined;
      }
    }
    if (!mgr) {
      mgr = (mgrState as any).rdfManager || fallbackRdfManager;
    }

    const g = 'urn:vg:data';
    const subjIri = (sourceNode && ((sourceNode as any).iri));
    const objIri = (targetNode && ((targetNode as any).iri));
    const predicateRaw = selectedProperty || displayValue;
    const predFull = mgr && typeof mgr.expandPrefix === 'function' ? String(mgr.expandPrefix(predicateRaw)) : String(predicateRaw);
    {
      if (mgr && typeof mgr.removeTriple === "function") {
        mgr.removeTriple(subjIri, predFull, objIri, g);
      } else if (mgr && typeof mgr.getStore === "function") {
        // best-effort fallback: remove via low-level store if manager doesn't expose helper
        try {
          const store = mgr.getStore();
          const s = namedNode(String(subjIri));
          const p = namedNode(String(predFull));
          const o = /^https?:\/\//i.test(String(objIri)) ? namedNode(String(objIri)) : (String(objIri) ? namedNode(String(objIri)) : null);
          const found = store.getQuads(s, p, o, namedNode(g)) || [];
          for (const q of found) {
            try { if (typeof mgr.bufferSubjectFromQuad === "function") mgr.bufferSubjectFromQuad(q); } catch (_) { void 0; }
            if (typeof store.removeQuad === "function") store.removeQuad(q);
          }
        } catch (_) { /* ignore fallback failures */ }
      }
    }

    // Close dialog after deletion so UI does not remain open
    { if (typeof onOpenChange === 'function') onOpenChange(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md text-foreground">
        <DialogHeader>
          <DialogTitle>{linkData?.operation === 'create' ? 'Create Connection' : 'Edit Connection Property'}</DialogTitle>
          <DialogDescription>Select the relationship type between these nodes</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-muted/50 p-3 rounded-lg border border-border">
            <div className="text-sm font-medium">
              {(() => {
                // Prefer the canvas-provided nodes for display. Avoid any RDF store lookups.
                const sIri = String(sourceNode?.iri ?? sourceNode?.key ?? '');
                const tIri = String(targetNode?.iri ?? targetNode?.key ?? '');
                const format = (iri: string) => {
                  if (!iri) return '';
                  if (iri.startsWith('_:')) return iri;
                  try {
                    // Prefer toPrefixed; it will return a prefixed form if available.
                    const p = toPrefixed(iri);
                    return String(p || '');
                  } catch (_) {
                    // Fallback to raw IRI string if prefixing fails
                    return iri;
                  }
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
            <EntityAutoComplete
              mode="properties"
              value={selectedProperty}
              onChange={(ent: any) => setSelectedProperty(ent ? String(ent.iri || '') : '')}
              placeholder="Type to search for object properties..."
              emptyMessage="No object properties found. Load an ontology first."
              className="w-full"
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

export default LinkPropertyEditor;
