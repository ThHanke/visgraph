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

const ABOX_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#NamedIndividual',
  'http://www.w3.org/2004/02/skos/core#Concept',
]);
const TBOX_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2000/01/rdf-schema#Class',
  'http://www.w3.org/2002/07/owl#ObjectProperty',
  'http://www.w3.org/2002/07/owl#DatatypeProperty',
  'http://www.w3.org/2002/07/owl#AnnotationProperty',
]);

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
    // subClassOf is used for class hierarchies; subPropertyOf is added manually below
    elementSubtypePredicate: RDFS_SUB_CLASS_OF,
  });
  private viewMode: ViewMode = 'abox';
  private typeMap = new Map<string, Set<string>>();
  private allSubjects = new Set<string>();
  /** Per-subject tracking of which triples originated from urn:vg:inferred. */
  private inferredBySubject = new Map<string, InferredSubjectEntry>();

  get factory() { return this.inner.factory; }

  addGraph(quads: Iterable<Rdf.Quad>, graphName?: string): void {
    const arr = Array.isArray(quads) ? quads : [...quads];
    const trackInferred = graphName === 'urn:vg:inferred';

    for (const q of arr) {
      if (q.subject.termType === 'NamedNode') {
        this.allSubjects.add(q.subject.value);
      }
      if (
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
    this.inner.addGraph(arr);
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
    const limit = typeof p.limit === 'number' ? p.limit : 100;
    const toFetch = candidateIris.slice(0, Math.max(0, limit - filteredInner.length));
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
