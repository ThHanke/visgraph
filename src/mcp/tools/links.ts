// src/mcp/tools/links.ts
import type { McpTool } from '../types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { focusElementOnCanvas } from './layout';
import * as Reactodia from '@reactodia/workspace';

interface LinkParams {
  subjectIri?: string;
  predicateIri?: string;
  objectIri?: string;
  limit?: number;
}

export const linkTools: McpTool[] = [
  {
    name: 'addLink',
    description: 'Add a triple (directed edge) between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
      },
      required: ['subjectIri', 'predicateIri', 'objectIri'],
    },
    handler: async (params: unknown) => {
      try {
        const { subjectIri, predicateIri, objectIri } = (params ?? {}) as LinkParams;
        if (!subjectIri || !predicateIri || !objectIri) {
          return { success: false as const, error: 'subjectIri, predicateIri, and objectIri are all required' };
        }
        rdfManager.addTriple(subjectIri, predicateIri, objectIri);

        const { ctx } = getWorkspaceRefs();
        const model = ctx.model;
        await model.requestLinks({
          addedElements: [subjectIri as Reactodia.ElementIri, objectIri as Reactodia.ElementIri],
        });

        const subjectEl = model.elements.find(
          e => e instanceof Reactodia.EntityElement && (e as Reactodia.EntityElement).iri === subjectIri
        ) as Reactodia.EntityElement | undefined;
        if (subjectEl) focusElementOnCanvas(subjectEl, ctx);

        return { success: true as const, data: { added: { s: subjectIri, p: predicateIri, o: objectIri } } };
      } catch (e) {
        return { success: false as const, error: String(e) };
      }
    },
  },
  {
    name: 'removeLink',
    description: 'Remove a triple (edge) between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
      },
      required: ['subjectIri', 'predicateIri', 'objectIri'],
    },
    handler: async (params: unknown) => {
      try {
        const { subjectIri, predicateIri, objectIri } = (params ?? {}) as LinkParams;
        if (!subjectIri || !predicateIri || !objectIri) {
          return { success: false as const, error: 'subjectIri, predicateIri, and objectIri are all required' };
        }
        rdfManager.removeTriple(subjectIri, predicateIri, objectIri);
        return { success: true as const, data: { removed: { s: subjectIri, p: predicateIri, o: objectIri } } };
      } catch (e) {
        return { success: false as const, error: String(e) };
      }
    },
  },
  {
    name: 'getLinks',
    description: 'Return edges currently in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
        limit: { type: 'integer', default: 100 },
      },
    },
    handler: async (params: unknown) => {
      try {
        const { subjectIri, predicateIri, objectIri, limit } = (params ?? {}) as LinkParams;
        const { items } = await rdfManager.fetchQuadsPage({
          graphName: 'urn:vg:data',
          filter: { subject: subjectIri, predicate: predicateIri, object: objectIri },
          limit: limit ?? 100,
        });
        const links = (items ?? []).map((q: { subject: string; predicate: string; object: string }) => ({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        }));
        return { success: true as const, data: { links } };
      } catch (e) {
        return { success: false as const, error: String(e) };
      }
    },
  },
];
