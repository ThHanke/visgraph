import { useState, useEffect } from 'react';
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
import { computeTermDisplay, shortLocalName } from '../../utils/termUtils';

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

  const handleSave = async () => {
    const uriToSave = selectedProperty || displayValue;
    if (!uriToSave) return;

    // Resolve manager + subject/object IRIs
    const mgrState = useOntologyStore.getState();
    const mgr =
      typeof (mgrState as any).getRdfManager === "function"
        ? (mgrState as any).getRdfManager()
        : (mgrState as any).rdfManager;

    const subjIri =
      (sourceNode && ((sourceNode as any).iri || (sourceNode as any).key)) ||
      (linkData && (linkData.data?.from || linkData.from || linkData.source)) ||
      "";
    const objIri =
      (targetNode && ((targetNode as any).iri || (targetNode as any).key)) ||
      (linkData && (linkData.data?.to || linkData.to || linkData.target)) ||
      "";

    try {
      if (mgr && subjIri && objIri) {
        const predFull =
          mgr && typeof mgr.expandPrefix === "function"
            ? String(mgr.expandPrefix(uriToSave))
            : String(uriToSave);

        // Build a small Turtle snippet to add the triple into the target graph.
        // Using rdfManager.loadRDFIntoGraph ensures the RDFManager's notification
        // pipeline (notifyChange / subject-change) runs so the canvas mapping updates.
        const subjEsc = `<${String(subjIri)}>`;
        const predEsc = `<${String(predFull)}>`;
        const objEsc = `<${String(objIri)}>`;
        const ttl = `${subjEsc} ${predEsc} ${objEsc} .\n`;

        try {
          if (typeof mgr.loadRDFIntoGraph === "function") {
            // Prefer the graph-aware loader so the triple is added into urn:vg:data
            await mgr.loadRDFIntoGraph(ttl, "urn:vg:data");
          } else if (typeof mgr.loadRDF === "function") {
            // Fallback: loadRDF then let parsing finalize trigger notifications
            await mgr.loadRDF(ttl);
          } else {
            // As a last resort (very unlikely), fall back to direct store writes and attempt to trigger change.
            const store = mgr.getStore && mgr.getStore();
            if (store) {
              const subjTerm = namedNode(String(subjIri));
              const predTerm = namedNode(String(predFull));
              const objTerm = namedNode(String(objIri));
              const g = namedNode("urn:vg:data");
              const existing = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
              if (!existing || existing.length === 0) {
                try {
                  store.addQuad(quad(subjTerm, predTerm, objTerm, g));
                } catch (_) { /* ignore */ }
              }
            }
            // Notify via RDFManager API not available here; rely on mapping rebuild subs to pick it up eventually.
          }

          // Dev diagnostics after attempt
          try {
            if (typeof window !== "undefined" && (window as any).__VG_DEBUG__) {
              try {
                // Read back existence from store if possible
                const store = mgr.getStore && mgr.getStore();
                if (store) {
                  const subjTerm = namedNode(String(subjIri));
                  const predTerm = namedNode(String(predFull));
                  const objTerm = namedNode(String(objIri));
                  const g = namedNode("urn:vg:data");
                  const after = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
                  console.debug("[VG] LinkPropertyEditor.persistQuad.added_via_mgr", {
                    subjIri,
                    predFull,
                    objIri,
                    afterCount: (after && after.length) || 0,
                  });
                  try { (window as any).__VG_LAST_ADDED_QUAD = { subj: String(subjTerm.value), pred: String(predTerm.value), obj: String(objTerm.value), graph: 'urn:vg:data' }; } catch (_) { /* ignore */ }
                }
              } catch (_) { /* ignore diag */ }
            }
          } catch (_) { /* ignore */ }
        } catch (err) {
          try {
            if (typeof window !== "undefined" && (window as any).__VG_DEBUG__) {
              console.error("[VG] LinkPropertyEditor.persistQuad.load_failed", { subjIri, uriToSave, objIri, error: (err && (err as Error).message) || String(err) });
            }
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) {
      /* ignore persistence errors - still call onSave to update UI mapping pipeline */
    }

    // Notify parent and close editor. The canvas mapping pipeline should reflect the new triple.
    const property = allObjectProperties.find((p) => p.value === uriToSave);

    try {
      // Best-effort: also insert a lightweight edge entry into ontologyStore.currentGraph so
      // the UI mapping pipeline reflects the new connection immediately (instead of waiting
      // for a full RDF->parsedGraph reconcile).
      const os = useOntologyStore.getState();
      if (os && typeof os.setCurrentGraph === "function") {
        try {
          const cg = os.currentGraph || { nodes: [], edges: [] };
          // Build a stable edge id
          const edgeId = String(`${subjIri}-${objIri}-${(property && property.value) || uriToSave}`);
          const exists = (cg.edges || []).some((e: any) => String(e.id) === edgeId);
          if (!exists) {
            const newEdge = {
              id: edgeId,
              source: String(subjIri),
              target: String(objIri),
              data: {
                propertyUri: (property && property.value) || uriToSave,
                propertyType: (property && property.value) || uriToSave,
                label: property && property.label ? property.label : (shortLocalName(String(uriToSave)) || String(uriToSave)),
              },
            } as any;
            try {
              os.setCurrentGraph(cg.nodes || [], [...(cg.edges || []), newEdge]);
            } catch (_) {
              /* ignore setCurrentGraph failures - not critical */
            }
          }
        } catch (_) {
          /* ignore ontologyStore update failures */
        }
      }
    } catch (_) {
      /* ignore */
    }

    onSave(uriToSave, property?.label || uriToSave);
    onOpenChange(false);
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
              const sIri = String(sourceNode?.iri ?? '');
              const tIri = String(targetNode?.iri ?? '');
              const mgrState = useOntologyStore.getState();
              const rdfMgr = typeof mgrState.getRdfManager === 'function' ? mgrState.getRdfManager() : mgrState.rdfManager;
              const format = (iri: string) => {
                if (iri.startsWith('_:')) return iri;
                try {
                  if (rdfMgr) {
                    const td = computeTermDisplay(iri, rdfMgr as any);
                    // prefer prefixed form for display; fall back to short
                    return (td.prefixed || td.short || '').replace(/^(https?:\/\/)?(www\.)?/, '');
                  }
                } catch (_) {
                  // fall through to local name fallback
                }
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
