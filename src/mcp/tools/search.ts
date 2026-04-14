// src/mcp/tools/search.ts
import type { McpTool } from '@/mcp/types';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

export const searchTools: McpTool[] = [
  {
    name: 'searchEntities',
    description:
      'Search entities in the loaded graph by label or IRI substring. Returns IRI + label pairs the AI can use to pick real IRIs before adding nodes or links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['query'],
    },
    handler: async (params: unknown) => {
      try {
        const { query, limit } = params as { query: string; limit?: number };
        const { dataProvider } = getWorkspaceRefs();
        const items = await dataProvider.lookup({ text: query, limit: limit ?? 20 });
        const results = items.map((item) => ({
          iri: item.id,
          label: item.label?.value ?? item.id,
        }));
        return { success: true, data: { results } };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
  },
  {
    name: 'autocomplete',
    description:
      'Autocomplete entity IRIs from the loaded graph — augments lookups so the AI can resolve partial names to full IRIs before authoring.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        limit: { type: 'integer', default: 10 },
      },
      required: ['text'],
    },
    handler: async (params: unknown) => {
      try {
        const { text, limit } = params as { text: string; limit?: number };
        const { dataProvider } = getWorkspaceRefs();
        const items = await dataProvider.lookup({ text, limit: limit ?? 10 });
        const completions = items.map((item) => ({
          iri: item.id,
          label: item.label?.value ?? item.id,
        }));
        return { success: true, data: { completions } };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
  },
];
