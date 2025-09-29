/* eslint-disable react-refresh/only-export-components, no-empty */
/**
 * Node Property Editor (streamlined)
 *
 * - Initializes purely from the node object passed in via props (node or node.data).
 * - Uses only the fat-map (availableEntities / availableClasses / availableProperties)
 *   for autocomplete / suggestions — no RDF store lookups during initialization or render.
 * - On save/delete the editor will perform minimal RDF store writes (add/remove quads)
 *   to the urn:vg:data graph and then call onSave/onOpenChange. It will NOT attempt to
 *   read or discover types from the RDF store at render time.
 *
 * This rebuild removes any heavy synchronous store reads and any fallback discovery logic.
 */

import React, { useEffect, useMemo, useState, useRef } from "react";
import { DataFactory } from "n3";
const { namedNode } = DataFactory;
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { AutoComplete } from "../ui/AutoComplete";
import { EntityAutocomplete } from "../ui/EntityAutocomplete";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useOntologyStore } from "../../stores/ontologyStore";
import { X, Plus, Info } from "lucide-react";
// React Flow selection hook — allow editor to derive node when no explicit prop provided
import { useOnSelectionChange } from "@xyflow/react";

// Simple termForIri helper used for constructing N3 terms (handles blank nodes like "_:b0")
const termForIri = (iri: string) => {
  try {
    if (typeof iri === "string" && iri.startsWith("_:")) {
      return DataFactory.blankNode(iri.slice(2));
    }
  } catch (_) {
    /* ignore */
  }
  return namedNode(String(iri));
};

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
  nodeData: any; // expected to be the React Flow node object or an object with .data
  onSave: (updatedData: any) => void;
  availableEntities: Array<{
    iri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

/**
 * Simplified NodePropertyEditor that relies on passed nodeData and fat-map suggestions.
 * Persistence to the RDF store is handled here only on save/delete (writes only).
 */
export const NodePropertyEditor = ({
  open,
  onOpenChange,
  nodeData,
  onSave,
  availableEntities,
}: NodePropertyEditorProps) => {
  // Local form state
  const [nodeIri, setNodeIri] = useState<string>("");
  const [nodeType, setNodeType] = useState<string>("");
  const [properties, setProperties] = useState<LiteralProperty[]>([]);
  const [rdfTypesState, setRdfTypesState] = useState<string[]>([]);

  // Keep a ref of the initial properties so we can compute diffs on save
  const initialPropertiesRef = useRef<LiteralProperty[]>([]);

  // Fat-map sources from ontology store (used only for autocomplete)
  const availableClasses = useOntologyStore((s) => s.availableClasses || []);
  const availableProperties = useOntologyStore((s) => s.availableProperties || []);
  const entityIndex = useOntologyStore((s: any) => (s as any).entityIndex);

  // Build classEntities and property suggestions from fat-map
  const classEntities = useMemo(() => {
    const fromStore = Array.isArray(availableClasses)
      ? availableClasses.map((cls: any) => ({ iri: cls.iri, label: cls.label, namespace: cls.namespace }))
      : [];
    // Also include availableEntities provided by caller if any
    const fromProps = Array.isArray(availableEntities) ? availableEntities.map((e) => ({ iri: e.iri, label: e.label, namespace: e.namespace })) : [];
    const merged = new Map<string, any>();
    fromStore.forEach((e) => { if (e && e.iri) merged.set(String(e.iri), e); });
    fromProps.forEach((e) => { if (e && e.iri) merged.set(String(e.iri), e); });
    return Array.from(merged.values());
  }, [availableClasses, availableEntities]);

  const propertySuggestions = useMemo(() => {
    const common = [
      "rdfs:label",
      "rdfs:comment",
      "skos:prefLabel",
      "skos:altLabel",
      "dc:description",
      "owl:sameAs",
    ];
    const fromFat = Array.isArray(availableProperties) ? availableProperties.map((p: any) => ({ value: String(p.iri || p.key || p), label: String(p.label || p.name || p.iri || p) })) : [];
    const merged = new Map<string, any>();
    common.forEach((p) => merged.set(p, { value: p, label: p }));
    fromFat.forEach((p: any) => merged.set(String(p.value), p));
    return Array.from(merged.values());
  }, [availableProperties]);

  // Selection is driven by the parent KnowledgeCanvas which passes `nodeData` prop.
  // Keep a local state slot for future use but do not subscribe to React Flow here to
  // avoid requiring a ReactFlowProvider in tests.
  const [selectedFromRF, setSelectedFromRF] = useState<any | null>(null);

  // Initialize local form state from the passed nodeData when dialog opens.
  useEffect(() => {
    if (!open) return;

    // Prefer explicit prop nodeData, otherwise use selection-derived node
    const sourceNode = nodeData && (nodeData.data || nodeData)
      ? (nodeData.data || nodeData)
      : selectedFromRF && (selectedFromRF.data || selectedFromRF)
        ? (selectedFromRF.data || selectedFromRF)
        : selectedFromRF;

    if (!sourceNode) {
      setNodeIri("");
      setNodeType("");
      setProperties([]);
      setRdfTypesState([]);
      initialPropertiesRef.current = [];
      return;
    }

    // node could be React Flow node object or a plain node data object — handle both.
    const d = sourceNode;

    // IRI
    const iri = (d && (d.iri || d.id || d.key)) ? String(d.iri || d.id || d.key) : "";
    setNodeIri(iri);

    // Class/type info: prefer explicit rdfTypes array or classType/displayType fields
    const rdfTypes = Array.isArray(d.rdfTypes) ? d.rdfTypes.slice() : (d.rdfType ? [d.rdfType] : []);
    setRdfTypesState(rdfTypes);
    // For UI selection show the first non-NamedIndividual meaningful class if present, otherwise empty
    const chosen = (rdfTypes || []).find((t: any) => t && !String(t).includes("NamedIndividual")) || d.classType || d.displayType || "";
    setNodeType(String(chosen || ""));

    // Annotation properties
    const existingProps: LiteralProperty[] = [];
    if (Array.isArray(d.annotationProperties)) {
      d.annotationProperties.forEach((p: any) => {
        existingProps.push({
          key: p.propertyUri || p.property || p.key || "",
          value: p.value || "",
          type: p.type || "xsd:string",
        });
      });
    } else if (Array.isArray(d.annotations)) {
      d.annotations.forEach((ann: any) => {
        if (ann && typeof ann === "object") {
          const entry = Object.entries(ann)[0] as [string, any];
          existingProps.push({ key: String(entry[0] || ""), value: String(entry[1] || ""), type: "xsd:string" });
        }
      });
    }

    setProperties(existingProps);
    initialPropertiesRef.current = existingProps.map(p => ({ ...p }));
  }, [open, nodeData, selectedFromRF]);

  // Handlers for properties
  const handleAddProperty = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties((prev) => [...prev, { key: "", value: "", type: "xsd:string" }]);
  };

  const handleRemoveProperty = (index: number, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateProperty = (index: number, field: keyof LiteralProperty, value: string) => {
    setProperties((prev) => prev.map((p, i) => i === index ? { ...p, [field]: value } : p));
  };

  // Utility to diff annotation properties (simple equality on key+value+type)
  const diffProperties = (before: LiteralProperty[], after: LiteralProperty[]) => {
    const key = (p: LiteralProperty) => `${p.key}||${p.value}||${p.type || ""}`;
    const beforeSet = new Set(before.map(key));
    const afterSet = new Set(after.map(key));
    const toAdd = after.filter(p => !beforeSet.has(key(p)));
    const toRemove = before.filter(p => !afterSet.has(key(p)));
    return { toAdd, toRemove };
  };

  // Save: persist annotation properties (writes only) and rdf:type when applicable,
  // then close the dialog. Errors are allowed to surface (no silent fallbacks).
  const handleSave = async (e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    // Validate properties: no empty keys
    if (properties.some(p => !p.key || !p.key.trim())) {
      throw new Error("Please provide property names for all annotation properties (no empty keys).");
    }

    // Compose canonical annotation properties
    const annotationProperties = properties.map((p) => ({
      propertyUri: p.key,
      key: p.key,
      value: p.value,
      type: p.type || "xsd:string",
    }));

    // Acquire RDF manager (must exist in this strict mode)
    const mgrState = useOntologyStore.getState();
    const mgr = typeof (mgrState as any).getRdfManager === "function"
      ? (mgrState as any).getRdfManager()
      : (mgrState as any).rdfManager;

    if (!mgr) {
      throw new Error("RDF manager unavailable; cannot persist node properties.");
    }

    // Subject IRI
    const subjIri = String(nodeIri);
    if (!subjIri) throw new Error("Node IRI missing; cannot persist node properties.");

    // If nodeType provided (creation flow), persist rdf:type triple
    if (nodeType && String(nodeType).trim()) {
      const typeCandidate = String(nodeType).trim();
      // Resolve to full IRI via manager if possible
      const typeFull = typeof mgr.expandPrefix === "function" ? String(mgr.expandPrefix(typeCandidate)) : typeCandidate;
      // Use primitive API if available
      if (typeof (mgr as any).addTriple === "function") {
        (mgr as any).addTriple(subjIri, typeof mgr.expandPrefix === "function" ? String(mgr.expandPrefix("rdf:type")) : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", typeFull, "urn:vg:data");
      } else if (mgr.getStore && typeof mgr.getStore === "function") {
        const store = mgr.getStore();
        const s = termForIri(subjIri);
        const p = namedNode(typeof mgr.expandPrefix === "function" ? String(mgr.expandPrefix("rdf:type")) : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
        const o = namedNode(typeFull);
        const g = namedNode("urn:vg:data");
        const exists = store.getQuads(s, p, o, g) || [];
        if (!exists || exists.length === 0) {
          store.addQuad(DataFactory.quad(s, p, o, g));
        }
      } else {
        throw new Error("Unable to persist rdf:type: unsupported rdfManager API.");
      }
    }

    // Persist annotation properties as literal triples with xsd types
    for (const ap of annotationProperties) {
      const predRaw = String(ap.propertyUri || ap.key || "");
      if (!predRaw) continue;
      const predFull = typeof mgr.expandPrefix === "function" ? String(mgr.expandPrefix(predRaw)) : predRaw;
      const datatype = ap.type || "xsd:string";
      const datatypeFull = typeof mgr.expandPrefix === "function" ? String(mgr.expandPrefix(datatype)) : datatype;
      const obj = DataFactory.literal(String(ap.value), namedNode(datatypeFull));

      if (typeof (mgr as any).addTriple === "function") {
        (mgr as any).addTriple(subjIri, predFull, String(ap.value), "urn:vg:data");
      } else if (mgr.getStore && typeof mgr.getStore === "function") {
        const store = mgr.getStore();
        const s = termForIri(subjIri);
        const p = namedNode(predFull);
        const g = namedNode("urn:vg:data");
        const exists = store.getQuads(s, p, obj, g) || [];
        if (!exists || exists.length === 0) {
          store.addQuad(DataFactory.quad(s, p, obj, g));
        }
      } else {
        throw new Error("Unable to persist annotation property: unsupported rdfManager API.");
      }
    }

    // Notify manager subscribers so incremental mapping picks up the changes
    if (typeof (mgr as any).notifyChange === "function") {
      (mgr as any).notifyChange();
    }

    // Close dialog after successful persistence
    onOpenChange(false);
  };

  // Delete: remove triples with subject OR object equal to nodeIri from urn:vg:data (writes only).
  const handleDelete = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!nodeIri) return;
    if (!confirm(`Delete node ${nodeIri}? This will remove triples in urn:vg:data where this IRI is subject or object.`)) return;

    try {
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
        mgr = (mgrState as any).rdfManager || (await import("../../utils/rdfManager").then(m => m.rdfManager).catch(() => undefined));
      }

      if (mgr && typeof mgr.getStore === "function" && typeof (mgr as any).removeTriple === "function") {
        const store = mgr.getStore();
        const g = namedNode("urn:vg:data");

        // Remove quads where subject === nodeIri by enumerating and calling manager.removeTriple
        try {
          const subjTerm = namedNode(String(nodeIri));
          const subjQuads = store.getQuads(subjTerm, null, null, g) || [];
          for (const q of subjQuads) {
            try {
              const s = (q.subject && (q.subject as any).value) || String(nodeIri);
              const p = (q.predicate && (q.predicate as any).value) || "";
              const o = (q.object && (q.object as any).value) || "";
              try { (mgr as any).removeTriple(String(s), String(p), String(o), "urn:vg:data"); } catch (_) { /* ignore per-quad */ }
            } catch (_) { /* ignore per-quad */ }
          }
        } catch (_) { /* ignore */ }

        // Remove quads where object === nodeIri
        try {
          const objTerm = namedNode(String(nodeIri));
          const objQuads = store.getQuads(null, null, objTerm, g) || [];
          for (const q of objQuads) {
            try {
              const s = (q.subject && (q.subject as any).value) || "";
              const p = (q.predicate && (q.predicate as any).value) || "";
              const o = (q.object && (q.object as any).value) || String(nodeIri);
              try { (mgr as any).removeTriple(String(s), String(p), String(o), "urn:vg:data"); } catch (_) { /* ignore per-quad */ }
            } catch (_) { /* ignore per-quad */ }
          }
        } catch (_) { /* ignore */ }

        // Notify once after removals
        try { if (typeof (mgr as any).notifyChange === "function") (mgr as any).notifyChange(); } catch (_) { /* ignore */ }
      } else if (mgr && typeof mgr.getStore === "function") {
        // Fallback to direct store removals (previous behavior)
        const store = mgr.getStore();
        const subjTerm = namedNode(String(nodeIri));
        const g = namedNode("urn:vg:data");

        try {
          const subjQuads = store.getQuads(subjTerm, null, null, g) || [];
          for (const q of subjQuads) {
            try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
          }
        } catch (_) { /* ignore */ }

        try {
          const objQuads = store.getQuads(null, null, subjTerm, g) || [];
          for (const q of objQuads) {
            try { store.removeQuad(q); } catch (_) { /* ignore per-quad */ }
          }
        } catch (_) { /* ignore */ }

        try { if (typeof (mgr as any).notifyChange === "function") (mgr as any).notifyChange(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      try { console.warn("NodePropertyEditor.delete.storeWriteFailed", err); } catch (_) { /* ignore */ }
    }

    // Notify RDF manager subscribers (best-effort) so incremental mapping picks up the deletion.
    try {
      const mgrState = useOntologyStore.getState();
      let mgrNotify: any = undefined;
      if (typeof (mgrState as any).getRdfManager === "function") {
        try { mgrNotify = (mgrState as any).getRdfManager(); } catch (_) { mgrNotify = undefined; }
      }
      if (!mgrNotify) mgrNotify = (mgrState as any).rdfManager || undefined;
      try {
        if (mgrNotify && typeof (mgrNotify as any).notifyChange === "function") {
          try { (mgrNotify as any).notifyChange(); } catch (_) { /* ignore notify errors */ }
        }
      } catch (_) { /* ignore notify errors */ }
    } catch (_) { /* ignore */ }

    // Signal close; parent incremental mapping should remove the node from the canvas when the store notifies.
    onOpenChange(false);
  };

  // Annotation property helpers for UI
  const getAnnotationProperties = () => {
    return propertySuggestions;
  };

  const getXSDTypes = () => [
    "xsd:string",
    "xsd:boolean",
    "xsd:integer",
    "xsd:decimal",
    "xsd:double",
    "xsd:float",
    "xsd:date",
    "xsd:dateTime",
    "xsd:time",
    "xsd:anyURI",
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] max-w-[min(90vw,48rem)] overflow-y-auto"
        onInteractOutside={(e) => {
          // Prevent closing when clicking on popover content
          const target = e.target as Element;
          if (target.closest("[data-radix-popper-content-wrapper]") ||
              target.closest("[data-radix-select-content]") ||
              target.closest("[cmdk-root]") ||
              target.closest("[data-radix-command]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit Node Properties</DialogTitle>
          <DialogDescription>
            Change the type, IRI, and annotation properties of this node.
            In A-box mode, owl:NamedIndividual is preserved by the mapping pipeline.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="nodeType">Node Type (Meaningful Class)</Label>
            <div className="flex items-center gap-2">
              <EntityAutocomplete
                entities={classEntities}
                value={nodeType}
                onValueChange={setNodeType}
                placeholder="Type to search for classes..."
                emptyMessage="No OWL classes found. Load an ontology first."
                className="w-full"
              />
              {nodeType && !classEntities.find(e => e.iri === nodeType) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground">
                      <Info className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64" side="top">
                    <div className="text-xs">
                      The selected rdf:type is not present in the loaded fat-map. It will be saved as the displayType but not resolved to a known class.
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              owl:NamedIndividual will be preserved by the mapping pipeline if applicable.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="nodeIri">Node IRI</Label>
            <Input
              id="nodeIri"
              value={nodeIri}
              onChange={(e) => setNodeIri(e.target.value)}
              placeholder="https://example.com/entity"
            />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Annotation Properties</Label>
              <Button type="button" variant="outline" size="sm" onClick={(e) => handleAddProperty(e)}>
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
                      onValueChange={(value) => handleUpdateProperty(index, "key", value)}
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
                      onChange={(e) => handleUpdateProperty(index, "value", e.target.value)}
                      placeholder="Property value..."
                    />
                  </div>

                  <div className="col-span-2">
                    <Label className="text-xs">Type</Label>
                    <Select value={property.type || "xsd:string"} onValueChange={(value) => handleUpdateProperty(index, "type", value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        {getXSDTypes().map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="col-span-1">
                    <Button type="button" variant="ghost" size="sm" onClick={(e) => handleRemoveProperty(index, e)} className="h-9 px-2">
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

          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button type="button" variant="destructive" onClick={(e) => handleDelete(e)}>
              Delete
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" onClick={(e) => handleSave(e)}>
              Save Changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
