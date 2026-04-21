// src/mcp/tools/search.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool } from '@/mcp/types';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { focusElementOnCanvas } from './layout';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
function getLabel(data: Reactodia.ElementModel | undefined): string {
  return (data?.properties?.[RDFS_LABEL]?.[0] as { value?: string } | undefined)?.value ?? '';
}

export const searchTools: McpTool[] = [
  {
    name: 'searchEntities',
    description:
      'Search entities in the loaded graph by label or IRI substring. Returns IRI + label pairs. If a matching entity is already on the canvas, the viewport pans to it automatically.',
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
        const { dataProvider, ctx } = getWorkspaceRefs();
        const items = await dataProvider.lookup({ text: query, limit: limit ?? 20 });
        const results = items.map((item) => ({
          iri: item.element.id,
          label: getLabel(item.element) || item.element.id,
          onCanvas: ctx.model.elements.some(
            e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === item.element.id
          ),
        }));

        // Auto-focus viewport on first canvas match
        const canvasMatch = results.find(r => r.onCanvas);
        if (canvasMatch) {
          const el = ctx.model.elements.find(
            e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === canvasMatch.iri
          ) as Reactodia.EntityElement | undefined;
          if (el) focusElementOnCanvas(el, ctx);
        }

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
          iri: item.element.id,
          label: getLabel(item.element) || item.element.id,
        }));
        return { success: true, data: { completions } };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },
  },
];
