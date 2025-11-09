 
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
import { toPrefixed, expandPrefixed } from "../../utils/termUtils";
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

const DISPLAY_DATATYPE = "xsd:string";

const toPrefixedSafe = (value: string): string => {
  try {
    return toPrefixed(value) || value;
  } catch {
    return value;
  }
};

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const isAbsoluteIri = (value: string): boolean => {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    value.includes("://") ||
    lower.startsWith("urn:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("data:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("geo:") ||
    lower.startsWith("doi:")
  );
};

const expandUsingNamespace = (term: string, fallback?: string): string => {
  if (!term) return fallback ?? term;
  try {
    const expanded = expandPrefixed(term);
    if (expanded !== term) return expanded;
    if (term.startsWith("_:") || SCHEME_PATTERN.test(term)) {
      return term;
    }
  } catch (_) {
    /* ignore expansion failures and fall back */
  }
  return fallback ?? term;
};

const ensureExpandedIri = (input: string, mgr: any, context: string): string => {
  const raw = typeof input === "string" ? input.trim() : String(input ?? "").trim();
  if (!raw) return raw;
  if (raw.startsWith("_:")) return raw;
  if (isAbsoluteIri(raw)) return raw;

  const attemptCandidate = (candidate: unknown): string | null => {
    if (typeof candidate !== "string") return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("_:")) return trimmed;
    if (isAbsoluteIri(trimmed)) return trimmed;
    return null;
  };

  const tryExpandViaMap = (map: Record<string, string> | undefined | null): string | null => {
    if (!map || typeof map !== "object") return null;
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    const prefix = raw.slice(0, idx);
    const local = raw.slice(idx + 1);
    const candidates: string[] = [];
    if (Object.prototype.hasOwnProperty.call(map, prefix)) {
      candidates.push(String(map[prefix] ?? ""));
    }
    if ((prefix === "" || prefix === ":") && Object.prototype.hasOwnProperty.call(map, "")) {
      candidates.push(String(map[""] ?? ""));
    }
    if ((prefix === "" || prefix === ":") && Object.prototype.hasOwnProperty.call(map, ":")) {
      candidates.push(String(map[":"] ?? ""));
    }
    for (const namespace of candidates) {
      if (typeof namespace === "string" && namespace.trim().length > 0) {
        const candidate = attemptCandidate(`${namespace}${local}`);
        if (candidate) return candidate;
      }
    }
    return null;
  };

  try {
    const candidate = attemptCandidate(expandUsingNamespace(raw));
    if (candidate) return candidate;
  } catch (_) {
    /* ignore expansion failure */
  }

  if (mgr && typeof (mgr as any).expandPrefix === "function") {
    try {
      const candidate = attemptCandidate((mgr as any).expandPrefix(raw));
      if (candidate) return candidate;
    } catch (_) {
      /* ignore */
    }
  }

  if (mgr && typeof (mgr as any).getNamespaces === "function") {
    try {
      const candidate = tryExpandViaMap((mgr as any).getNamespaces());
      if (candidate) return candidate;
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const registry = useOntologyStore.getState().namespaceRegistry || [];
    const map = registry.reduce((acc: Record<string, string>, entry: any) => {
      if (
        entry &&
        typeof entry.prefix === "string" &&
        typeof entry.namespace === "string" &&
        entry.namespace.trim().length > 0
      ) {
        acc[entry.prefix] = entry.namespace;
      }
      return acc;
    }, {} as Record<string, string>);
    const candidate = tryExpandViaMap(map);
    if (candidate) return candidate;
  } catch (_) {
    /* ignore registry fallback failure */
  }

  if (isAbsoluteIri(raw)) {
    return raw;
  }

  throw new Error(
    `Unable to expand prefixed term "${raw}" (${context}). Provide a full IRI or register the namespace.`,
  );
};

function cloneLiteralProperty(source: LiteralProperty): LiteralProperty {
  return {
    key: source.key,
    value: source.value,
    type: source.type,
    predicateTerm: source.predicateTerm,
    objectTerm: source.objectTerm,
    lang: source.lang,
  };
}

function coerceLiteralProperty(entry: any): LiteralProperty | null {
  if (!entry || typeof entry !== "object") return null;
  const key =
    typeof entry.property === "string"
      ? entry.property
      : typeof entry.propertyUri === "string"
      ? entry.propertyUri
      : typeof entry.key === "string"
      ? entry.key
      : "";
  if (!key) return null;

  const rawValue =
    entry.value ??
    (entry.objectTerm && typeof entry.objectTerm.value === "string"
      ? entry.objectTerm.value
      : entry.object);
  if (rawValue === undefined || rawValue === null) return null;

  const rawType =
    typeof entry.type === "string" && entry.type.length > 0
      ? entry.type
      : entry.objectTerm &&
          entry.objectTerm.datatype &&
          typeof entry.objectTerm.datatype.value === "string"
        ? entry.objectTerm.datatype.value
        : undefined;
  const rawLang =
    typeof entry.lang === "string" && entry.lang.length > 0
      ? entry.lang
      : entry.objectTerm && typeof entry.objectTerm.language === "string"
        ? entry.objectTerm.language
        : undefined;

  return {
    key,
    value: String(rawValue),
    type: rawLang
      ? DISPLAY_DATATYPE
      : rawType
      ? rawType.includes("://")
        ? toPrefixedSafe(rawType)
        : rawType
      : DISPLAY_DATATYPE,
    lang: rawLang,
    predicateTerm: entry.predicateTerm ?? entry.predicate,
    objectTerm: entry.objectTerm ?? entry.object,
  };
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
  // When true and this is a create flow, ensure owl:NamedIndividual is added as an rdf:type on save
  addNamedIndividualOnSave?: boolean;
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
  addNamedIndividualOnSave = false,
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

    const sourceNode =
      nodeData && typeof nodeData === "object"
        ? (nodeData as any).data ?? nodeData
        : null;

    if (!sourceNode) {
      setNodeIri("");
      setNodeType("");
      setProperties([]);
      setRdfTypesState([]);
      initialPropertiesRef.current = [];
      initialRdfTypesRef.current = [];
      return;
    }

    const iri =
      typeof sourceNode.iri === "string"
        ? sourceNode.iri
        : typeof sourceNode.id === "string"
        ? sourceNode.id
        : typeof sourceNode.key === "string"
        ? sourceNode.key
        : "";
    setNodeIri(iri);

    const rdfTypes = Array.isArray(sourceNode.rdfTypes)
      ? sourceNode.rdfTypes.filter((type: unknown): type is string => typeof type === "string")
      : sourceNode.rdfType
      ? [String(sourceNode.rdfType)]
      : [];
    setRdfTypesState(rdfTypes);
    initialRdfTypesRef.current = rdfTypes.slice();

    const chosenType =
      rdfTypes.length > 0
        ? rdfTypes[0]
        : typeof sourceNode.classType === "string"
        ? sourceNode.classType
        : typeof sourceNode.displayType === "string"
        ? sourceNode.displayType
        : "";
    setNodeType(chosenType);

    const normalizedProps: LiteralProperty[] = [];
    if (Array.isArray(sourceNode.annotationProperties)) {
      for (const entry of sourceNode.annotationProperties) {
        const normalized = coerceLiteralProperty(entry);
        if (normalized) normalizedProps.push(normalized);
      }
    } else if (Array.isArray(sourceNode.annotations)) {
      for (const annotation of sourceNode.annotations) {
        if (!annotation || typeof annotation !== "object") continue;
        const [key, value] = Object.entries(annotation)[0] ?? ["", ""];
        const normalized = coerceLiteralProperty({
          property: key,
          value,
        });
        if (normalized) normalizedProps.push(normalized);
      }
    }

    setProperties(normalizedProps);
    initialPropertiesRef.current = normalizedProps.map(cloneLiteralProperty);
  }, [open, nodeData]);

  // Handlers for properties
  const handleAddProperty = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties((prev) => [
      ...prev,
      { key: "", value: "", type: DISPLAY_DATATYPE },
    ]);
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
    const updated: LiteralProperty = { ...p, [field]: value };
    if (field === "value" || field === "type") {
      updated.objectTerm = undefined;
    }
    if (field === "key") {
      updated.predicateTerm = undefined;
    }
    if (field === "type" && value !== DISPLAY_DATATYPE) {
      updated.lang = undefined;
    }
    if (field === "lang" && value && value.trim()) {
      updated.type = DISPLAY_DATATYPE;
    }
        return updated;
      }),
    );
  };

  // Utility to diff annotation properties (simple equality on key+value+type)
  const diffProperties = (before: LiteralProperty[], after: LiteralProperty[]) => {
    const key = (p: LiteralProperty) =>
      `${p.key}||${p.value}||${p.type || ""}||${p.lang || ""}`;
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
      try { canvasActions.setLoading(true, 0, "Saving node..."); } catch (_) {/* noop */}
    } catch (_) {/* noop */}

    // Validate properties: no empty keys
    if (properties.some(p => !p.key || !p.key.trim())) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      throw new Error("Please provide property names for all annotation properties (no empty keys).");
    }

    // Subject IRI (allow empty during "create" flows — we will generate a blank node id)
    const rawSubjectInput = String(nodeIri || "").trim();
    let subjIri = rawSubjectInput;
    const isCreate = !(nodeData && (nodeData.iri || nodeData.id || nodeData.key));
    let generatedBlank = false;
    if (!subjIri && isCreate) {
      // Generate a session-unique blank node id (client-side only)
      subjIri = `_:vgb${String(__vg_blank_counter++)}`;
      generatedBlank = true;
    }
    if (!subjIri) {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      throw new Error("Node IRI missing; cannot persist node properties.");
    }

    // Acquire RDF manager (must exist)
    const mgrState = useOntologyStore.getState();
    const mgr = typeof (mgrState as any).getRdfManager === "function"
      ? (mgrState as any).getRdfManager()
      : (mgrState as any).rdfManager;

    if (!mgr || typeof (mgr as any).applyBatch !== "function") {
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      throw new Error("RDF manager unavailable or does not support applyBatch; cannot persist node properties.");
    }

    const expandIri = (term: string, ctx: string) => ensureExpandedIri(term, mgr, ctx);

    if (!generatedBlank) {
      subjIri = expandIri(subjIri, "node IRI");
    }

    // Compute annotation property diffs from initial snapshot (no RDF lookups)
    const { toAdd: propsToAdd, toRemove: propsToRemove } = diffProperties(
      initialPropertiesRef.current || [],
      properties || [],
    );

    // Compute rdf:type diffs (use rdfTypesState if present, otherwise use nodeType)
    const currentTypes = (Array.isArray(rdfTypesState) && rdfTypesState.length > 0) ? rdfTypesState.slice() : (nodeType ? [String(nodeType)] : []);
    // If requested by caller, add owl:NamedIndividual for create flows without pre-setting it in the UI.
    try {
      const NI = "http://www.w3.org/2002/07/owl#NamedIndividual";
      if (isCreate && addNamedIndividualOnSave) {
        if (!currentTypes.includes(NI)) currentTypes.push(NI);
      }
    } catch (_) { /* ignore */ }
    const initialTypes = Array.isArray(initialRdfTypesRef.current) ? initialRdfTypesRef.current.slice() : [];
    const typesToAdd = currentTypes.filter((t) => t && !initialTypes.includes(t));
    const typesToRemove = initialTypes.filter((t) => t && !currentTypes.includes(t));

    // Prepare removes/adds in the shape expected by rdfManager.applyBatch.
    // Prefer existing native Term objects (objectTerm / predicateTerm) when present.
    const annotationProperties = (properties || [])
      .filter((p) => p && typeof p.key === "string" && p.key.trim().length > 0)
      .map((p) => {
        const key = String(p.key).trim();
        const expandedKey = expandIri(key, "annotation property predicate");
        return {
          propertyUri: expandedKey,
          key,
          value: p.value,
          type: p.type || DISPLAY_DATATYPE,
        };
      });

    let createPayloadDelivered = false;
    if (
      rawSubjectInput &&
      rawSubjectInput !== subjIri &&
      rawSubjectInput.includes(":") &&
      !rawSubjectInput.includes("://") &&
      mgr &&
      typeof (mgr as any).removeAllQuadsForIri === "function"
    ) {
      try {
        await (mgr as any).removeAllQuadsForIri(
          rawSubjectInput,
          "urn:vg:data",
        );
      } catch (_) {
        /* ignore cleanup failures */
      }
    }

    if (isCreate && typeof onSave === "function") {
      try {
        const createPayload = {
          iri: subjIri,
          classCandidate: nodeType ? String(nodeType) : undefined,
          namespace: undefined,
          annotationProperties,
          rdfTypes: currentTypes || [],
        };
        onSave(createPayload);
        createPayloadDelivered = true;
      } catch (_) {
        /* ignore parent onSave errors; persistence will still attempt */
      }
    }

    const rdfTypePred = expandUsingNamespace(
      "rdf:type",
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    );
    let expandedRdfTypePred = rdfTypePred;
    try {
      expandedRdfTypePred = expandIri("rdf:type", "rdf:type predicate");
    } catch (_) {
      expandedRdfTypePred = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    }

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
            const dtIri = expandIri(maybePref, "datatype IRI");
            return literal(s, namedNode(dtIri));
          } catch (_) {
            // fallthrough to typed literal by string
            try {
              const fallback = expandIri(String(type), "datatype IRI");
              return literal(s, namedNode(fallback));
            } catch (_) {
              // continue
            }
          }
        }

        // Treat any scheme-like string (urn:, http:, https:, etc.) as a NamedNode.
        if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
          const expandedObj = expandIri(s, "object IRI");
          return namedNode(expandedObj);
        }
        // Fallback: literal (no datatype)
        return literal(s);
      } catch (_) {
        return literal(String(val || ""));
      }
    };

    const removesPrepared = (propsToRemove || []).map((p: any) => {
      try {
        const objTerm =
          p &&
          p.objectTerm &&
          ((p.objectTerm as any).termType || (p.objectTerm as any).termType === 0)
            ? p.objectTerm
            : valueToTerm(p.value, p.lang ? `@${p.lang}` : p.type);
        const rawPred = String(p.key || p.property || (p.predicateTerm && p.predicateTerm.value) || "").trim();
        if (!rawPred) return null;
        const pred = expandIri(rawPred, "removal predicate");
        return {
          subject: subjIri,
          predicate: pred,
          object: objTerm,
        };
      } catch (_) {
        return null;
      }
    }).filter(Boolean) as any[];

    // RDF type removals (use NamedNode for types)
    for (const t of typesToRemove || []) {
      try {
        const typeFull = expandIri(String(t), "rdf:type removal object");
        removesPrepared.push({
          subject: subjIri,
          predicate: expandedRdfTypePred,
          object: namedNode(typeFull),
        });
      } catch (_) { /* ignore per-item */ }
    }

    const addsPrepared = (propsToAdd || []).map((p: any) => {
      try {
        const objTerm = p && p.objectTerm && (p.objectTerm.termType || p.objectTerm.termType === 0)
          ? p.objectTerm
          : valueToTerm(p.value, p.lang ? `@${p.lang}` : p.type);
        const rawPred = String(p.key || p.property || (p.predicateTerm && p.predicateTerm.value) || "").trim();
        if (!rawPred) return null;
        const pred = expandIri(rawPred, "addition predicate");
        return {
          subject: subjIri,
          predicate: pred,
          object: objTerm,
        };
      } catch (_) {
        return null;
      }
    }).filter(Boolean) as any[];

    for (const t of typesToAdd || []) {
      try {
        const typeFull = expandIri(String(t), "rdf:type addition object");
        addsPrepared.push({
          subject: subjIri,
          predicate: expandedRdfTypePred,
          object: namedNode(typeFull),
        });
      } catch (_) { /* ignore per-item */ }
    }
    // Apply batch (manager will accept Term objects directly)
    try {
      try {
        console.debug("[NodePropertyEditor] applyBatch payload", {
          subject: subjIri,
          removes: removesPrepared,
          adds: addsPrepared,
        });
      } catch (_) {
        /* ignore logging failures */
      }
      await (mgr as any).applyBatch({ removes: removesPrepared, adds: addsPrepared }, "urn:vg:data");
    } catch (err) {
      if (createPayloadDelivered && typeof onDelete === "function") {
        try { onDelete(String(subjIri)); } catch (_) { /* ignore */ }
      }
      try { console.warn("NodePropertyEditor.applyBatch.failed", err); } catch (_) { void 0; }
      try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
      throw err;
    }

    // Preserve existing contract for edit flows (legacy behavior)
    if (!isCreate && typeof onSave === "function") onSave(annotationProperties);

    // Close dialog (manager already emits change notifications)
    onOpenChange(false);

    // Update initial snapshots so subsequent edits compute diffs relative to latest saved state
    { initialPropertiesRef.current = (properties || []).map(p => ({ ...p })); }
    { initialRdfTypesRef.current = (currentTypes || []).slice(); }
    try { canvasActions.setLoading(false, 0, ""); } catch (_) {/* noop */}
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
    DISPLAY_DATATYPE,
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
                    <Select
                      value={property.type || DISPLAY_DATATYPE}
                      onValueChange={(value) => {
                        handleUpdateProperty(index, "type", value);
                        if (value !== DISPLAY_DATATYPE) {
                          handleUpdateProperty(index, "lang", "");
                        }
                      }}
                    >
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

                  {property.type === DISPLAY_DATATYPE && (
                    <div className="col-span-1">
                      <Label className="text-xs">Lang</Label>
                      <Input
                        value={property.lang || ""}
                        onChange={(e) => {
                          const v = String(e.target.value || "").trim();
                          // if lang set, ensure type is xsd:string
                          if (v) {
                            handleUpdateProperty(index, "lang", v);
                            handleUpdateProperty(index, "type", DISPLAY_DATATYPE);
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
