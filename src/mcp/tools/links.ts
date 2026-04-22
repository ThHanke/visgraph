// src/mcp/tools/links.ts
import type { McpTool } from '../types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { focusElementOnCanvas } from './layout';
import { expandIri } from './iriUtils';
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
        const raw = (params ?? {}) as LinkParams;
        const subjectIri = raw.subjectIri ? expandIri(raw.subjectIri) : undefined;
        const predicateIri = raw.predicateIri ? expandIri(raw.predicateIri) : undefined;
        // objectIri may be a plain literal — only expand if it looks like a prefixed IRI
        const objectIri = raw.objectIri ? expandIri(raw.objectIri) : undefined;
        if (!subjectIri || !predicateIri || !objectIri) {
          return { success: false as const, error: 'subjectIri, predicateIri, and objectIri are all required' };
        }
        const expandError = [subjectIri, predicateIri, objectIri].find(v => v.startsWith('Unknown prefix:'));
        if (expandError) return { success: false as const, error: expandError };
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
        const raw = (params ?? {}) as LinkParams;
        const subjectIri = raw.subjectIri ? expandIri(raw.subjectIri) : undefined;
        const predicateIri = raw.predicateIri ? expandIri(raw.predicateIri) : undefined;
        const objectIri = raw.objectIri ? expandIri(raw.objectIri) : undefined;
        if (!subjectIri || !predicateIri || !objectIri) {
          return { success: false as const, error: 'subjectIri, predicateIri, and objectIri are all required' };
        }
        const expandError = [subjectIri, predicateIri, objectIri].find(v => v.startsWith('Unknown prefix:'));
        if (expandError) return { success: false as const, error: expandError };
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
