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

export interface OntologyAccessor {
  getCompatibleProperties(srcType: string, tgtType: string): ReadonlyArray<{ iri: string }>;
  getAllProperties(): ReadonlyArray<{ iri: string }>;
}

export class RdfMetadataProvider implements MetadataProvider {
  /** Set to true externally to suppress the canvas sync loop during direct RDF writes */
  suppressSync = false;

  constructor(
    private readonly rdfManager: RdfManagerLike,
    private readonly ontology?: () => OntologyAccessor,
  ) {}

  getLiteralLanguages(): ReadonlyArray<string> {
    return ['en', 'de', 'fr'];
  }

  async createEntity(
    type: ElementTypeIri,
    options: MetadataCreateOptions
  ): Promise<MetadataCreatedEntity> {
    const iri = `urn:vg:entity:${Date.now()}` as ElementIri;
    // Do NOT write to the RDF store here — flushAuthoringState handles the
    // write on Save, after the user has finished editing the new entity.
    const data: ElementModel = { id: iri, types: [type], properties: {} };
    return { data };
  }

  async createRelation(
    source: ElementModel,
    target: ElementModel,
    linkType: LinkTypeIri,
    options: MetadataCreateOptions
  ): Promise<MetadataCreatedRelation> {
    // Do NOT write to the RDF store here. Reactodia stages the relation in
    // AuthoringState first; the user may change the type before saving.
    // flushAuthoringState (triggered by the Save button) performs the single
    // authoritative write with the final linkType.
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
    const accessor = this.ontology?.();
    const allProps = accessor?.getAllProperties() ?? [];

    // No ontology loaded → allow everything
    if (allProps.length === 0) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: [] }];
    }

    const allOutLinks = allProps.map(p => p.iri as LinkTypeIri);

    // Mid-drag (no target yet) → allow drag, offer all properties
    if (!target) {
      return [{ targetTypes: new Set<ElementTypeIri>(), inLinks: [], outLinks: allOutLinks }];
    }

    const srcType = source.types[0] ?? '';
    const tgtType = target.types[0] ?? '';

    const compatible = srcType && tgtType
      ? accessor!.getCompatibleProperties(srcType, tgtType)
      : [];

    const outLinks = compatible.length > 0
      ? compatible.map(p => p.iri as LinkTypeIri)
      : allOutLinks; // no domain/range match → fall back to all

    return [{
      targetTypes: new Set(target.types as ElementTypeIri[]),
      inLinks: [],
      outLinks,
    }];
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
    return { canChangeType: true, canEdit: true, canDelete: true };
  }

  async getEntityShape(
    types: ReadonlyArray<ElementTypeIri>,
    options: { readonly signal?: AbortSignal }
  ): Promise<MetadataEntityShape> {
    // Allow any existing literal property to appear in the form by providing
    // an extraProperty shape. FormInputGroup will render a row for every
    // property already present in ElementModel.properties.
    return {
      extraProperty: { valueShape: { termType: 'Literal' } },
      properties: new Map(),
    };
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
