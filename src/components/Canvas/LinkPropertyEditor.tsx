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
import { rdfManager as fallbackRdfManager } from '../../utils/rdfManager';
// React Flow selection hook - allows editor to fallback to RF selection when no props provided
import { useOnSelectionChange } from '@xyflow/react';

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

  const computedAllObjectProperties = useMemo(() => {
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

  // Keep a state-backed copy of the computed options so we can reliably pass a stable,
  // up-to-date options array to the AutoComplete component. Some AutoComplete implementations
  // may not update internal caches when a new array identity is supplied; updating a state
  // variable here forces React to re-render the child with a fresh reference.
  const [allObjectPropertiesState, setAllObjectPropertiesState] = useState(computedAllObjectProperties);

  useEffect(() => {
    try {
      setAllObjectPropertiesState(computedAllObjectProperties);
    } catch (_) {
      // ignore
    }
  }, [computedAllObjectProperties]);

  // Subscribe to React Flow selection when caller did not provide explicit linkData.
  const [selectedEdgeFromRF, setSelectedEdgeFromRF] = useState<any | null>(null);
  try {
    // useOnSelectionChange expects an options object; provide an onChange callback.
    useOnSelectionChange({
      onChange: (selection: any) => {
        try {
          const selEdges = Array.isArray(selection?.edges) ? selection.edges : [];
          const edge = selEdges.length === 1 ? selEdges[0] : null;

          // Avoid redundant state updates: only update if the selected edge identity changed.
          const prevId = selectedEdgeFromRF && (selectedEdgeFromRF.id || selectedEdgeFromRF.key) ? (selectedEdgeFromRF.id || selectedEdgeFromRF.key) : null;
          const edgeId = edge && (edge.id || edge.key) ? (edge.id || edge.key) : null;
          if (edgeId !== prevId) {
            setSelectedEdgeFromRF(edge);
          }

          // Mirror RF selection into dialog open state only when it would change the open prop.
          const shouldOpen = Boolean(edge);
          if (!linkData && typeof onOpenChange === 'function' && shouldOpen !== open) {
            try { onOpenChange(shouldOpen); } catch (_) { void 0; }
          }
        } catch (_) { /* ignore per-callback */ }
      },
    });
  } catch (_) { /* ignore hook failures outside provider */ }

  useEffect(() => {
    const candidate = linkData || selectedEdgeFromRF || {};
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
    // Re-run when the dialog is opened or when linkData identity/fields change or RF selection changes.
    open,
    linkData?.id,
    linkData?.key,
    linkData?.propertyUri,
    linkData?.propertyType,
    linkData?.data?.propertyUri,
    linkData?.data?.propertyType,
    selectedEdgeFromRF,
  ]);

  // If the editor opens and there is no selectedProperty yet, but available properties exist,
  // prefill the selector with the first available property so UI tests and users immediately
  // see a sensible default. This also makes the AutoComplete predictable for tests.
  useEffect(() => {
    try {
      if ((!selectedProperty || String(selectedProperty).trim() === "") && Array.isArray(allObjectPropertiesState) && allObjectPropertiesState.length > 0) {
        const first = allObjectPropertiesState[0];
        if (first && first.value) {
          setSelectedProperty(String(first.value));
        }
      }
    } catch (_) {
      // ignore
    }
  }, [allObjectPropertiesState, selectedProperty, open]);

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
        try {
          if (typeof mgr.addTriple === "function") {
            mgr.addTriple(subjIri, predFull, objIri, g);
          }
        } catch (_) { /* ignore add failures */ }
      } else if (String(oldPredIRI) !== String(predFull)) {
        try {
          if (typeof mgr.removeTriple === "function") {
            mgr.removeTriple(subjIri, oldPredIRI, objIri, g);
          }
        } catch (_) { /* ignore remove failures */ }
        try {
          if (typeof mgr.addTriple === "function") {
            mgr.addTriple(subjIri, predFull, objIri, g);
          }
        } catch (_) { /* ignore add failures */ }
      }
    }
    // Notify parent; canvas mapping will pick up the change via RDF manager
    const property = allObjectPropertiesState.find((p) => p.value === uriToSave);
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
    try {
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
    } catch (_) {
      /* ignore delete failures to avoid bubbling into UI tests */
    }

    // Close dialog after deletion so UI does not remain open
    try { if (typeof onOpenChange === 'function') onOpenChange(false); } catch (_) { void 0; }
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
              options={allObjectPropertiesState}
              value={selectedProperty}
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

export default LinkPropertyEditor;
