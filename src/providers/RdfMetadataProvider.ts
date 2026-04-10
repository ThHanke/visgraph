import {
  type MetadataProvider,
  type MetadataCreateOptions,
  type MetadataCanConnect,
  type MetadataCanModifyEntity,
  type MetadataCanModifyRelation,
  type MetadataCreatedEntity,
  type MetadataCreatedRelation,
  type MetadataEntityShape,
  type MetadataRelationShape,
  type ElementTypeIri,
  type ElementIri,
  type LinkTypeIri,
  type ElementModel,
  type LinkModel,
} from '@reactodia/workspace';
import type { N3DataProvider } from './N3DataProvider';
import { fetchLinkTypes, scoreLinkTypes } from '../utils/ontologyQueries';
import type { NamespaceEntry } from '../constants/namespaces';

interface RdfManagerLike {
  applyBatch(changes: { adds?: any[]; removes?: any[] }, graph?: string): Promise<void>;
  getNamespaces(): NamespaceEntry[];
}

export class RdfMetadataProvider implements MetadataProvider {
  /** Set to true externally to suppress the canvas sync loop during direct RDF writes */
  suppressSync = false;

  constructor(
    private readonly rdfManager: RdfManagerLike,
    private readonly dataProvider?: N3DataProvider,
  ) {}

  getLiteralLanguages(): ReadonlyArray<string> {
    return ['en', 'de', 'fr'];
  }

  async createEntity(
    type: ElementTypeIri,
    options: MetadataCreateOptions,
  ): Promise<MetadataCreatedEntity> {
    const iri = `urn:vg:entity:${Date.now()}` as ElementIri;
    const data: ElementModel = { id: iri, types: [type], properties: {} };
    return { data };
  }

  async createRelation(
    source: ElementModel,
    target: ElementModel,
    linkType: LinkTypeIri,
    options: MetadataCreateOptions,
  ): Promise<MetadataCreatedRelation> {
    const data: LinkModel = {
      linkTypeId: linkType,
      sourceId: source.id,
      targetId: target.id,
      properties: {},
    };
    return { data };
  }

  async canConnect(
    source: ElementModel,
    target: ElementModel | undefined,
    linkType: LinkTypeIri | undefined,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanConnect[]> {
    if (!this.dataProvider) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: [] }];
    }

    const allEntities = await fetchLinkTypes(this.dataProvider);
    if (allEntities.length === 0) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: [] }];
    }

    const allOutLinks = allEntities.map(e => e.iri as LinkTypeIri);

    if (!target) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: allOutLinks }];
    }

    const srcType = source.types[0];
    const tgtType = target.types[0];

    const scored = scoreLinkTypes(allEntities, srcType, tgtType, this.dataProvider);
    const outLinks = scored.map(e => e.iri as LinkTypeIri);

    return [{
      targetTypes: new Set(target.types as ElementTypeIri[]),
      inLinks: [],
      outLinks,
    }];
  }

  async canModifyEntity(
    entity: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanModifyEntity> {
    return { canEdit: true, canDelete: true };
  }

  async canModifyRelation(
    link: LinkModel,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataCanModifyRelation> {
    return { canChangeType: true, canEdit: true, canDelete: true };
  }

  async getEntityShape(
    types: ReadonlyArray<ElementTypeIri>,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataEntityShape> {
    return {
      extraProperty: { valueShape: { termType: 'Literal' } },
      properties: new Map(),
    };
  }

  async getRelationShape(
    linkType: LinkTypeIri,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal },
  ): Promise<MetadataRelationShape> {
    return { properties: new Map() };
  }

  async filterConstructibleTypes(
    types: ReadonlySet<ElementTypeIri>,
    options: { readonly signal?: AbortSignal },
  ): Promise<ReadonlySet<ElementTypeIri>> {
    return types;
  }
}
