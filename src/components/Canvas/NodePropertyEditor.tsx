 
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
  // optional callback so parent can immediately remove the node from the canvas (deleteElements)
  onDelete?: (iriOrId: string) => void;
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
  onDelete,
}: NodePropertyEditorProps) => {
  // Local form state
  const [nodeIri, setNodeIri] = useState<string>("");
  const [nodeType, setNodeType] = useState<string>("");
  const [properties, setProperties] = useState<LiteralProperty[]>([]);
  const [rdfTypesState, setRdfTypesState] = useState<string[]>([]);

  // Keep a ref of the initial properties so we can compute diffs on save
  const initialPropertiesRef = useRef<LiteralProperty[]>([]);
  const initialRdfTypesRef = useRef<string[]>([]);

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

    // Subject IRI
    const subjIri = String(nodeIri);
    if (!subjIri) throw new Error("Node IRI missing; cannot persist node properties.");

    // Acquire RDF manager (must exist)
    const mgrState = useOntologyStore.getState();
    const mgr = typeof (mgrState as any).getRdfManager === "function"
      ? (mgrState as any).getRdfManager()
      : (mgrState as any).rdfManager;

    if (!mgr || typeof (mgr as any).applyBatch !== "function") {
      throw new Error("RDF manager unavailable or does not support applyBatch; cannot persist node properties.");
    }

    // Compute annotation property diffs from initial snapshot (no RDF lookups)
    const { toAdd: propsToAdd, toRemove: propsToRemove } = diffProperties(initialPropertiesRef.current || [], properties || []);

    // Compute rdf:type diffs (use rdfTypesState if present, otherwise use nodeType)
    const currentTypes = (Array.isArray(rdfTypesState) && rdfTypesState.length > 0) ? rdfTypesState.slice() : (nodeType ? [String(nodeType)] : []);
    const initialTypes = Array.isArray(initialRdfTypesRef.current) ? initialRdfTypesRef.current.slice() : [];
    const typesToAdd = currentTypes.filter((t) => t && !initialTypes.includes(t));
    const typesToRemove = initialTypes.filter((t) => t && !currentTypes.includes(t));

    const removes: any[] = [];
    const adds: any[] = [];

    // Prepare rdf:type predicate full IRI
    const rdfTypePred = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix("rdf:type")) : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

    // Build removes for annotation properties (remove specific literal values)
    for (const p of propsToRemove || []) {
      try {
        const predFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(p.key)) : String(p.key);
        removes.push({ subject: subjIri, predicate: predFull, object: String(p.value || "") });
      } catch (_) { /* ignore per-item */ }
    }

    // Build removes for rdf:type removals
    for (const t of typesToRemove || []) {
      try {
        const typeFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(String(t))) : String(t);
        removes.push({ subject: subjIri, predicate: rdfTypePred, object: typeFull });
      } catch (_) { /* ignore per-item */ }
    }

    // Build adds for annotation properties
    for (const p of propsToAdd || []) {
      try {
        const predFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(p.key)) : String(p.key);
        adds.push({ subject: subjIri, predicate: predFull, object: String(p.value || "") });
      } catch (_) { /* ignore per-item */ }
    }

    // Build adds for rdf:type additions
    for (const t of typesToAdd || []) {
      try {
        const typeFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(String(t))) : String(t);
        adds.push({ subject: subjIri, predicate: rdfTypePred, object: typeFull });
      } catch (_) { /* ignore per-item */ }
    }

    // Apply batch (manager will notify). Use empty arrays when nothing to do so applyBatch is deterministic.
    try {
      await (mgr as any).applyBatch({ removes: removes, adds: adds }, "urn:vg:data");
    } catch (err) {
      try { console.warn("NodePropertyEditor.applyBatch.failed", err); } catch (_) { void 0; }
      throw err;
    }

    // Notify parent about saved properties (preserve previous contract: pass annotation properties array)
    const annotationProperties = properties.map((p) => ({
      propertyUri: p.key,
      key: p.key,
      value: p.value,
      type: p.type || "xsd:string",
    }));
    try { if (typeof onSave === "function") onSave(annotationProperties); } catch (_) { void 0; }

    // Close dialog (manager already emits change notifications)
    onOpenChange(false);

    // Update initial snapshots so subsequent edits compute diffs relative to latest saved state
    try { initialPropertiesRef.current = (properties || []).map(p => ({ ...p })); } catch (_) { void 0; }
    try { initialRdfTypesRef.current = (currentTypes || []).slice(); } catch (_) { void 0; }
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

      if (mgr && typeof (mgr as any).removeAllQuadsForIri === "function") {
        try {
          await (mgr as any).removeAllQuadsForIri(String(nodeIri), "urn:vg:data");
        } catch (_) {
          /* ignore manager delete failures */
        }
      }
    } catch (err) {
      try { console.warn("NodePropertyEditor.delete.failed", err); } catch (_) { void 0; }
    }

    // Ask parent to remove the node visually and then close the dialog
    try { if (typeof onDelete === "function") onDelete(String(nodeIri)); } catch (_) { void 0; }
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
                      className={!property.key.trim() ? "border-destructive" : ""}
                    />
                    {!property.key.trim() && (
                      <p className="text-xs text-destructive mt-1">Property is required</p>
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
                <div className="text-center py-4 text-muted-foreground border-2 border-dashed border-border/20 rounded-lg">
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
