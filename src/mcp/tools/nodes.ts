// src/mcp/tools/nodes.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { focusElementOnCanvas } from './layout';
import { expandIri } from './iriUtils';

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
      const raw = params as { iri?: string; typeIri?: string; label?: string };
      if (!raw.iri) return { success: false, error: 'iri is required' };
      const iri = expandIri(raw.iri);
      if (iri.startsWith('Unknown prefix:')) return { success: false, error: iri };
      const typeIri = raw.typeIri ? expandIri(raw.typeIri) : undefined;
      if (typeIri?.startsWith('Unknown prefix:')) return { success: false, error: typeIri };
      const { label } = raw;

      const { ctx } = getWorkspaceRefs();
      const model = ctx.model;

      if (typeIri) rdfManager.addTriple(iri, RDF_TYPE, typeIri);
      if (label) rdfManager.addTriple(iri, RDFS_LABEL, label);

      if (!findEntityElement(iri, model)) {
        model.createElement(iri as Reactodia.ElementIri);
      }

      // Allow Reactodia to mount the element before requesting data
      await new Promise(r => setTimeout(r, 0));

      await model.requestElementData([iri as Reactodia.ElementIri]);
      await model.requestLinks({ addedElements: [iri as Reactodia.ElementIri] });

      const el = findEntityElement(iri, model);
      if (el) {
        model.history.execute(Reactodia.setElementExpanded(el, true));
        focusElementOnCanvas(el, ctx);
      }

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
  description: 'Expand a node to show its annotation properties. Pass expand=false to collapse.',
  inputSchema: {
    type: 'object',
    properties: {
      iri: { type: 'string' },
      expand: { type: 'boolean', default: true },
    },
    required: ['iri'],
  },
  handler: async (params) => {
    try {
      const { iri, expand = true } = params as { iri: string; expand?: boolean };
      const { ctx } = getWorkspaceRefs();
      const el = findEntityElement(iri, ctx.model);
      if (!el) return { success: false, error: `Element not on canvas: ${iri}` };
      ctx.model.history.execute(Reactodia.setElementExpanded(el, expand));
      return { success: true, data: { iri, expanded: expand } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

const expandAll: McpTool = {
  name: 'expandAll',
  description: 'Expand all nodes on the canvas to show their annotation properties.',
  inputSchema: { type: 'object' },
  handler: async () => {
    try {
      const { ctx } = getWorkspaceRefs();
      const model = ctx.model;
      for (const el of model.elements) {
        if (el instanceof Reactodia.EntityElement) {
          model.history.execute(Reactodia.setElementExpanded(el, true));
        }
      }
      return { success: true, data: { expanded: model.elements.length } };
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
    },
  },
  handler: async (params) => {
    try {
      const { typeIri, labelContains, limit = 100 } = params as {
        typeIri?: string;
        labelContains?: string;
        limit?: number;
      };
      const { dataProvider } = getWorkspaceRefs();
      let items = await dataProvider.lookupAll();

      if (typeIri) {
        items = items.filter((item) => item.element.types?.includes(typeIri));
      }
      if (labelContains) {
        const lower = labelContains.toLowerCase();
        items = items.filter((item) =>
          getLabel(item.element).toLowerCase().includes(lower)
        );
      }

      const entities = items.slice(0, limit).map((item) => ({
        iri: item.element.id,
        label: getLabel(item.element),
        types: item.element.types,
      }));

      return { success: true, data: { content: JSON.stringify(entities) } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const nodeTools: McpTool[] = [addNode, removeNode, expandNode, expandAll, getNodes];
