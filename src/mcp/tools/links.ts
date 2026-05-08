// src/mcp/tools/links.ts
import type { McpTool } from '../types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { expandIri } from './iriUtils';
import * as Reactodia from '@reactodia/workspace';

interface LinkParams {
  subjectIri?: string;
  predicateIri?: string;
  objectIri?: string;
  // common aliases accepted silently
  s?: string; subject?: string;
  p?: string; predicate?: string;
  o?: string; object?: string;
  limit?: number;
}

export const linkTools: McpTool[] = [
  {
    name: 'addTriple',
    description: 'Add a simple RDF triple between named entities (IRIs) or attach a literal annotation. Use for: object-property links between known IRIs (e.g. ex:Pizza rdf:type ex:Food), data/annotation properties (e.g. rdfs:label "Pizza"@en), and rdf:type assertions. Object-property triples render on canvas immediately; literal triples appear when the subject node is expanded via expandNode. Do NOT use for OWL axioms that require intermediate anonymous nodes — restrictions (owl:someValuesFrom, owl:allValuesFrom, owl:hasValue), intersections (owl:intersectionOf), unions, or other complex class expressions. For those, use loadRdf with inline Turtle: loadRdf(`@prefix ex: <http://example.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:SalamiPizza owl:equivalentClass [ rdf:type owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:SalamiTopping ] .`). Blank node labels ("_:b0") are accepted and skolemized consistently, but only for simple entity linking — do not use them to build restriction structures via addTriple.',
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
        const rawS = raw.subjectIri ?? raw.subject ?? raw.s;
        const rawP = raw.predicateIri ?? raw.predicate ?? raw.p;
        const rawO = raw.objectIri ?? raw.object ?? raw.o;
        const subjectIri = rawS ? expandIri(rawS) : undefined;
        const predicateIri = rawP ? expandIri(rawP) : undefined;
        // objectIri may be a plain literal — only expand if it looks like a prefixed IRI
        const objectIri = rawO ? expandIri(rawO) : undefined;
        if (!subjectIri || !predicateIri || !objectIri) {
          return { success: false as const, error: 'subjectIri, predicateIri, and objectIri are all required. Call help({tool:"addTriple"}) for the full schema.' };
        }
        const expandError = [subjectIri, predicateIri, objectIri].find(v => v.startsWith('Unknown prefix:'));
        if (expandError) return { success: false as const, error: expandError };
        if (subjectIri.startsWith('[') || objectIri.startsWith('[')) {
          return { success: false as const, error: 'Inline Turtle blank node syntax "[ ... ]" is not a valid IRI. Use an explicit blank node label instead, e.g. "_:b0". Call addTriple("_:b0","rdf:type","owl:Restriction") then addTriple("_:b0","owl:onProperty","ex:hasPart") etc. Each distinct restriction needs a distinct label.' };
        }
        // IRIs never contain spaces — catch Turtle fragments passed as IRIs
        // (e.g. "ex:hasPart someValuesFrom ex:Foo" or "Pizza and hasTopping some Foo")
        if (/ /.test(subjectIri) || / /.test(objectIri)) {
          const badIri = [subjectIri, objectIri].find(v => / /.test(v)) ?? '';
          // Detect corrupted blank-node: leading whitespace before colon (e.g. "     :r1" → should be "_:r1")
          const blankNodeHint = /^\s+:/.test(badIri)
            ? ` You passed "${badIri}" — this is a blank-node label with leading spaces instead of underscore. Use "_:${badIri.trim().slice(1)}" (must start with "_:", not spaces).`
            : ` You passed "${badIri}".`;
          return { success: false as const, error: `IRI contains spaces and is not valid.${blankNodeHint} For OWL restrictions prefer loadRdf with Turtle: loadRdf({turtle:"@prefix ex: <http://example.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:SalamiPizza owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:SalamiTopping ] ."})` };
        }
        rdfManager.addTriple(subjectIri, predicateIri, objectIri);

        const { ctx } = getWorkspaceRefs();
        const model = ctx.model;
        await model.requestLinks({
          addedElements: [subjectIri as Reactodia.ElementIri, objectIri as Reactodia.ElementIri],
        });

        const { navigateToIri } = getWorkspaceRefs();
        navigateToIri?.(subjectIri);

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
        const rawS = raw.subjectIri ?? raw.subject ?? raw.s;
        const rawP = raw.predicateIri ?? raw.predicate ?? raw.p;
        const rawO = raw.objectIri ?? raw.object ?? raw.o;
        const subjectIri = rawS ? expandIri(rawS) : undefined;
        const predicateIri = rawP ? expandIri(rawP) : undefined;
        const objectIri = rawO ? expandIri(rawO) : undefined;
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
