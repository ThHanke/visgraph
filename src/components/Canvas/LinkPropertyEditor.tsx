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
import { getPredicateDisplay } from './core/edgeLabel';
import { buildEdgePayload, addEdgeToCurrentGraph, generateEdgeId } from './core/edgeHelpers';

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

    // Resolve subject/object deterministically from the canvas-provided node props.
    // Do NOT fall back to linkData fields — the canvas must provide authoritative endpoints.
    const subjIri = (sourceNode && ((sourceNode as any).iri || (sourceNode as any).key)) || "";
    const objIri = (targetNode && ((targetNode as any).iri || (targetNode as any).key)) || "";

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
        const predVal = (property && property.value) || uriToSave;
        // Use the shared helper to build canonical payload and insert with deduplication.
        const labelForEdge = property && property.label ? String(property.label) : "";
        const payload = buildEdgePayload(String(subjIri), String(objIri), String(predVal), labelForEdge);
        try {
          addEdgeToCurrentGraph(payload);
        } catch (_) {
          /* ignore insertion failures */
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

  /**
   * Delete the selected edge triple (subject, predicate, object) and remove matching edge(s)
   * from ontologyStore.currentGraph so the canvas updates immediately.
   */
  const handleDelete = async () => {
    if (!confirm('Delete this connection? This will remove the corresponding triple from the data graph.')) return;

    try {
      const mgrState = useOntologyStore.getState();
      const mgr =
        typeof (mgrState as any).getRdfManager === "function"
          ? (mgrState as any).getRdfManager()
          : (mgrState as any).rdfManager;
      if (!mgr) throw new Error('RDF manager unavailable');

      const store = mgr.getStore && mgr.getStore();
      if (!store) throw new Error('RDF store unavailable');

      // Resolve subject/object IRIs deterministically from sourceNode/targetNode props
      const subjIri = (sourceNode && ((sourceNode as any).iri || (sourceNode as any).key)) || "";
      const objIri = (targetNode && ((targetNode as any).iri || (targetNode as any).key)) || "";

      // Resolve predicate full IRI from selectedProperty or linkData
      const predicateRaw = selectedProperty || displayValue;
      const predFull =
        mgr && typeof mgr.expandPrefix === "function"
          ? String(mgr.expandPrefix(predicateRaw))
          : String(predicateRaw);

      // Remove matching quads in urn:vg:data graph first
      try {
        const g = namedNode("urn:vg:data");
        const subjTerm = namedNode(String(subjIri));
        const predTerm = namedNode(String(predFull));
        const objTerm = namedNode(String(objIri));
        const quads = store.getQuads(subjTerm, predTerm, objTerm, g) || [];
        quads.forEach((q: any) => {
          try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
        });
      } catch (_) {
        // Fallback: remove any matching quad across graphs
        try {
          const subjTerm = namedNode(String(subjIri));
          const predTerm = namedNode(String(predFull));
          const objTerm = namedNode(String(objIri));
          const quads = store.getQuads(subjTerm, predTerm, objTerm, null) || [];
          quads.forEach((q: any) => {
            try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
          });
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

      // Remove corresponding edge(s) from ontologyStore.currentGraph
        try {
          const os = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : null;
          if (os && typeof os.setCurrentGraph === 'function') {
            const cg = os.currentGraph || { nodes: [], edges: [] };

            // Build canonical expected id
            const expectedId = generateEdgeId(String(subjIri), String(objIri), String(predFull || predicateRaw || ""));

            // Defensive: collect removed edge ids for diagnostics
            const removedIds: string[] = [];

            // Filter edges by matching endpoints AND predicate (prefer canonical predicate match).
            const newEdges = (cg.edges || []).filter((e: any) => {
              try {
                // Keep any edge that does not match the subject+object pair
                if (String(e.source) !== String(subjIri) || String(e.target) !== String(objIri)) {
                  return true;
                }

                // Candidate predicate values from the existing edge payload (various shapes)
                const candidatePreds: string[] = [];
                try {
                  if (e && e.data) {
                    if (typeof e.data.propertyUri === "string") candidatePreds.push(String(e.data.propertyUri));
                    if (typeof e.data.propertyType === "string") candidatePreds.push(String(e.data.propertyType));
                    if (typeof e.data.property === "string") candidatePreds.push(String(e.data.property));
                    if (typeof e.data.predicate === "string") candidatePreds.push(String(e.data.predicate));
                  }
                } catch (_) { /* ignore */ }

                // Also include raw id and label as fallbacks
                try {
                  if (e && e.id) candidatePreds.push(String(e.id));
                  if (e && e.data && e.data.label) candidatePreds.push(String(e.data.label));
                } catch (_) { /* ignore */ }

                // Normalize candidates and check for a match
                const predCandidates = Array.from(new Set(candidatePreds.filter(Boolean)));

                const canonicalMatches = predCandidates.some((cp) => {
                  try {
                    // Exact full-IRI match
                    if (String(cp) === String(predFull)) return true;
                    // Match against raw selected predicate (unexpanded)
                    if (String(cp) === String(predicateRaw)) return true;
                    // Match if generating ID from candidate yields the expected id
                    try {
                      const gen = generateEdgeId(String(e.source), String(e.target), String(cp));
                      if (String(gen) === String(expectedId)) return true;
                    } catch (_) { /* ignore generator errors */ }
                    return false;
                  } catch (_) {
                    return false;
                  }
                });

                const linkId = linkData && linkData.id ? String(linkData.id) : "";

                // If any canonical match, treat as the edge to remove
                if (canonicalMatches || (e && String(e.id) === linkId) || String(e.id) === expectedId) {
                  try { removedIds.push(String(e.id || "")); } catch (_) { /* ignore */ }
                  return false; // filter out (remove) this edge
                }

                // Otherwise keep the edge
                return true;
              } catch (err) {
                // On error keep the edge to avoid accidental data loss
                return true;
              }
            });

            try {
              // Diagnostic logging to help reproduce issues when deletion still fails
              try {
                console.debug("[VG] LinkPropertyEditor.handleDelete - removed edge ids:", removedIds, {
                  subjIri,
                  objIri,
                  predicateRaw,
                  predFull,
                  expectedId,
                  linkDataId: linkData && linkData.id ? linkData.id : undefined,
                });
              } catch (_) { /* ignore logging failures */ }

              os.setCurrentGraph(cg.nodes || [], newEdges);
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore update failures */ }

      onOpenChange(false);
    } catch (err) {
      try {
        console.error('Failed to delete edge', err);
      } catch (_ ) {
        try {
          if (typeof window !== "undefined" && (window as any).__VG_DEBUG__) {
            console.debug("[VG] suppressed error in LinkPropertyEditor", _);
          }
        } catch (_) {
          /* ignore logging failures */
        }
      }
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{linkData?.operation === "create" ? "Create Connection" : "Edit Connection Property"}</DialogTitle>
          <DialogDescription>
            Select the relationship type between these nodes
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          {/* Connection Info */}
          <div className="bg-muted/50 p-3 rounded-lg">
            <div className="text-sm font-medium">
            {(() => {
              // Prefer the linkSource/linkTarget props (set by the canvas refs) as the single source of truth
              // for what the user intended when dragging. Fall back to the selected link payload fields only
              // if the props are not available (timing/latency cases).
              // Use the canvas-provided nodes as the single source of truth for display.
              const sIri = String(sourceNode?.iri ?? sourceNode?.key ?? '');
              const tIri = String(targetNode?.iri ?? targetNode?.key ?? '');
              const mgrState = useOntologyStore.getState();
              const rdfMgr = typeof mgrState.getRdfManager === 'function' ? mgrState.getRdfManager() : (mgrState as any).rdfManager;
              const format = (iri: string) => {
                if (!iri) return '';
                if (iri.startsWith('_:')) return iri;
                try {
                  const td = rdfMgr ? computeTermDisplay(iri, rdfMgr as any) : undefined;
                  if (td) return (td.prefixed || td.short || '').replace(/^(https?:\/\/)?(www\.)?/, '');
                } catch (_) {
                  /* ignore computeTermDisplay failures */
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
            <Button type="button" variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSave}
              disabled={!(selectedProperty || displayValue)}
            >
              {linkData?.operation === "create" ? "Create Connection" : "Save Connection"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
