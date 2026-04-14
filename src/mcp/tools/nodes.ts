// src/mcp/tools/nodes.ts
import type { McpTool } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

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
      const { iri, typeIri, label } = params as { iri?: string; typeIri?: string; label?: string };
      if (!iri) {
        return { success: false, error: 'iri is required' };
      }
      if (typeIri) {
        rdfManager.addTriple(iri, RDF_TYPE, typeIri);
      }
      if (label) {
        rdfManager.addTriple(iri, RDFS_LABEL, '"' + label + '"');
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
      await rdfManager.removeAllQuadsForIri(iri);
      return { success: true, data: { removed: iri } };
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
        items = items.filter((item) => item.types?.includes(typeIri));
      }
      if (labelContains) {
        const lower = labelContains.toLowerCase();
        items = items.filter((item) =>
          item.label?.value?.toLowerCase().includes(lower)
        );
      }

      const entities = items.slice(0, limit).map((item) => ({
        iri: item.id,
        label: item.label?.value,
        types: item.types,
      }));

      return { success: true, data: { entities } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const nodeTools: McpTool[] = [addNode, removeNode, getNodes];
