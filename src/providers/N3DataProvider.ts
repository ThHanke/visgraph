import {
  RdfDataProvider,
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

export class N3DataProvider implements DataProvider {
  private inner = new RdfDataProvider();
  private viewMode: ViewMode = 'abox';
  private typeMap = new Map<string, Set<string>>();
  private allSubjects = new Set<string>();

  get factory() { return this.inner.factory; }

  addGraph(quads: Iterable<Rdf.Quad>): void {
    const arr = Array.isArray(quads) ? quads : [...quads];
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
    }
    this.inner.addGraph(arr);
  }

  clear(): void { this.inner.clear(); this.typeMap.clear(); this.allSubjects.clear(); }
  setViewMode(mode: ViewMode): void { this.viewMode = mode; }

  /** Synchronously filter IRIs to those matching the current view mode. */
  filterByViewMode(iris: string[]): string[] {
    return iris.filter(iri => {
      const types = this.typeMap.get(iri);
      return this.matchesViewMode(types ? [...types] as ElementTypeIri[] : []);
    });
  }

  knownElementTypes(p: { signal?: AbortSignal }): Promise<ElementTypeGraph> {
    return this.inner.knownElementTypes(p);
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
  elements(p: { elementIds: ReadonlyArray<ElementIri>; signal?: AbortSignal }): Promise<Map<ElementIri, ElementModel>> {
    return this.inner.elements(p);
  }
  links(p: { primary: ReadonlyArray<ElementIri>; secondary: ReadonlyArray<ElementIri>; linkTypeIds?: ReadonlyArray<LinkTypeIri>; signal?: AbortSignal }): Promise<LinkModel[]> {
    return this.inner.links(p);
  }
  connectedLinkStats(p: { elementId: ElementIri; inexactCount?: boolean; signal?: AbortSignal }): Promise<DataProviderLinkCount[]> {
    return this.inner.connectedLinkStats(p);
  }
  async lookup(p: DataProviderLookupParams): Promise<DataProviderLookupItem[]> {
    // Connection-based lookup (refElementId): delegate entirely to inner provider.
    // No view-mode filter — search is for discovery, not gated by canvas mode.
    if (p.refElementId) {
      return this.inner.lookup(p);
    }

    // Delegate to inner first (handles label-based text search + type-based search).
    const innerResults = await this.inner.lookup(p);

    // If no text filter, inner results are sufficient (type-based or empty query).
    if (!p.text) {
      return innerResults;
    }

    // Text filter: also match by IRI local name (segment after last # or /).
    // This covers entities that have no rdfs:label but are identified by IRI alone.
    const textLower = p.text.toLowerCase();
    const innerIds = new Set(innerResults.map(r => r.element.id));

    const candidateIris: ElementIri[] = [];
    for (const iri of this.allSubjects) {
      if (innerIds.has(iri as ElementIri)) continue;
      const localName = (iri.split(/[/#]/).pop() ?? iri).toLowerCase();
      if (!localName.includes(textLower)) continue;
      // Apply elementTypeId filter if present
      if (p.elementTypeId) {
        const types = this.typeMap.get(iri);
        if (!types?.has(p.elementTypeId)) continue;
      }
      candidateIris.push(iri as ElementIri);
    }

    if (candidateIris.length === 0) return innerResults;

    const limit = typeof p.limit === 'number' ? p.limit : 100;
    const toFetch = candidateIris.slice(0, Math.max(0, limit - innerResults.length));
    if (toFetch.length === 0) return innerResults;

    const elementsMap = await this.elements({ elementIds: toFetch });
    const iriResults: DataProviderLookupItem[] = toFetch
      .filter(iri => elementsMap.has(iri))
      .map(iri => ({
        element: elementsMap.get(iri)!,
        inLinks: EMPTY_LINKS,
        outLinks: EMPTY_LINKS,
      }));

    return [...innerResults, ...iriResults];
  }

  private matchesViewMode(types: readonly ElementTypeIri[]): boolean {
    const isA = types.some(t => ABOX_TYPES.has(t));
    const isT = types.some(t => TBOX_TYPES.has(t));
    if (isA && isT) return true; // punned — show in both
    if (this.viewMode === 'abox') return isA || (!isA && !isT);
    return isT;
  }
}
