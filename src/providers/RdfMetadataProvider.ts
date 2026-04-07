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

interface RdfManagerLike {
  applyBatch(changes: { adds?: any[]; removes?: any[] }, graph?: string): Promise<void>;
  getNamespaces(): Record<string, string>;
}

export class RdfMetadataProvider implements MetadataProvider {
  /** Set to true before writing to rdfManager to suppress the sync loop */
  suppressSync = false;

  constructor(private readonly rdfManager: RdfManagerLike) {}

  getLiteralLanguages(): ReadonlyArray<string> {
    return ['en', 'de', 'fr'];
  }

  async createEntity(
    type: ElementTypeIri,
    options: MetadataCreateOptions
  ): Promise<MetadataCreatedEntity> {
    const iri = `urn:vg:entity:${Date.now()}` as ElementIri;
    const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    this.suppressSync = true;
    try {
      await this.rdfManager.applyBatch({
        adds: [
          {
            subject: { termType: 'NamedNode', value: iri },
            predicate: { termType: 'NamedNode', value: rdfType },
            object: { termType: 'NamedNode', value: type },
            graph: { termType: 'NamedNode', value: 'urn:vg:data' },
          },
        ],
      });
    } finally {
      this.suppressSync = false;
    }
    const data: ElementModel = { id: iri, types: [type], properties: {} };
    return { data };
  }

  async createRelation(
    source: ElementModel,
    target: ElementModel,
    linkType: LinkTypeIri,
    options: MetadataCreateOptions
  ): Promise<MetadataCreatedRelation> {
    this.suppressSync = true;
    try {
      await this.rdfManager.applyBatch({
        adds: [
          {
            subject: { termType: 'NamedNode', value: source.id },
            predicate: { termType: 'NamedNode', value: linkType },
            object: { termType: 'NamedNode', value: target.id },
            graph: { termType: 'NamedNode', value: 'urn:vg:data' },
          },
        ],
      });
    } finally {
      this.suppressSync = false;
    }
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
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataCanConnect[]> {
    return [];
  }

  async canModifyEntity(
    entity: ElementModel,
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataCanModifyEntity> {
    return { canEdit: true, canDelete: true };
  }

  async canModifyRelation(
    link: LinkModel,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataCanModifyRelation> {
    return { canEdit: true, canDelete: true };
  }

  async getEntityShape(
    types: ReadonlyArray<ElementTypeIri>,
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataEntityShape> {
    return { properties: new Map() };
  }

  async getRelationShape(
    linkType: LinkTypeIri,
    source: ElementModel,
    target: ElementModel,
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataRelationShape> {
    return { properties: new Map() };
  }

  async filterConstructibleTypes(
    types: ReadonlySet<ElementTypeIri>,
    options: { readonly signal?: AbortSignal }
  ): Promise<ReadonlySet<ElementTypeIri>> {
    return types;
  }
}
