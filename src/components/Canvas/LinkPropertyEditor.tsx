import { useState, useEffect, useMemo } from 'react';
import { DataFactory } from 'n3';
const { namedNode, quad } = DataFactory;
import { useCanvasState } from '../../hooks/useCanvasState';
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
import { toPrefixed, expandPrefixed } from '../../utils/termUtils';
import { rdfManager as fallbackRdfManager } from '../../utils/rdfManager';
import { getNamespaceRegistry, getRdfManager } from '../../utils/storeHelpers';

interface LinkPropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkData: any;
  sourceNode: any;
  targetNode: any;
  onSave: (propertyType: string, label: string) => Promise<void> | void;
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
  const { actions: canvasActions } = useCanvasState();

  // Read suggestions directly from the store each render (no snapshots).
  const availableProperties = useOntologyStore((s) => s.availableProperties);
  const entityIndex = useOntologyStore((s) => (s as any).entityIndex);
  const entitySuggestions = Array.isArray(entityIndex?.suggestions) ? entityIndex.suggestions : undefined;
  const computedAllObjectProperties = useMemo(() => {
    if (Array.isArray(entitySuggestions) && entitySuggestions.length > 0) {
      return entitySuggestions.map((ent: any) => ({
        iri: String(ent.iri || ent || ''),
        label: ent.label || undefined,
        description: ent.display || ent.description,
        rdfType: ent.rdfType,
        prefixed: ent.prefixed,
        __native: ent,
      }));
    }
    if (Array.isArray(availableProperties)) {
      return availableProperties.map((prop: any) => ({
        iri: String(prop.iri || prop || ''),
        label: prop.label || undefined,
        description: prop.description || prop.namespace || undefined,
        rdfType: prop.rdfType || prop.type,
        prefixed: prop.prefixed,
        __native: prop,
      }));
    }
    return [];
  }, [entitySuggestions, availableProperties]);

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
    setSelectedProperty((prev) => (prev === resolvedStr ? prev : resolvedStr));
  }, [open, linkData]);

  // If the editor opens and there is no selectedProperty yet, but available properties exist,
  // prefill the selector with the first available property so UI tests and users immediately
  // see a sensible default. Use the memoized computedAllObjectProperties directly.
  const firstSuggestionIri =
    computedAllObjectProperties.length > 0
      ? String(computedAllObjectProperties[0]?.iri || "")
      : "";

  useEffect(() => {
    if (!open) return;
    if (!firstSuggestionIri) return;
    const trimmed = String(selectedProperty || "").trim();
    if (trimmed) return;
    setSelectedProperty((prev) =>
      String(prev || "").trim() ? prev : firstSuggestionIri,
    );
  }, [open, selectedProperty, firstSuggestionIri]);

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
    try { canvasActions.setLoading(true, 0, "Saving connection..."); } catch (_) {/* noop */}
    const uriToSave = selectedProperty || displayValue;
    if (!uriToSave) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      return;
    }

    // Resolve manager + subject/object IRIs (endpoints must come from props)
    const mgr = getRdfManager() || fallbackRdfManager;

    const subjIri = (sourceNode && ((sourceNode as any).iri));
    const objIri = (targetNode && ((targetNode as any).iri));
    const oldPredIRI = linkData.data?.propertyUri;
    const graphName = "urn:vg:data";
    if (mgr && subjIri && objIri) {
      // Use centralized expandPrefixed from termUtils
      const registry = getNamespaceRegistry();
      const expand = (value: string | undefined | null): string => {
        if (!value) return "";
        const trimmed = String(value).trim();
        if (!trimmed) return "";
        // If already a full IRI, return as-is
        if (trimmed.includes("://")) return trimmed;
        // Expand using namespace registry
        return expandPrefixed(trimmed, registry as any);
      };

      const nextPredicate = expand(String(uriToSave));
      const previousPredicate = oldPredIRI ? expand(String(oldPredIRI)) : "";

      console.debug('[VG] LinkPropertyEditor.handleSave expanded IRIs', {
        subjIri,
        nextPredicate,
        previousPredicate,
        objIri,
        graphName
      });

      const removes: Array<{ subject: string; predicate: string; object: string }> = [];
      const adds: Array<{ subject: string; predicate: string; object: string }> = [];

      // For create operations, previousPredicate might be set (from UI state) but we still need to add the triple
      const isCreateOperation = linkData?.operation === 'create';

      if (previousPredicate && previousPredicate !== nextPredicate && !isCreateOperation) {
        removes.push({
          subject: String(subjIri),
          predicate: previousPredicate,
          object: String(objIri),
        });
      }

      if (isCreateOperation || !previousPredicate || previousPredicate !== nextPredicate) {
        adds.push({
          subject: String(subjIri),
          predicate: nextPredicate,
          object: String(objIri),
        });
      }

      console.debug('[VG] LinkPropertyEditor.handleSave batch', {
        removes,
        adds,
        hasApplyBatch: typeof mgr.applyBatch === "function"
      });

      if (removes.length === 0 && adds.length === 0) {
        console.debug('[VG] LinkPropertyEditor.handleSave: no changes to apply');
        /* No effective change requested */
      } else if (typeof mgr.applyBatch === "function") {
        try {
          console.debug('[VG] LinkPropertyEditor calling applyBatch', { removes, adds, graphName });
          await mgr.applyBatch({ removes, adds }, graphName);
          console.debug('[VG] LinkPropertyEditor applyBatch completed successfully');
        } catch (err) {
          console.error("[LinkPropertyEditor] applyBatch failed, falling back to primitive ops", err);
          if (removes.length && typeof mgr.removeTriple === "function") {
            for (const rem of removes) {
              try { mgr.removeTriple(rem.subject, rem.predicate, rem.object, graphName); } catch (_) { /* ignore */ }
            }
          }
          if (adds.length && typeof mgr.addTriple === "function") {
            for (const add of adds) {
              try { mgr.addTriple(add.subject, add.predicate, add.object, graphName); } catch (_) { /* ignore */ }
            }
          }
        }
      } else {
        if (removes.length && typeof mgr.removeTriple === "function") {
          for (const rem of removes) {
            try { mgr.removeTriple(rem.subject, rem.predicate, rem.object, graphName); } catch (_) { /* ignore */ }
          }
        }
        if (adds.length && typeof mgr.addTriple === "function") {
          for (const add of adds) {
            try { mgr.addTriple(add.subject, add.predicate, add.object, graphName); } catch (_) { /* ignore */ }
          }
        }
      }
    }
    try {
      const property = (computedAllObjectProperties || []).find((p) => String(p.iri || '') === String(uriToSave));
      await onSave(uriToSave, property?.label || uriToSave);
    } catch (err) {
      console.error("[LinkPropertyEditor] onSave handler rejected", err);
    } finally {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      onOpenChange(false);
    }
  };

  const handleDelete = async () => {
    try { canvasActions.setLoading(true, 0, "Deleting connection..."); } catch (_) {/* noop */}
    if (!confirm('Delete this connection? This will remove the corresponding triple from the data graph.')) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      return;
    }

    // Mirror handleSave's robust manager resolution: prefer store-provided manager, fall back to a global rdfManager helper.
    const mgr = getRdfManager() || fallbackRdfManager;

    const g = "urn:vg:data";
    const subjIri = (sourceNode && ((sourceNode as any).iri));
    const objIri = (targetNode && ((targetNode as any).iri));
    const predicateRaw = selectedProperty || displayValue;
    // Use centralized expandPrefixed from termUtils
    const registry = getNamespaceRegistry();
    const predFull = predicateRaw && predicateRaw.includes("://")
      ? String(predicateRaw)
      : expandPrefixed(String(predicateRaw), registry as any);

    console.debug('[VG] LinkPropertyEditor.handleDelete', {
      subjIri,
      predicateRaw,
      predFull,
      objIri,
      graphName: g
    });

    if (mgr && subjIri && objIri && predFull) {
      const removes = [{ subject: String(subjIri), predicate: predFull, object: String(objIri) }];
      console.debug('[VG] LinkPropertyEditor.handleDelete calling applyBatch', { removes, graphName: g });
      if (typeof mgr.applyBatch === "function") {
        try {
          await mgr.applyBatch({ removes, adds: [] }, g);
          console.debug('[VG] LinkPropertyEditor.handleDelete applyBatch completed');
        } catch (err) {
          console.error("[LinkPropertyEditor] applyBatch remove failed, falling back to removeTriple", err);
          if (typeof mgr.removeTriple === "function") {
            for (const rem of removes) {
              try { mgr.removeTriple(rem.subject, rem.predicate, rem.object, g); } catch (_) { /* ignore */ }
            }
          }
        }
      } else if (typeof mgr.removeTriple === "function") {
        for (const rem of removes) {
          try { mgr.removeTriple(rem.subject, rem.predicate, rem.object, g); } catch (_) { /* ignore */ }
        }
      }
    }

    // Close dialog after deletion so UI does not remain open
    try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
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
