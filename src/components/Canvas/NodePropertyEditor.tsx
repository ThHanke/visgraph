/* eslint-disable react-refresh/only-export-components */
/**
 * @fileoverview Enhanced Node Property Editor
 * Allows editing of node type, IRI, and annotation properties with proper XSD type support
 * Handles multiple rdf:types correctly for A-box individuals
 */

import { useState, useEffect, useMemo } from 'react';
import { debug, fallback } from '../../utils/startupDebug';
import { computeDisplayInfoMemo, clearDisplayInfoCache, computeBadgeText } from './core/nodeDisplay';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { AutoComplete } from '../ui/AutoComplete';
import { EntityAutocomplete } from '../ui/EntityAutocomplete';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { useOntologyStore } from '../../stores/ontologyStore';
import { X, Plus, Info } from 'lucide-react';
import { deriveInitialNodeType } from './helpers/nodePropertyHelpers';
export { deriveInitialNodeType };

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
  nodeData: any;
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
 * Enhanced node property editor that allows changing type and editing annotation properties
 */
export const NodePropertyEditor = ({ 
  open, 
  onOpenChange, 
  nodeData, 
  onSave,
  availableEntities 
}: NodePropertyEditorProps) => {
  const [nodeType, setNodeType] = useState('');
  const [nodeIri, setNodeIri] = useState('');
  const [properties, setProperties] = useState<LiteralProperty[]>([]);
  // Keep track of all rdf types for the entity so the form preserves multiple types
  const [rdfTypesState, setRdfTypesState] = useState<string[]>([]);
  
  const { availableClasses, getRdfManager } = useOntologyStore();
  const [extraClassFromRdf, setExtraClassFromRdf] = useState<any | null>(null);
  
  // Memoize classEntities to prevent constant re-creation.
  // Combine provided availableEntities with ontologyStore.availableClasses as a fallback so
  // the editor can resolve short labels or full URIs even when the UI-provided entity list is empty.
  const classEntities = useMemo(() => {
    const fromEntities = (availableEntities || []).filter(e => e.rdfType === 'owl:Class');
    const fromStore = (availableClasses || []).map(cls => ({
     iri: cls.iri,
      label: cls.label,
      namespace: cls.namespace || '',
      rdfType: 'owl:Class'
    }));

    // Merge by uri, preferring entries from availableEntities when present.
    const merged = new Map<string, any>();
    // Add store entries first
    fromStore.forEach(e => { if (e && e.iri) merged.set(e.iri, e); });
    // Override with explicit availableEntities entries if they exist
    fromEntities.forEach(e => { if (e && e.iri) merged.set(e.iri, e); });

    return Array.from(merged.values());
  }, [availableEntities, availableClasses]);

  // If we discover a class definition in the RDF store (labels, comments), include it as a temporary
  // class entity so the autocomplete and editor can show a meaningful label even when the ontology
  // meta hasn't been loaded into availableClasses.
  const classEntitiesCombined = extraClassFromRdf ? [extraClassFromRdf, ...(classEntities || [])] : classEntities;

  // Helper to prefer prefixed form (prefix:LocalName) using rdfManager namespaces, falling back to short label.
  const getDisplayLabelFromUri = (uri?: string) => {
    if (!uri) return '';
    const mgr = getRdfManager && getRdfManager();
    try {
      const ns = mgr?.getNamespaces ? mgr.getNamespaces() : {};
      for (const [prefix, nsUri] of Object.entries(ns || {})) {
      if (nsUri && uri.startsWith(nsUri)) {
          const local = uri.substring(nsUri.length);
          return `${prefix}:${local}`;
        }
      }
    } catch (e) { void e; }
    // fallback short label
    if (/^https?:\/\//i.test(uri)) {
      const parts = uri.split(new RegExp('[#/]')).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : uri;
    }
    if (uri.includes(':')) {
      const parts = uri.split(':');
      return parts[parts.length - 1];
    }
    const parts = uri.split(new RegExp('[#/]')).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : uri;
  };

  // Initialize form data when dialog opens
  useEffect(() => {
    if (open && nodeData) {

      // Normalize node data whether it uses the legacy shape or the new canonical shape
      const d = (nodeData && (nodeData.data || nodeData)) || {};

      // Determine initial node type using shared helper so it's testable and consistent
      const initialNodeType = deriveInitialNodeType(d, classEntities);

      // Normalize the derived type so it matches the URIs used by EntityAutocomplete.
      // Many sources may provide full HTTP URIs, prefixed names (foaf:Person), or short labels ("Person").
      // EntityAutocomplete expects the value to be an entity.iri from availableEntities (often prefixed).
      let normalizedNodeType = initialNodeType || '';

      if (initialNodeType) {
        const shortLabel = initialNodeType.includes(':')
          ? String(initialNodeType).split(':').pop() || String(initialNodeType)
          : (String(initialNodeType).split(new RegExp('[#/]')).pop() || initialNodeType);

        const match = classEntities.find(e =>
          e.iri === initialNodeType ||
          e.label === initialNodeType ||
          e.label === shortLabel ||
          (typeof e.iri === 'string' && (
            e.iri === `${shortLabel}` ||
            e.iri.endsWith(`/${shortLabel}`) ||
            e.iri.endsWith(`#${shortLabel}`) ||
            e.iri.endsWith(`:${shortLabel}`)
          ))
        );

        if (match) {
          normalizedNodeType = match.iri;
        } else {
          // If no exact match, prefer a prefixed form if the initial type looks like a full HTTP URI
          // and any classEntity.iri contains the short label with a colon (prefixed).
          if (/^https?:\/\//i.test(initialNodeType)) {
            const prefixedMatch = classEntities.find(e => {
              const l = e.iri.split(':').pop();
              return l === shortLabel;
            });
            if (prefixedMatch) normalizedNodeType = prefixedMatch.iri;
          }
        }
      }

      // If we still don't have a normalized type, or it is the literal 'NamedIndividual',
      // attempt to read rdf:type triples from the RDF manager. This covers cases where
      // the parsed/diagram node stores 'NamedIndividual' in classType or type fields.
      if (( !normalizedNodeType || String(normalizedNodeType).includes('NamedIndividual') ) && d.iri && typeof getRdfManager === 'function') {
        try {
          const manager = getRdfManager();
          const store = manager?.getStore?.();
          if (store) {
            // Prefer the expanded rdf:type IRI when available from the manager
            let rdfTypeIri = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
            try { rdfTypeIri = manager.expandPrefix ? manager.expandPrefix('rdf:type') : rdfTypeIri; } catch (e) { void e; }
            const all = store.getQuads(null, null, null, null) || [];
            const typeQuads = all.filter((q: any) =>
              q.subject && (q.subject.value === d.iri || q.subject.value === (d.iri || d.iri)) &&
              q.predicate && q.predicate.value === rdfTypeIri
            );
            // Diagnostic: expose the exact quads found so we can debug prefix/expansion issues
            try {
              ((...__vg_args)=>{try{debug('console.debug',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.debug(...__vg_args);})('NodePropertyEditor: rdf type quads for', d.iri, typeQuads.map((q: any) => ({
                predicate: q.predicate && q.predicate.value,
                object: q.object && (q.object.value || (q.object.id || null))
              })));
            } catch (diagErr) {
              void diagErr;
            }
            const foundTypes = Array.from(new Set(typeQuads.map((q: any) => (q.object && q.object.value)).filter(Boolean))) as string[];
            // only consider non-NamedIndividual types as meaningful
            let meaningful = foundTypes.filter((t) => typeof t === 'string' && t && !t.includes('NamedIndividual'));

            // If none found via direct rdf:type matching, attempt a tolerant fallback:
            // - look for any quads with the subject and an object whose local name or suffix matches the node's short label.
            // This covers cases where prefixes/namespaces weren't registered or rdf:type used a prefixed name that didn't expand.
            if (meaningful.length === 0) {
              try {
                  const shortLabelForNode = d.localName || (d.iri || d.iri || '').split(new RegExp('[#/]')).pop() || '';
                  const subjectQuads = all.filter((q: any) =>
                  q.subject && (q.subject.value === d.iri || q.subject.value === (d.iri || d.iri))
                );
                const candidateTypes = subjectQuads
                  .map((q: any) => q.object && q.object.value)
                  .filter(Boolean)
                  .filter((v: string) => {
                    const vShort = v.includes(':') ? v.split(':').pop() : (v.split(new RegExp('[#/]')).pop() || v);
                    return vShort === shortLabelForNode || v.endsWith(`/${shortLabelForNode}`) || v.endsWith(`#${shortLabelForNode}`) || v.includes(`:${shortLabelForNode}`);
                  });
                meaningful = Array.from(new Set(candidateTypes));
              } catch (fallbackErr) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(fallbackErr) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
            }

            // If there are meaningful (non-NamedIndividual) types, pick the first.
            const chosen: string | undefined = meaningful.length > 0 ? meaningful[0] : undefined;
            if (typeof chosen === 'string' && chosen) {
              // Resolve chosen to a known classEntity if possible (match by full uri or short label)
                  const shortLabel = chosen.includes(':')
                    ? String(chosen).split(':').pop() || String(chosen)
                    : (String(chosen).split(new RegExp('[#/]')).pop() || String(chosen));
              const match = classEntities.find(e =>
                e.iri === chosen ||
                e.label === chosen ||
                e.label === shortLabel ||
                (typeof e.iri === 'string' && (
                  e.iri.endsWith(`/${shortLabel}`) ||
                  e.iri.endsWith(`#${shortLabel}`) ||
                  e.iri.endsWith(`:${shortLabel}`)
                ))
              );
              if (match) {
                normalizedNodeType = match.iri;
              } else {
                // Try to expand prefixed names via manager, otherwise use raw chosen value.
                if (typeof manager?.expandPrefix === 'function' && String(chosen).includes(':')) {
                  try {
                    const expanded = manager.expandPrefix(chosen);
                    normalizedNodeType = expanded || chosen;
                  } catch {
                    normalizedNodeType = chosen;
                  }
                } else {
                  normalizedNodeType = chosen;
                }
              }
            }
          }
        } catch (err) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(err) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      }

      // If normalizedNodeType is an owl:NamedIndividual marker, try one more time to find a non-NI rdf:type.
      if (normalizedNodeType && String(normalizedNodeType).includes('NamedIndividual')) {
        // Prefer any preserved rdfTypes on the node that are non-NI
        const nodeProvidedTypes = Array.isArray(d.rdfTypes) ? d.rdfTypes.slice() : (d.rdfType ? [d.rdfType] : []);
        const nonNiFromNode = nodeProvidedTypes.find((t: any) => t && !String(t).includes('NamedIndividual'));
        if (nonNiFromNode) {
          normalizedNodeType = nonNiFromNode;
        } else {
          // Try reading from RDF manager again to find any non-NI type
          try {
            const manager = getRdfManager && getRdfManager();
            const store = manager?.getStore?.();
            if (store && d.iri) {
              // Prefer expanded rdf:type if possible
              let rdfTypeIri = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
              try { rdfTypeIri = manager.expandPrefix ? manager.expandPrefix('rdf:type') : rdfTypeIri; } catch (e) { void e; }
              const all = store.getQuads(null, null, null, null) || [];
              const typeQuads = all.filter((q: any) =>
                q.subject && (q.subject.value === d.iri || q.subject.value === (d.iri || d.iri)) &&
                q.predicate && q.predicate.value === rdfTypeIri
              );
              const foundTypes = Array.from(new Set(typeQuads.map((q: any) => (q.object && q.object.value)).filter(Boolean))) as string[];
              const meaningful = foundTypes.filter((t) => typeof t === 'string' && t && !t.includes('NamedIndividual'));
              if (meaningful.length > 0) normalizedNodeType = meaningful[0];
              else normalizedNodeType = '';
            } else {
              normalizedNodeType = '';
            }
          } catch {
            normalizedNodeType = '';
          }
        }
      }

      // Ensure we never expose a pure NamedIndividual marker as the "meaningful" node type.
      // Some sources only provide owl:NamedIndividual; showing that in the editor is incorrect.
      if (normalizedNodeType && /NamedIndividual\b/i.test(String(normalizedNodeType))) {
        normalizedNodeType = '';
      }

      try {
        // Compute display info (memoized). Do NOT clear the cache here on every render
        // — clearing the cache too often results in losing namespace mappings and empty badges.
        try {
          computeDisplayInfoMemo(d, getRdfManager && getRdfManager(), classEntities);
        } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }
      } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } }

      // If the normalizedNodeType is not part of the known classEntities, attempt to look it up
      // in the RDF store for rdfs:label / skos:prefLabel / rdfs:comment so the editor can present
      // a friendly label instead of only showing "not loaded".
      if (normalizedNodeType && !classEntities.find(e => e && e.iri === normalizedNodeType)) {
        try {
          const manager = getRdfManager && getRdfManager();
          const store = manager?.getStore?.();
          if (store) {
            const all = store.getQuads(null, null, null, null) || [];
            const rdfsLabelIri = (manager && typeof manager.expandPrefix === 'function') ? (() => { try { return manager.expandPrefix('rdfs:label'); } catch { return 'http://www.w3.org/2000/01/rdf-schema#label'; } })() : 'http://www.w3.org/2000/01/rdf-schema#label';
            const skosPrefLabelIri = (manager && typeof manager.expandPrefix === 'function') ? (() => { try { return manager.expandPrefix('skos:prefLabel'); } catch { return 'http://www.w3.org/2004/02/skos/core#prefLabel'; } })() : 'http://www.w3.org/2004/02/skos/core#prefLabel';
            const predicates = [rdfsLabelIri, skosPrefLabelIri];

            let foundLabel: string | undefined;
            for (const q of all) {
              try {
                if (q.subject && q.subject.value === normalizedNodeType && q.predicate && predicates.includes(q.predicate.value) && q.object && q.object.value) {
                  foundLabel = String(q.object.value);
                  break;
                }
              } catch { /* ignore per-quad */ }
            }

            if (!foundLabel) {
              // Fallback: look for any quad with this subject and pull the object's short name
              const subjectQuads = all.filter((q: any) => q.subject && q.subject.value === normalizedNodeType);
              if (subjectQuads.length > 0) {
                const firstObj = subjectQuads.find((q: any) => q.object && q.object.value);
                if (firstObj) {
                  const v = String(firstObj.object.value);
                  const short = v.includes(':') ? v.split(':').pop() : (String(v).split(new RegExp('[#/]')).pop() || v);
                  foundLabel = short;
                }
              }
            }

            if (foundLabel) {
              setExtraClassFromRdf({
               iri: normalizedNodeType,
                label: foundLabel,
                namespace: ''
              });
            } else {
              setExtraClassFromRdf(null);
            }
          }
        } catch (err) {
          setExtraClassFromRdf(null);
        }
      } else {
        // Clear any previous temporary entry if a matching class exists or no type
        setExtraClassFromRdf(null);
      }

      setNodeType(normalizedNodeType);

      // IRI / URI
      setNodeIri(d.iri || d.iri || '');

      // Preserve any rdfTypes (array) or single rdfType value
      const initialRdfTypes = Array.isArray(d.rdfTypes) ? d.rdfTypes.slice() : (d.rdfType ? [d.rdfType] : []);
      setRdfTypesState(initialRdfTypes);

      // Convert annotation sources to form properties:
      // - canonical: d.annotations = [{ "rdfs:label": "value" }, ...]
      // - legacy: d.annotationProperties = [{ propertyUri, value, type }]
      const existingProps: LiteralProperty[] = [];

      if (Array.isArray(d.annotations)) {
        d.annotations.forEach((ann: any) => {
          if (ann && typeof ann === 'object') {
            const entry = (Object.entries(ann)[0] as [string, any]) || ['', ''];
            const key = String(entry[0] ?? '');
            const value = String(entry[1] ?? '');
            existingProps.push({ key, value, type: 'xsd:string' });
          }
        });
      } else if (Array.isArray(d.annotationProperties)) {
        d.annotationProperties.forEach((prop: any) => {
          existingProps.push({
            key: prop.property || prop.propertyUri || prop.key || '',
            value: prop.value,
            type: prop.type || 'xsd:string'
          });
        });
      }

      setProperties(existingProps);
    }
  }, [open, nodeData, classEntities, getRdfManager]);

  /**
   * Add a new property row
   */
  const handleAddProperty = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties([...properties, { key: '', value: '', type: 'xsd:string' }]);
  };

  /**
   * Remove a property by index
   */
  const handleRemoveProperty = (index: number, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setProperties(properties.filter((_, i) => i !== index));
  };

  /**
   * Update a property field by index
   */
  const handleUpdateProperty = (index: number, field: keyof LiteralProperty, value: string) => {
    const updated = properties.map((prop, i) => 
      i === index ? { ...prop, [field]: value } : prop
    );
    setProperties(updated);
  };

  /**
   * Save changes and close dialog
   */
  const handleSave = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    
    // Validate that all properties have keys
    const hasEmptyProperties = properties.some(prop => !prop.key.trim());
    if (hasEmptyProperties) {
      alert('Please provide a property name for all annotation properties or remove empty ones.');
      return;
    }
    
    // Convert URI back to label for classType if we have a matching entity
    const selectedEntity = classEntities.find(entity => entity.iri === nodeType);
    const classTypeLabel = selectedEntity ? selectedEntity.label : nodeType;

    // Build the updated rdfTypes array while preserving any existing additional types.
    // Strategy:
    //  - Start with any existing rdfTypes provided to the form (rdfTypesState)
    //  - Remove any NamedIndividual entries (we'll re-add it at the front for A-box individuals)
    //  - Ensure the chosen meaningful nodeType (full URI) is present and placed after NamedIndividual
    const existing = Array.isArray(rdfTypesState) ? rdfTypesState.slice() : [];
    const namedIndividualPresent = existing.some(t => t && t.includes('NamedIndividual'));
    const preserved = existing
      .filter(t => t && !t.includes('NamedIndividual') && t !== nodeType);

    // Compose final list:
    // - include owl:NamedIndividual only if it was present in the original rdfTypes
    // - then the meaningful chosen type (if any)
    // - then any other preserved types
    const finalTypes = Array.from(new Set([
      ...(namedIndividualPresent ? ['owl:NamedIndividual'] : []),
      ...(nodeType ? [nodeType] : []),
      ...preserved
    ].filter(Boolean)));

    const updatedNodeData = {
      ...nodeData,
      classType: classTypeLabel,
      type: classTypeLabel,
      displayType: nodeType, // Save the full URI as displayType
      rdfTypes: finalTypes, // Preserve multiple rdf types, with NamedIndividual preserved
     iri: nodeIri,
      iri: nodeIri,
      // Persist canonical annotation shape using propertyUri (store-friendly)
      annotationProperties: properties
        .filter((prop) => prop.key.trim())
        .map((prop) => ({
          propertyUri: prop.key,
          key: prop.key,
          value: prop.value,
          type: prop.type,
        })),
    };

    onSave(updatedNodeData);
    onOpenChange(false);
  };

  /**
   * Get common annotation properties for autocomplete
   */
  const getAnnotationProperties = () => {
    const commonProps = [
      'rdfs:label',
      'rdfs:comment',
      'dc:description',
      'dc:title',
      'dc:creator',
      'dc:date',
      'dc:identifier',
      'owl:sameAs',
      'skos:prefLabel',
      'skos:altLabel',
      'skos:definition'
    ];

    // Add class-specific properties from loaded ontologies
    const classSpecific = availableClasses
      .filter(cls => {
        if (!nodeType) return false;
        // nodeType may be a prefixed name (foaf:Person), a full HTTP URI, or a short label like "Person".
        // Match against several possibilities so class-specific properties are found whether the
        // form stores short labels, prefixed URIs, or full URIs.
        const shortLabel = nodeType.includes(':') ? nodeType.split(':').pop() : nodeType;
        return (
          cls.iri === nodeType ||
          cls.label === nodeType ||
          cls.label === shortLabel ||
          (typeof cls.iri === 'string' && (cls.iri.endsWith(`/${shortLabel}`) || cls.iri.endsWith(`#${shortLabel}`)))
        );
      })
      .flatMap(cls => cls.properties || []);

    return [...commonProps, ...classSpecific].map(prop => ({
      value: prop,
      label: prop
    }));
  };

  /**
   * Get available XSD data types
   */
  const getXSDTypes = () => [
    'xsd:string',
    'xsd:boolean',
    'xsd:integer',
    'xsd:decimal',
    'xsd:double',
    'xsd:float',
    'xsd:date',
    'xsd:dateTime',
    'xsd:time',
    'xsd:anyURI'
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent 
        className="sm:max-w-2xl max-h-[90vh] max-w-[min(90vw,48rem)] overflow-y-auto"
        onInteractOutside={(e) => {
          // Prevent closing when clicking on popover content
          const target = e.target as Element;
          if (target.closest('[data-radix-popper-content-wrapper]') || 
              target.closest('[data-radix-select-content]') ||
              target.closest('[cmdk-root]') ||
              target.closest('[data-radix-command]')) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit Node Properties</DialogTitle>
          <DialogDescription>
            Change the type, IRI, and annotation properties of this node.
            In A-box mode, owl:NamedIndividual is automatically maintained.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-6">
          {/* Node Type Selection */}
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
            {/* When class entity isn't loaded show a clear short/prefixed label next to the autocomplete */}
            {nodeType && !classEntities.find(e => e.iri === nodeType) && (
              <div className="text-xs text-muted-foreground px-2">
                {getDisplayLabelFromUri(nodeType)}
              </div>
            )}
            {nodeType && !classEntities.find(e => e.iri === nodeType) && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground">
                    <Info className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64" side="top">
                  <div className="text-xs">
                    This node has an rdf:type value, but the class definition for that type is not currently loaded into the ontology store. This is intended behavior and not an error.
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            owl:NamedIndividual will be automatically preserved for individuals
          </p>
          </div>

          {/* Node IRI */}
          <div className="space-y-2">
            <Label htmlFor="nodeIri">Node IRI</Label>
            <Input
              id="nodeIri"
              value={nodeIri}
              onChange={(e) => setNodeIri(e.target.value)}
              placeholder="https://example.com/entity"
            />
          </div>

          {/* Annotation Properties */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Annotation Properties</Label>
              <Button 
                type="button" 
                variant="outline" 
                size="sm"
                onClick={(e) => handleAddProperty(e)}
              >
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
                      onValueChange={(value) => handleUpdateProperty(index, 'key', value)}
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
                      onChange={(e) => handleUpdateProperty(index, 'value', e.target.value)}
                      placeholder="Property value..."
                    />
                  </div>
                  
                  <div className="col-span-2">
                    <Label className="text-xs">Type</Label>
                    <Select 
                      value={property.type || 'xsd:string'} 
                      onValueChange={(value) => handleUpdateProperty(index, 'type', value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        {getXSDTypes().map(type => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(e) => handleRemoveProperty(index, e)}
                      className="h-9 px-2"
                    >
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

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
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
