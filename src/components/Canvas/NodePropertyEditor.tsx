 
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
const { namedNode, blankNode, literal } = DataFactory;
import { useCanvasState } from "../../hooks/useCanvasState";

// Module-scoped counter for generated blank-node identifiers used when creating new nodes
let __vg_blank_counter = 1;
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
import EntityAutoComplete from "../ui/EntityAutoComplete";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useOntologyStore } from "../../stores/ontologyStore";
import { toPrefixed } from "../../utils/termUtils";
import { X, Plus, Info } from "lucide-react";
// React Flow selection hook — allow editor to derive node when no explicit prop provided

// Simple termForIri helper used for constructing N3 terms (handles blank nodes like "_:b0")
const termForIri = (iri: string) => {
  if (typeof iri === "string" && iri.startsWith("_:")) {
    return blankNode(iri.slice(2));
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
  // Optional native term objects when available from the mapper
  predicateTerm?: any;
  objectTerm?: any;
  // Optional language tag when datatype is xsd:string (e.g. "en")
  lang?: string;
}

/**
 * Props for the NodePropertyEditor component
 */
interface NodePropertyEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeData: any; // expected to be the React Flow node object or an object with .data
  onSave: (updatedData: any) => void;
  // optional callback so parent can immediately remove the node from the canvas (deleteElements)
  onDelete?: (iriOrId: string) => void;
  // optional list of available entities for the autocomplete (passed from canvas)
  availableEntities?: any[];
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
  const { actions: canvasActions } = useCanvasState();

  // Minimal selector used only for UI affordances (popover) to detect whether a chosen
  // rdf:type is present in the loaded fat-map. This is lightweight and avoids any
  // snapshotting logic while keeping the dialog simple.
  const availableClasses = useOntologyStore((s) => s.availableClasses || []);


  // Initialize local form state from the passed nodeData when dialog opens.
  useEffect(() => {
    if (!open) return;

    // Prefer explicit prop nodeData (no selection probing in this simplified editor)
    const sourceNode = nodeData && (nodeData.data || nodeData) ? (nodeData.data || nodeData) : null;

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
    // Capture the initial rdf.types snapshot so subsequent saves can compute removals.
    initialRdfTypesRef.current = Array.isArray(rdfTypes) ? rdfTypes.slice() : [];
    // For UI selection show the first non-NamedIndividual meaningful class if present, otherwise empty
    const chosen = (rdfTypes || []).find((t: any) => t && !String(t).includes("NamedIndividual")) || d.classType || d.displayType || "";
    setNodeType(String(chosen || ""));

    // Annotation properties
    const existingProps: LiteralProperty[] = [];
    if (Array.isArray(d.annotationProperties)) {
      d.annotationProperties.forEach((p: any) => {
        // Prefer native Term shapes when available (predicateTerm / objectTerm).
        const predIri =
          (p && (p.property || p.propertyUri)) ||
          (p && p.predicateTerm && p.predicateTerm.value)
            ? String((p && (p.property || p.propertyUri)) || (p && p.predicateTerm && p.predicateTerm.value) || "")
            : "";
        const objVal =
          p && p.value !== undefined && p.value !== null
            ? String(p.value)
            : p && p.objectTerm && p.objectTerm.value
            ? String(p.objectTerm.value)
            : "";
        // Derive a display-friendly type token:
        // - prefer explicit p.type when present
        // - else prefer objectTerm.datatype.value (full IRI) or objectTerm.language
        // - convert full IRI datatypes into prefixed tokens for the UI when possible
        // Prefer an explicit language tag when present on the Term.
        // Order of precedence:
        // 1) objectTerm.language (if present) -> display as xsd:string with lang populated
        // 2) explicit p.type that starts with "@" (legacy language marker) -> display as xsd:string with lang populated
        // 3) explicit p.type or objectTerm.datatype value -> use that datatype (prefixed for display when possible)
        // 4) fallback -> xsd:string
        let objTypeRaw =
          (p && p.type) ||
          (p && p.objectTerm && p.objectTerm.datatype && p.objectTerm.datatype.value)
            ? String((p && p.type) || (p && p.objectTerm && p.objectTerm.datatype && p.objectTerm.datatype.value) || "")
            : "";
        let objLang: string | undefined = undefined;
        let objType: string;
        // 1) Term language wins
        if (p && p.objectTerm && p.objectTerm.language) {
          objLang = String(p.objectTerm.language);
          objType = "xsd:string";
        } else if (objTypeRaw && String(objTypeRaw).startsWith("@")) {
          // 2) legacy "@lang" marker
          objLang = String(objTypeRaw).slice(1);
          objType = "xsd:string";
        } else if (!objTypeRaw) {
          // 4) no explicit type -> default string
          objType = "xsd:string";
        } else if (String(objTypeRaw).includes("://")) {
          // 3) full IRI datatype -> convert to prefixed token for display when possible
          try {
            const pref = toPrefixed(String(objTypeRaw));
            objType = pref || String(objTypeRaw);
          } catch (_) {
            objType = String(objTypeRaw);
          }
        } else {
          // 3b) already-prefixed token
          objType = String(objTypeRaw);
        }
        existingProps.push({
          key: predIri,
          value: objVal,
          type: objType,
          lang: objLang,
          predicateTerm: p && (p.predicateTerm || p.predicate),
          objectTerm: p && (p.objectTerm || p.object),
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
  }, [open, nodeData]);

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
    setProperties((prev) =>
      prev.map((p, i) => {
        if (i !== index) return p;
        // Update the requested field and clear native Terms when the user edits
        // the lexical value, datatype, or the predicate key so we don't reuse stale Terms.
        const updated: LiteralProperty = { ...p, [field]: value };
        try {
          if (field === "value" || field === "type") {
            // Value/type changed -> objectTerm no longer valid
            if ((updated as any).objectTerm) delete (updated as any).objectTerm;
          }
        } catch (_) {
          /* ignore */
        }
        try {
          if (field === "key") {
            // Predicate changed -> predicateTerm no longer valid
            if ((updated as any).predicateTerm) delete (updated as any).predicateTerm;
          }
        } catch (_) {
          /* ignore */
        }
        // Language/datatype exclusivity rules:
        try {
          if (field === "type") {
            // If user changed type away from xsd:string, clear lang
            if (String(value) !== "xsd:string" && (updated as any).lang) {
              delete (updated as any).lang;
            }
          }
          if (field === "lang") {
            // If user sets a language, ensure type is xsd:string
            if (value && String(value).trim()) {
              (updated as any).type = "xsd:string";
            }
          }
        } catch (_) {
          /* ignore */
        }
        return updated;
      }),
    );
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
    try {
      try { canvasActions.setLoading(true, 0, "Saving node..."); } catch (_) {}
    } catch (_) {}

    // Validate properties: no empty keys
    if (properties.some(p => !p.key || !p.key.trim())) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
      throw new Error("Please provide property names for all annotation properties (no empty keys).");
    }

    // Subject IRI (allow empty during "create" flows — we will generate a blank node id)
    let subjIri = String(nodeIri || "");
    const isCreate = !(nodeData && (nodeData.iri || nodeData.id || nodeData.key));
    let generatedBlank = false;
    if (!subjIri && isCreate) {
      // Generate a session-unique blank node id (client-side only)
      subjIri = `_:vgb${String(__vg_blank_counter++)}`;
      generatedBlank = true;
    }
    if (!subjIri) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
      throw new Error("Node IRI missing; cannot persist node properties.");
    }

    // Acquire RDF manager (must exist)
    const mgrState = useOntologyStore.getState();
    const mgr = typeof (mgrState as any).getRdfManager === "function"
      ? (mgrState as any).getRdfManager()
      : (mgrState as any).rdfManager;

    if (!mgr || typeof (mgr as any).applyBatch !== "function") {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
      throw new Error("RDF manager unavailable or does not support applyBatch; cannot persist node properties.");
    }

    // Compute annotation property diffs from initial snapshot (no RDF lookups)
    const { toAdd: propsToAdd, toRemove: propsToRemove } = diffProperties(initialPropertiesRef.current || [], properties || []);

    // Compute rdf:type diffs (use rdfTypesState if present, otherwise use nodeType)
    const currentTypes = (Array.isArray(rdfTypesState) && rdfTypesState.length > 0) ? rdfTypesState.slice() : (nodeType ? [String(nodeType)] : []);
    const initialTypes = Array.isArray(initialRdfTypesRef.current) ? initialRdfTypesRef.current.slice() : [];
    const typesToAdd = currentTypes.filter((t) => t && !initialTypes.includes(t));
    const typesToRemove = initialTypes.filter((t) => t && !currentTypes.includes(t));

    // Prepare removes/adds in the shape expected by rdfManager.applyBatch.
    // Prefer existing native Term objects (objectTerm / predicateTerm) when present.
    const rdfTypePred = typeof (mgr as any).expandPrefix === "function"
      ? String((mgr as any).expandPrefix("rdf:type"))
      : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

    const valueToTerm = (val: any, type?: string) => {
      try {
        const s = typeof val === "string" ? String(val) : String(val || "");
        if (/^_:/i.test(s)) return blankNode(s.replace(/^_:/, ""));

        // If type is a language marker like "@en", create a language-tagged literal
        if (type && String(type).trim() && String(type).startsWith("@")) {
          const lang = String(type).slice(1);
          return literal(s, lang);
        }

        // If a datatype is provided prefer it (expand prefixed types if manager supports it)
        if (type && String(type).trim()) {
          try {
            const maybePref = String(type).trim();
            const dtIri =
              typeof (mgr as any).expandPrefix === "function"
                ? String((mgr as any).expandPrefix(maybePref))
                : maybePref;
            return literal(s, namedNode(dtIri));
          } catch (_) {
            // fallthrough to typed literal by string
            try {
              return literal(s, namedNode(String(type)));
            } catch (_) {
              // continue
            }
          }
        }

        // Treat any scheme-like string (urn:, http:, https:, etc.) as a NamedNode.
        if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return namedNode(s);
        // Fallback: literal (no datatype)
        return literal(s);
      } catch (_) {
        return literal(String(val || ""));
      }
    };

    const removesPrepared = (propsToRemove || []).map((p: any) => {
      try {
        const objTerm = p && p.objectTerm && (p.objectTerm.termType || p.objectTerm.termType === 0)
          ? p.objectTerm
          : valueToTerm(p.value, p.lang ? `@${p.lang}` : p.type);
        const pred = String(p.key || p.property || (p.predicateTerm && p.predicateTerm.value) || "");
        return {
          subject: subjIri,
          predicate: pred,
          object: objTerm,
        };
      } catch (_) {
        return { subject: subjIri, predicate: String(p.key || p.property || ""), object: literal(String(p.value || "")) };
      }
    });

    // RDF type removals (use NamedNode for types)
    for (const t of typesToRemove || []) {
      try {
        const typeFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(String(t))) : String(t);
        removesPrepared.push({ subject: subjIri, predicate: rdfTypePred, object: namedNode(typeFull) });
      } catch (_) { /* ignore per-item */ }
    }

    const addsPrepared = (propsToAdd || []).map((p: any) => {
      try {
        const objTerm = p && p.objectTerm && (p.objectTerm.termType || p.objectTerm.termType === 0)
          ? p.objectTerm
          : valueToTerm(p.value, p.lang ? `@${p.lang}` : p.type);
        const pred = String(p.key || p.property || (p.predicateTerm && p.predicateTerm.value) || "");
        return {
          subject: subjIri,
          predicate: pred,
          object: objTerm,
        };
      } catch (_) {
        return { subject: subjIri, predicate: String(p.key || p.property || ""), object: literal(String(p.value || "")) };
      }
    });

    for (const t of typesToAdd || []) {
      try {
        const typeFull = typeof (mgr as any).expandPrefix === "function" ? String((mgr as any).expandPrefix(String(t))) : String(t);
        addsPrepared.push({ subject: subjIri, predicate: rdfTypePred, object: namedNode(typeFull) });
      } catch (_) { /* ignore per-item */ }
    }
    // Apply batch (manager will accept Term objects directly)
    try {
      await (mgr as any).applyBatch({ removes: removesPrepared, adds: addsPrepared }, "urn:vg:data");
    } catch (err) {
      try { console.warn("NodePropertyEditor.applyBatch.failed", err); } catch (_) { void 0; }
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
      throw err;
    }

    // Notify parent about saved properties.
    const annotationProperties = properties.map((p) => ({
      propertyUri: p.key,
      key: p.key,
      value: p.value,
      type: p.type || "xsd:string",
    }));

    // For create flows, provide a richer payload including the subject IRI (which
    // may be a generated blank node), selected class candidate and rdfTypes.
    if (isCreate) {
      const createPayload = {
        iri: subjIri,
        classCandidate: nodeType ? String(nodeType) : undefined,
        namespace: undefined,
        annotationProperties,
        rdfTypes: currentTypes || [],
      };
      if (typeof onSave === "function") onSave(createPayload);
    } else {
      // Preserve existing contract for edit flows (legacy behavior)
      if (typeof onSave === "function") onSave(annotationProperties);
    }

    // Close dialog (manager already emits change notifications)
    onOpenChange(false);

    // Update initial snapshots so subsequent edits compute diffs relative to latest saved state
    { initialPropertiesRef.current = (properties || []).map(p => ({ ...p })); }
    { initialRdfTypesRef.current = (currentTypes || []).slice(); }
    try { canvasActions.setLoading(false, 0, ""); } catch (_) {}
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
    { if (typeof onDelete === "function") onDelete(String(nodeIri)); }
    onOpenChange(false);
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
        className="sm:max-w-2xl max-h-[90vh] max-w-[min(90vw,48rem)] overflow-y-auto text-foreground"
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
              <EntityAutoComplete
                mode="classes"
                optionsLimit={5}
                value={nodeType}
                onChange={(ent: any) => { const val = ent ? String(ent.iri || '') : ''; setNodeType(val); setRdfTypesState(val ? [val] : []); }}
                placeholder="Type to search for classes..."
                emptyMessage="No OWL classes found. Load an ontology first."
                className="w-full"
              />
              {nodeType && !availableClasses.find(e => (String(e.iri || '') === String(nodeType))) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground">
                      <Info className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent side="top">
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
                    <EntityAutoComplete
                      mode="properties"
                      value={property.key}
                      onChange={(ent) => handleUpdateProperty(index, "key", ent ? String(ent.iri || '') : "")}
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

                  <div className="col-span-1">
                    <Label className="text-xs">Type</Label>
                    <Select value={property.type || "xsd:string"} onValueChange={(value) => {
                      // when changing type away from xsd:string, clear lang
                      handleUpdateProperty(index, "type", value);
                      if (String(value) !== "xsd:string") handleUpdateProperty(index, "lang", "");
                    }}>
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

                  {property.type === "xsd:string" && (
                    <div className="col-span-1">
                      <Label className="text-xs">Lang</Label>
                      <Input
                        value={property.lang || ""}
                        onChange={(e) => {
                          const v = String(e.target.value || "").trim();
                          // if lang set, ensure type is xsd:string
                          if (v) {
                            handleUpdateProperty(index, "lang", v);
                            handleUpdateProperty(index, "type", "xsd:string");
                          } else {
                            handleUpdateProperty(index, "lang", "");
                          }
                        }}
                        placeholder="en"
                        className="w-full"
                      />
                    </div>
                  )}

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
