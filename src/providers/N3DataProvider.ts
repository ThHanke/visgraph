import {
  RdfDataProvider, TemplateState,
  type DataProvider, type ElementIri, type ElementTypeIri, type LinkTypeIri,
  type PropertyTypeIri, type ElementTypeGraph, type ElementTypeModel,
  type LinkTypeModel, type PropertyTypeModel, type ElementModel, type LinkModel,
  type DataProviderLinkCount, type DataProviderLookupParams, type DataProviderLookupItem,
  Rdf,
} from '@reactodia/workspace';

const EMPTY_LINKS: ReadonlySet<LinkTypeIri> = new Set();

export type ViewMode = 'abox' | 'tbox';

/**
 * RDF types that mark a node as an ABox instance (individual data).
 *
 * A subject with one of these types is shown in the A-Box canvas view and
 * appears in the Entities search tab.
 *
 * Examples:
 *   <https://w3id.org/pmd/co/PMD_0050151> a owl:NamedIndividual  → ABox (material instance)
 *   <https://orcid.org/0000-0003-1649-6832> a owl:NamedIndividual → ABox (person)
 *   <http://example.org/copper-alloy-42> a skos:Concept           → ABox (SKOS concept)
 */
export const ABOX_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#NamedIndividual',
  'http://www.w3.org/2004/02/skos/core#Concept',
]);

/**
 * RDF metatypes that mark a node as a property definition in the ontology (TBox).
 *
 * A subject with one of these types is shown in the T-Box canvas view as a
 * relation/predicate node.
 *
 * Examples:
 *   <https://w3id.org/pmd/co/PMD_0001032> a owl:ObjectProperty    → TBox (relation)
 *   <http://www.w3.org/2000/01/rdf-schema#label> a owl:AnnotationProperty → TBox (annotation)
 */
export const TBOX_PROPERTY_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#ObjectProperty',
  'http://www.w3.org/2002/07/owl#DatatypeProperty',
  'http://www.w3.org/2002/07/owl#AnnotationProperty',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
]);

/**
 * RDF metatypes that mark a node as a class definition in the ontology (TBox).
 *
 * A subject with one of these types is shown in the T-Box canvas view as a
 * class node and drives the class hierarchy tree in the Classes search tab.
 *
 * Examples:
 *   <http://purl.obolibrary.org/obo/CHEBI_28694> a owl:Class → TBox (copper class)
 *   <https://w3id.org/pmd/co/PMD_0020054> a owl:Class        → TBox (PMD material class)
 */
export const TBOX_CLASS_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2000/01/rdf-schema#Class',
]);

/** Union of all TBox metatypes — a node with any of these is an ontology concept. */
export const ALL_TBOX_TYPES = new Set([
  ...TBOX_CLASS_TYPES,
  ...TBOX_PROPERTY_TYPES,
]);

/**
 * Classifies a subject by which canvas view(s) it belongs to, based on its RDF types.
 * This is the single authoritative rule — used by both the data provider's
 * `matchesViewMode` filter and the search index's `iriViewMap` so they always agree.
 *
 *   'abox'  — has an ABox type (owl:NamedIndividual, skos:Concept), OR has no
 *             recognised type at all (unknown individuals default to ABox).
 *             Example: <https://orcid.org/0000-0003-1649-6832> (person)
 *
 *   'tbox'  — has only TBox types (owl:Class, owl:ObjectProperty, …).
 *             Example: <http://purl.obolibrary.org/obo/CHEBI_28694> (copper class)
 *
 *   'both'  — has both ABox and TBox types ("punned" resource); appears in both views.
 *             Example: a class that is also declared owl:NamedIndividual for punning.
 */
export function classifyEntityView(
  types: readonly string[]
): 'abox' | 'tbox' | 'both' {
  const isA = types.some(t => ABOX_TYPES.has(t));
  const isT = types.some(t => ALL_TBOX_TYPES.has(t));
  if (isA && isT) return 'both';
  if (isT) return 'tbox';
  return 'abox'; // has ABox type, or no recognised type → default to ABox
}

/**
 * Only subjects from these graphs are added to the search index (`allSubjects`).
 *
 * Triples from ALL graphs are still stored in the RDF dataset so that
 * `knownElementTypes` can build the full Classes hierarchy tree from ontology
 * and workflow graphs. But only entities that live on the ABox/TBox canvas
 * (i.e. user data and reasoner-inferred assertions) should appear as Entities
 * search hits.
 *
 * Allowlisted graphs:
 *   urn:vg:data     — user-loaded material data (owl:NamedIndividual instances,
 *                     skos:Concept terms, custom entities, …)
 *   urn:vg:inferred — type/property assertions inferred by the reasoner for
 *                     subjects that already live in urn:vg:data
 *
 * Everything else (urn:vg:ontologies, urn:vg:workflows, any future schema graph)
 * is automatically excluded — no blocklist maintenance required.
 */
const SEARCH_ALLOWED_GRAPHS = new Set([
  'urn:vg:data',
  'urn:vg:inferred',
]);

// Graphs whose rdf:type declarations are eligible for the class tree (knownElementTypes).
// Ontology classes live in urn:vg:ontologies; data-graph types are also valid.
// Workflow/catalog graphs are excluded — their types are not schema definitions.
const SCHEMA_ALLOWED_GRAPHS = new Set([
  'urn:vg:data',
  'urn:vg:inferred',
  'urn:vg:ontologies',
]);

// Keep as a private alias so matchesViewMode still compiles:
const TBOX_TYPES = ALL_TBOX_TYPES;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** IRIs of synthetic marker properties injected into ElementModel / LinkModel. */
export const INFERRED_TYPES_PROP = 'urn:vg:inferredTypes' as PropertyTypeIri;
export const INFERRED_DATA_PROPS_PROP = 'urn:vg:inferredDataProps' as PropertyTypeIri;
/**
 * Graph-name property injected into both ElementModel and LinkModel when the
 * subject / triple originates from a named graph. Value is the graph IRI as a
 * NamedNode, e.g. `urn:vg:inferred`. Templates use this as the primary
 * decoration signal — no extra queries needed.
 */
export const VG_GRAPH_NAME_PROP = 'urn:vg:graphName' as PropertyTypeIri;

/**
 * Typed TemplateState property key for persisting graph origin in link/element
 * template state so it survives importLayout (serialized in SerializedLink.linkState).
 */
export const VG_GRAPH_NAME_STATE = TemplateState.property(VG_GRAPH_NAME_PROP).of<string>();

/** Properties injected by the DataProvider that must be hidden from UI rendering. */
export const SYNTHETIC_VG_PROPS = new Set<string>([
  INFERRED_TYPES_PROP,
  INFERRED_DATA_PROPS_PROP,
  VG_GRAPH_NAME_PROP,
]);

/** Encode a quad object term to a stable string key. */
function objectKey(term: Rdf.Term): string {
  if (term.termType === 'Literal') return `"${term.value}`;
  return term.value;
}

interface InferredSubjectEntry {
  /** Predicate IRIs that have ≥1 inferred triple for this subject. */
  predicates: Set<string>;
  /** `${predicateIri}\x00${objectKey}` for exact triple lookup. */
  triples: Set<string>;
}

/** All OWL/RDF metatypes whose instances should appear as nodes in the class tree. */
const TBOX_BASE_TYPES = [
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2000/01/rdf-schema#Class',
  'http://www.w3.org/2002/07/owl#ObjectProperty',
  'http://www.w3.org/2002/07/owl#DatatypeProperty',
  'http://www.w3.org/2002/07/owl#AnnotationProperty',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
];

const RDFS_SUB_CLASS_OF   = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUB_PROP_OF    = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';

export class N3DataProvider implements DataProvider {
  private inner = new RdfDataProvider({
    elementTypeBaseTypes: TBOX_BASE_TYPES,
    // Include all property metatypes so DatatypeProperty/AnnotationProperty show in autocomplete
    linkTypeBaseTypes: [
      'http://www.w3.org/2002/07/owl#ObjectProperty',
      'http://www.w3.org/2002/07/owl#DatatypeProperty',
      'http://www.w3.org/2002/07/owl#AnnotationProperty',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
    ],
    // subClassOf is used for class hierarchies; subPropertyOf is added manually below
    elementSubtypePredicate: RDFS_SUB_CLASS_OF,
  });
  private viewMode: ViewMode = 'abox';
  private typeMap = new Map<string, Set<string>>();
  /**
   * All subject IRIs eligible for the search index.
   *
   * Populated by `addGraph` for every named-node subject whose graph is NOT in
   * `SEARCH_EXCLUDED_GRAPHS`. Used by `lookupAll` to build the unified search
   * entity list (Entities tab + match counter).
   *
   * Graphs and what they contribute here:
   *   urn:vg:data       — user-loaded material data (owl:NamedIndividual instances,
   *                       e.g. specific copper alloy samples) → ABox entities
   *   urn:vg:ontologies — material ontology (owl:Class, owl:ObjectProperty, …)
   *                       → TBox concepts; class IRIs drive the Classes hierarchy
   *   urn:vg:inferred   — type/property assertions inferred by the reasoner
   *                       → enriches existing subjects already in the set
   *   urn:vg:workflows  — excluded (see SEARCH_EXCLUDED_GRAPHS); workflow instances
   *                       must not appear in material search results
   */
  private allSubjects = new Set<string>();
  /** Per-subject tracking of which triples originated from urn:vg:inferred. */
  private inferredBySubject = new Map<string, InferredSubjectEntry>();

  get factory() { return this.inner.factory; }

  addGraph(quads: Iterable<Rdf.Quad>, graphName?: string): void {
    const arr = Array.isArray(quads) ? quads : [...quads];
    const trackInferred = graphName === 'urn:vg:inferred';
    // Only subjects from data/inferred graphs enter allSubjects (Entities search).
    // Only data/inferred/ontologies graphs feed this.inner (knownElementTypes / class tree).
    // Workflow and catalog graphs are excluded from both.
    // When graphName is undefined the caller did not specify a graph — treat as data.
    const addToIndex = graphName === undefined || SEARCH_ALLOWED_GRAPHS.has(graphName);
    const addToSchema = graphName === undefined || SCHEMA_ALLOWED_GRAPHS.has(graphName);

    for (const q of arr) {
      if (q.subject.termType === 'NamedNode' && addToIndex) {
        this.allSubjects.add(q.subject.value);
      }
      if (
        addToSchema &&
        q.predicate.termType === 'NamedNode' &&
        q.predicate.value === RDF_TYPE &&
        q.subject.termType === 'NamedNode' &&
        q.object.termType === 'NamedNode'
      ) {
        let types = this.typeMap.get(q.subject.value);
        if (!types) { types = new Set(); this.typeMap.set(q.subject.value, types); }
        types.add(q.object.value);
      }
      if (trackInferred && q.subject.termType === 'NamedNode' && q.predicate.termType === 'NamedNode') {
        const subj = q.subject.value;
        let entry = this.inferredBySubject.get(subj);
        if (!entry) { entry = { predicates: new Set(), triples: new Set() }; this.inferredBySubject.set(subj, entry); }
        entry.predicates.add(q.predicate.value);
        entry.triples.add(`${q.predicate.value}\x00${objectKey(q.object)}`);
      }
    }
    // Only feed schema-allowed graphs into the inner Reactodia store so
    // knownElementTypes never surfaces classes from workflows/catalog graphs.
    if (addToSchema) {
      this.inner.addGraph(arr);
    }
  }

  /**
   * Remove all quads whose subject matches any of the given IRIs, then add the
   * replacement quads. Use this when updating existing entities so stale triples
   * don't linger in the store alongside the new ones.
   */
  replaceSubjectQuads(subjectIris: string[], newQuads: Rdf.Quad[], graphName?: string): void {
    const dataset = (this.inner as any).dataset;
    for (const iri of subjectIris) {
      const node = this.inner.factory.namedNode(iri);
      const toRemove = [...dataset.iterateMatches(node, null, null)];
      for (const q of toRemove) {
        dataset.delete(q);
      }
      this.typeMap.delete(iri);
      this.inferredBySubject.delete(iri);
    }
    this.addGraph(newQuads, graphName);
  }

  clearInferred(): void {
    this.inferredBySubject.clear();
    const dataset = (this.inner as any).dataset;
    if (dataset && typeof dataset.iterateMatches === 'function' && typeof dataset.delete === 'function') {
      const graphNode = this.inner.factory.namedNode('urn:vg:inferred');
      const toRemove = [...dataset.iterateMatches(null, null, null, graphNode)];
      for (const q of toRemove) {
        dataset.delete(q);
      }
    }
  }

  removeSubjects(iris: string[]): void {
    const dataset = (this.inner as any).dataset;
    for (const iri of iris) {
      this.allSubjects.delete(iri);
      this.typeMap.delete(iri);
      this.inferredBySubject.delete(iri);
      if (dataset && typeof dataset.iterateMatches === 'function' && typeof dataset.delete === 'function') {
        const node = this.inner.factory.namedNode(iri);
        const toRemove = [...dataset.iterateMatches(node, null, null)];
        for (const q of toRemove) {
          dataset.delete(q);
        }
      }
    }
  }

  clear(): void {
    this.inner.clear();
    this.typeMap.clear();
    this.allSubjects.clear();
    this.inferredBySubject.clear();
  }

  getDomainRange(propertyIri: string): { domains: string[]; ranges: string[] } {
    const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
    const RDFS_RANGE  = 'http://www.w3.org/2000/01/rdf-schema#range';
    const dataset = (this.inner as any).dataset;
    const propNode    = this.inner.factory.namedNode(propertyIri);
    const domainPred  = this.inner.factory.namedNode(RDFS_DOMAIN);
    const rangePred   = this.inner.factory.namedNode(RDFS_RANGE);
    const domains = [...dataset.iterateMatches(propNode, domainPred, null)].map((q: any) => q.object.value);
    const ranges  = [...dataset.iterateMatches(propNode, rangePred,  null)].map((q: any) => q.object.value);
    return { domains, ranges };
  }

  setViewMode(mode: ViewMode): void { this.viewMode = mode; }

  /** Synchronously filter IRIs to those matching the current view mode. */
  filterByViewMode(iris: string[]): string[] {
    return iris.filter(iri => {
      const types = this.typeMap.get(iri);
      return this.matchesViewMode(types ? [...types] as ElementTypeIri[] : []);
    });
  }

  async knownElementTypes(p: { signal?: AbortSignal }): Promise<ElementTypeGraph> {
    const graph = await this.inner.knownElementTypes(p);
    // Also follow rdfs:subPropertyOf so property hierarchies appear in the tree
    // alongside class hierarchies (inner only follows rdfs:subClassOf).
    const dataset = (this.inner as any).dataset;
    if (!dataset?.iterateMatches) return graph;
    const subPropNode = this.inner.factory.namedNode(RDFS_SUB_PROP_OF);
    const extraTypes: ElementTypeModel[] = [];
    const knownIds = new Set(graph.elementTypes.map(et => et.id));
    const extraEdges: Array<[string, string]> = [];
    for (const t of dataset.iterateMatches(null, subPropNode, null)) {
      if (t.subject.termType !== 'NamedNode' || t.object.termType !== 'NamedNode') continue;
      const child = t.subject.value as ElementTypeIri;
      const parent = t.object.value as ElementTypeIri;
      if (!knownIds.has(child)) { extraTypes.push({ id: child, label: [], count: 0 }); knownIds.add(child); }
      if (!knownIds.has(parent)) { extraTypes.push({ id: parent, label: [], count: 0 }); knownIds.add(parent); }
      extraEdges.push([child, parent]);
    }
    if (extraEdges.length === 0 && extraTypes.length === 0) return graph;
    return {
      elementTypes: extraTypes.length > 0 ? [...graph.elementTypes, ...extraTypes] : graph.elementTypes,
      subtypeOf: [...graph.subtypeOf, ...extraEdges],
    };
  }
  /**
   * Returns ElementModel for every subject in the N3 store.
   * Used by the unified search index to build a view-agnostic entity list.
   */
  async lookupAll(p: { signal?: AbortSignal } = {}): Promise<DataProviderLookupItem[]> {
    const allIris = [...this.allSubjects] as ElementIri[];
    if (allIris.length === 0) return [];
    const elementsMap = await this.elements({ elementIds: allIris, signal: p.signal });
    const results: DataProviderLookupItem[] = [];
    for (const iri of allIris) {
      const el = elementsMap.get(iri);
      if (el) results.push({ element: el, inLinks: EMPTY_LINKS, outLinks: EMPTY_LINKS });
    }
    return results;
  }

  knownLinkTypes(p: { signal?: AbortSignal }): Promise<LinkTypeModel[]> {
    return this.inner.knownLinkTypes(p);
  }
  elementTypes(p: { classIds: ReadonlyArray<ElementTypeIri>; signal?: AbortSignal }): Promise<Map<ElementTypeIri, ElementTypeModel>> {
    return this.inner.elementTypes(p);
  }
  linkTypes(p: { linkTypeIds: ReadonlyArray<LinkTypeIri>; signal?: AbortSignal }): Promise<Map<LinkTypeIri, LinkTypeModel>> {
    return this.inner.linkTypes(p);
  }
  propertyTypes(p: { propertyIds: ReadonlyArray<PropertyTypeIri>; signal?: AbortSignal }): Promise<Map<PropertyTypeIri, PropertyTypeModel>> {
    return this.inner.propertyTypes(p);
  }

  async elements(p: { elementIds: ReadonlyArray<ElementIri>; signal?: AbortSignal }): Promise<Map<ElementIri, ElementModel>> {
    const result = await this.inner.elements(p);

    // The inner RdfDataProvider only stores Literal-valued properties. Inject IRI-valued
    // properties where the object IRI has no type declarations in the dataset — i.e. it is
    // an untyped entity that won't appear as a graph node, so treat it like an annotation value.
    const dataset = (this.inner as any).dataset;
    if (dataset) {
      for (const [iri, model] of result) {
        const subjectNode = this.inner.factory.namedNode(iri);
        for (const q of dataset.iterateMatches(subjectNode, null, null)) {
          if (q.predicate.termType !== 'NamedNode') continue;
          if (q.object.termType !== 'NamedNode') continue;
          const predIri = q.predicate.value;
          if (predIri === RDF_TYPE) continue;
          // Only inject if the object IRI is untyped (no entries in typeMap)
          const objectTypes = this.typeMap.get(q.object.value);
          if (objectTypes && objectTypes.size > 0) continue;
          const props = model.properties as Record<string, (Rdf.NamedNode | Rdf.Literal)[]>;
          if (!Object.prototype.hasOwnProperty.call(props, predIri)) {
            props[predIri] = [q.object as Rdf.NamedNode];
          } else {
            props[predIri].push(q.object as Rdf.NamedNode);
          }
        }
      }
    }

    for (const [iri, model] of result) {
      const entry = this.inferredBySubject.get(iri);
      if (!entry) continue;

      const inferredTypeIris: string[] = [];
      for (const typeIri of model.types) {
        if (entry.triples.has(`${RDF_TYPE}\x00${typeIri}`)) {
          inferredTypeIris.push(typeIri);
        }
      }

      const inferredPropIris: string[] = [];
      for (const propIri of Object.keys(model.properties)) {
        if (SYNTHETIC_VG_PROPS.has(propIri)) continue;
        if (entry.predicates.has(propIri)) {
          inferredPropIris.push(propIri);
        }
      }

      if (inferredTypeIris.length === 0 && inferredPropIris.length === 0) continue;

      const props = { ...model.properties } as Record<string, (Rdf.NamedNode | Rdf.Literal)[]>;
      if (inferredTypeIris.length > 0) {
        props[INFERRED_TYPES_PROP] = inferredTypeIris.map(
          t => ({ termType: 'NamedNode', value: t }) as Rdf.NamedNode
        );
      }
      if (inferredPropIris.length > 0) {
        props[INFERRED_DATA_PROPS_PROP] = inferredPropIris.map(
          p => ({ termType: 'NamedNode', value: p }) as Rdf.NamedNode
        );
      }
      // Graph-name marker: templates use this as the primary decoration signal.
      props[VG_GRAPH_NAME_PROP] = [
        { termType: 'NamedNode', value: 'urn:vg:inferred' } as Rdf.NamedNode,
      ];
      const enriched: ElementModel = { ...model, properties: props };
      result.set(iri, enriched);
    }
    return result;
  }

  async links(p: { primary: ReadonlyArray<ElementIri>; secondary: ReadonlyArray<ElementIri>; linkTypeIds?: ReadonlyArray<LinkTypeIri>; signal?: AbortSignal }): Promise<LinkModel[]> {
    const result = await this.inner.links(p);
    return result.map(link => {
      const entry = this.inferredBySubject.get(link.sourceId);
      if (!entry) return link;
      if (!entry.triples.has(`${link.linkTypeId}\x00${link.targetId}`)) return link;
      // Graph-name property: templates use this to decide link decoration.
      return {
        ...link,
        properties: {
          ...link.properties,
          [VG_GRAPH_NAME_PROP]: [{ termType: 'NamedNode', value: 'urn:vg:inferred' } as Rdf.NamedNode],
        },
      };
    });
  }

  /** True when at least one inferred triple has been loaded — used by the canvas
   *  to decide whether validateLinks is needed on importLayout. */
  hasInferredData(): boolean {
    return this.inferredBySubject.size > 0;
  }

  connectedLinkStats(p: { elementId: ElementIri; inexactCount?: boolean; signal?: AbortSignal }): Promise<DataProviderLinkCount[]> {
    return this.inner.connectedLinkStats(p);
  }

  async lookup(p: DataProviderLookupParams): Promise<DataProviderLookupItem[]> {
    if (p.refElementId) {
      return this.inner.lookup(p);
    }
    const innerResults = await this.inner.lookup(p);
    if (!p.text) {
      return innerResults;
    }

    // Filter inner results by view mode: the inner RDF provider is not aware of
    // our ABox/TBox split, so owl:Class IRIs can bleed into entity search results.
    // Punned resources (both ABox and TBox types) are kept in both views.
    const filteredInner = innerResults.filter(item =>
      this.matchesViewMode(item.element.types)
    );

    const textLower = p.text.toLowerCase();
    const innerIds = new Set(filteredInner.map(r => r.element.id));
    const candidateIris: ElementIri[] = [];
    for (const iri of this.allSubjects) {
      if (innerIds.has(iri as ElementIri)) continue;
      const localName = (iri.split(/[/#]/).pop() ?? iri).toLowerCase();
      if (!localName.includes(textLower)) continue;
      if (p.elementTypeId) {
        const types = this.typeMap.get(iri);
        if (!types?.has(p.elementTypeId)) continue;
      }
      // Skip IRIs that don't belong to the current view mode
      const types = this.typeMap.get(iri);
      const typeList = types ? ([...types] as ElementTypeIri[]) : [];
      if (!this.matchesViewMode(typeList)) continue;
      candidateIris.push(iri as ElementIri);
    }
    if (candidateIris.length === 0) return filteredInner;
    const limit = p.limit === null ? null : (typeof p.limit === 'number' ? p.limit : 100);
    const toFetch = limit === null
      ? candidateIris
      : candidateIris.slice(0, Math.max(0, limit - filteredInner.length));
    if (toFetch.length === 0) return filteredInner;
    const elementsMap = await this.elements({ elementIds: toFetch });
    const iriResults: DataProviderLookupItem[] = toFetch
      .filter(iri => elementsMap.has(iri))
      .map(iri => ({
        element: elementsMap.get(iri)!,
        inLinks: EMPTY_LINKS,
        outLinks: EMPTY_LINKS,
      }));
    return [...filteredInner, ...iriResults];
  }

  private matchesViewMode(types: readonly ElementTypeIri[]): boolean {
    const isA = types.some(t => ABOX_TYPES.has(t));
    const isT = types.some(t => TBOX_TYPES.has(t));
    if (isA && isT) return true;
    if (this.viewMode === 'abox') return isA || (!isA && !isT);
    return isT;
  }
}
