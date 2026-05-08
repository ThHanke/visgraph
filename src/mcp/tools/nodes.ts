// src/mcp/tools/nodes.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { focusElementOnCanvas } from './layout';
import { expandIri } from './iriUtils';
import { ADD_NODE_PIPELINE_DELAY_MS } from '@/utils/canvasConstants';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function getLabel(data: Reactodia.ElementModel | undefined): string {
  return (data?.properties?.[RDFS_LABEL]?.[0] as { value?: string } | undefined)?.value ?? '';
}

function findEntityElement(iri: string, model: Reactodia.DataDiagramModel): Reactodia.EntityElement | undefined {
  return model.elements.find(
    e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === iri
  ) as Reactodia.EntityElement | undefined;
}

const addNode: McpTool = {
  name: 'addNode',
  description: 'Add an entity (node) to the canvas by IRI, with an optional RDF type and label.',
  inputSchema: {
    type: 'object',
    properties: {
      iri: { type: 'string' },
      typeIri: { type: 'string' },
      label: { type: 'string' },
    },
    required: ['iri'],
  },
  handler: async (params) => {
    try {
      const raw = params as { iri?: string; typeIri?: string; type?: string; label?: string };
      if (!raw.iri) return { success: false, error: 'iri is required' };
      const iri = expandIri(raw.iri);
      if (iri.startsWith('Unknown prefix:')) return { success: false, error: iri };
      if (/ /.test(iri)) {
        const blankNodeHint = /^\s+:/.test(iri)
          ? ` You passed "${iri}" — blank-node label with leading spaces. Use "_:${iri.trim().slice(1)}" (must start with "_:", not spaces).`
          : ` You passed "${iri}".`;
        return { success: false, error: `Node IRI contains spaces and is not valid.${blankNodeHint}` };
      }
      const typeIri = (raw.typeIri ?? raw.type) ? expandIri((raw.typeIri ?? raw.type)!) : undefined;
      if (typeIri?.startsWith('Unknown prefix:')) return { success: false, error: typeIri };
      const { label } = raw;

      // Batch both triples in one awaitable worker call so onSubjectsChange fires
      // only once, after both rdf:type and rdfs:label are already in the store.
      // Triples land in urn:vg:data → onSubjectsChange → filterByViewMode →
      // createElement in the correct view. No direct canvas mutation here.
      const adds: Array<{ s: string; p: string; o: string }> = [];
      if (typeIri) adds.push({ s: iri, p: RDF_TYPE, o: typeIri });
      if (label) adds.push({ s: iri, p: RDFS_LABEL, o: label });
      if (adds.length > 0) await rdfManager.applyBatch({ adds });

      // Wait for the RDF→canvas pipeline before navigating; navigateToIri handles view-switching.
      await new Promise(r => setTimeout(r, ADD_NODE_PIPELINE_DELAY_MS));
      const { navigateToIri } = getWorkspaceRefs();
      navigateToIri?.(iri);

      return { success: true, data: { iri } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const removeNode: McpTool = {
  name: 'removeNode',
  description: 'Remove an entity and all its triples from the canvas.',
  inputSchema: {
    type: 'object',
    properties: {
      iri: { type: 'string' },
    },
    required: ['iri'],
  },
  handler: async (params) => {
    try {
      const { iri } = params as { iri: string };
      const { ctx } = getWorkspaceRefs();
      const el = findEntityElement(iri, ctx.model);
      if (el) {
        ctx.model.removeElement(el.id);
      }
      await rdfManager.removeAllQuadsForIri(iri);
      return { success: true, data: { removed: iri } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const expandNode: McpTool = {
  name: 'expandNode',
  description: 'Expand canvas node(s) to show annotation properties. Pass iri to expand one node; omit iri to expand all nodes at once. Pass expand=false to collapse.',
  inputSchema: {
    type: 'object',
    properties: {
      iri: { type: 'string' },
      expand: { type: 'boolean', default: true },
    },
  },
  handler: async (params) => {
    try {
      const { iri, expand = true } = (params ?? {}) as { iri?: string; expand?: boolean };
      const { ctx } = getWorkspaceRefs();
      const model = ctx.model;
      if (!iri) {
        // Expand/collapse all canvas nodes
        for (const el of model.elements) {
          if (el instanceof Reactodia.EntityElement) {
            model.history.execute(Reactodia.setElementExpanded(el, expand));
          }
        }
        return { success: true, data: { expanded: model.elements.length } };
      }
      const el = findEntityElement(iri, model);
      if (!el) return { success: false, error: `Element not on canvas: ${iri}` };
      model.history.execute(Reactodia.setElementExpanded(el, expand));
      const { navigateToIri } = getWorkspaceRefs();
      navigateToIri?.(iri);
      return { success: true, data: { iri, expanded: expand } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const getNodes: McpTool = {
  name: 'getNodes',
  description: 'Return entities currently on the canvas. Optionally filter by type IRI or label substring.',
  inputSchema: {
    type: 'object',
    properties: {
      typeIri: { type: 'string' },
      labelContains: { type: 'string' },
      limit: { type: 'integer', default: 100 },
      focusFirst: { type: 'boolean', default: false },
    },
  },
  handler: async (params) => {
    try {
      const { typeIri, labelContains, limit = 100, focusFirst = false } = params as {
        typeIri?: string;
        labelContains?: string;
        limit?: number;
        focusFirst?: boolean;
      };
      const { dataProvider, ctx } = getWorkspaceRefs();
      let items = await dataProvider.lookupAll();
      let fuzzyFallback = false;

      if (typeIri) {
        items = items.filter((item) => item.element.types?.includes(typeIri));
      }
      if (labelContains) {
        const lower = labelContains.toLowerCase();
        const exact = items.filter((item) =>
          getLabel(item.element).toLowerCase().includes(lower)
        );
        if (exact.length > 0) {
          items = exact;
        } else {
          // Fuzzy fallback: prefix lookup via dataProvider
          const fallback = await dataProvider.lookup({ text: labelContains, limit: 1 });
          items = fallback;
          fuzzyFallback = true;
        }
      }

      const clusterMap = new Map<string, string>();
      for (const el of ctx.model.elements) {
        if (el instanceof Reactodia.EntityGroup) {
          for (const member of el.items) {
            if (member.data.id) clusterMap.set(member.data.id, el.id);
          }
        }
      }

      const entities = items.slice(0, limit).map((item) => ({
        iri: item.element.id,
        label: getLabel(item.element),
        types: item.element.types,
        clusterId: clusterMap.get(item.element.id) ?? null,
      }));

      if (focusFirst) {
        const canvasMatch = entities.find(e =>
          ctx.model.elements.some(
            el => el instanceof Reactodia.EntityElement && (el as Reactodia.EntityElement).iri === e.iri
          )
        );
        if (canvasMatch) {
          const el = findEntityElement(canvasMatch.iri, ctx.model);
          if (el) focusElementOnCanvas(el, ctx);
        }
      }

      const result: Record<string, unknown> = { content: JSON.stringify(entities) };
      if (fuzzyFallback) result.fuzzyFallback = true;

      return { success: true, data: result };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const RDFS_LABEL_IRI = RDFS_LABEL;
const RDF_TYPE_IRI = RDF_TYPE;

/** Heuristic: does this string value look like an IRI or blank node? */
function classifyObject(value: string): 'iri' | 'literal' | 'bnode' {
  if (value.startsWith('_:')) return 'bnode';
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value)) return 'iri';
  return 'literal';
}

const getNodeDetails: McpTool = {
  name: 'getNodeDetails',
  description: 'Return all RDF properties (triples) for a specific entity IRI — both asserted (urn:vg:data) and inferred (urn:vg:inferred). Inferred triples are marked inferred:true in the result. Also navigates the canvas to the node, switching between ABox/TBox views if needed.',
  inputSchema: {
    type: 'object',
    required: ['iri'],
    properties: {
      iri: { type: 'string', description: 'IRI of the entity to inspect. Prefix notation supported (e.g. ex:Alice).' },
    },
  },
  handler: async (params) => {
    try {
      const raw = params as { iri?: string };
      if (!raw.iri) return { success: false, error: 'iri is required' };
      const iri = expandIri(raw.iri);
      if (iri.startsWith('Unknown prefix:')) return { success: false, error: iri };

      const [{ items: dataItems }, { items: inferredItems }] = await Promise.all([
        rdfManager.fetchQuadsPage({ graphName: 'urn:vg:data',     filter: { subject: iri }, limit: 0 }),
        rdfManager.fetchQuadsPage({ graphName: 'urn:vg:inferred', filter: { subject: iri }, limit: 0 }),
      ]);

      let label = '';
      const typeSet = new Set<string>();
      const properties: Array<{ predicate: string; object: string; objectType: 'iri' | 'literal' | 'bnode'; inferred?: boolean }> = [];

      for (const q of (dataItems ?? [])) {
        const objectType = classifyObject(q.object);
        properties.push({ predicate: q.predicate, object: q.object, objectType });
        if (q.predicate === RDFS_LABEL_IRI && !label) label = q.object;
        if (q.predicate === RDF_TYPE_IRI) typeSet.add(q.object);
      }
      for (const q of (inferredItems ?? [])) {
        if (q.predicate === RDFS_LABEL_IRI && !label) label = q.object;
        if (q.predicate === RDF_TYPE_IRI) typeSet.add(q.object);
        else {
          const objectType = classifyObject(q.object);
          properties.push({ predicate: q.predicate, object: q.object, objectType, inferred: true });
        }
      }

      const { navigateToIri } = getWorkspaceRefs();
      navigateToIri?.(iri);

      return { success: true, data: { iri, label, types: [...typeSet], properties } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const updateNode: McpTool = {
  name: 'updateNode',
  description: 'Update annotation properties of an existing entity without deleting it (preserves all edges). Only modifies asserted triples in urn:vg:data — inferred triples are never touched.',
  inputSchema: {
    type: 'object',
    required: ['iri'],
    properties: {
      iri: { type: 'string', description: 'IRI of the entity to update.' },
      label: { type: 'string', description: 'New rdfs:label value.' },
      typeIri: { type: 'string', description: 'Replace rdf:type with this IRI.' },
      setProperties: {
        type: 'array',
        description: 'Predicate/value pairs to set (replaces existing values for each predicate).',
        items: {
          type: 'object',
          required: ['predicateIri', 'value'],
          properties: {
            predicateIri: { type: 'string' },
            value: { type: 'string' },
          },
        },
      },
      removeProperties: {
        type: 'array',
        description: 'Predicates whose values should be removed entirely.',
        items: {
          type: 'object',
          required: ['predicateIri'],
          properties: {
            predicateIri: { type: 'string' },
          },
        },
      },
    },
  },
  handler: async (params) => {
    try {
      const raw = params as {
        iri?: string;
        label?: string;
        typeIri?: string;
        setProperties?: Array<{ predicateIri: string; value: string }>;
        removeProperties?: Array<{ predicateIri: string }>;
      };

      if (!raw.iri) return { success: false, error: 'iri is required' };
      const iri = expandIri(raw.iri);
      if (iri.startsWith('Unknown prefix:')) return { success: false, error: iri };

      const hasChanges =
        raw.label !== undefined ||
        raw.typeIri !== undefined ||
        (raw.setProperties && raw.setProperties.length > 0) ||
        (raw.removeProperties && raw.removeProperties.length > 0);
      if (!hasChanges) return { success: false, error: 'Provide at least one field to update (label, typeIri, setProperties, or removeProperties)' };

      // Build (predicate → newValue | null) map; null = remove only
      const changes = new Map<string, string | null>();

      if (raw.label !== undefined) changes.set(RDFS_LABEL_IRI, raw.label);

      if (raw.typeIri !== undefined) {
        const typeIri = expandIri(raw.typeIri);
        if (typeIri.startsWith('Unknown prefix:')) return { success: false, error: typeIri };
        changes.set(RDF_TYPE_IRI, typeIri);
      }

      for (const entry of raw.setProperties ?? []) {
        const pred = expandIri(entry.predicateIri);
        if (pred.startsWith('Unknown prefix:')) return { success: false, error: pred };
        changes.set(pred, entry.value);
      }

      for (const entry of raw.removeProperties ?? []) {
        const pred = expandIri(entry.predicateIri);
        if (pred.startsWith('Unknown prefix:')) return { success: false, error: pred };
        if (!changes.has(pred)) changes.set(pred, null);
      }

      // Build batch: remove existing values for each touched predicate, then add new ones
      const removes: Array<{ s: string; p: string }> = [];
      const adds: Array<{ s: string; p: string; o: string }> = [];

      for (const [pred, newValue] of changes) {
        removes.push({ s: iri, p: pred });
        if (newValue !== null) adds.push({ s: iri, p: pred, o: newValue });
      }

      await rdfManager.applyBatch({ removes, adds }, 'urn:vg:data');

      // Refresh canvas node card
      const { ctx } = getWorkspaceRefs();
      await ctx.model.requestElementData([iri as Reactodia.ElementIri]);

      const changedPredicates = [...changes.keys()];
      return { success: true, data: { updated: iri, changed: changedPredicates } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const nodeTools: McpTool[] = [addNode, removeNode, expandNode, getNodes, getNodeDetails, updateNode];
