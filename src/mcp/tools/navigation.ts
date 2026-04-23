// src/mcp/tools/navigation.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { expandIri } from './iriUtils';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// TBox predicates: class/property hierarchy and OWL axioms
const TBOX_PREDICATES = new Set([
  'http://www.w3.org/2000/01/rdf-schema#subClassOf',
  'http://www.w3.org/2000/01/rdf-schema#subPropertyOf',
  'http://www.w3.org/2000/01/rdf-schema#domain',
  'http://www.w3.org/2000/01/rdf-schema#range',
  'http://www.w3.org/2002/07/owl#equivalentClass',
  'http://www.w3.org/2002/07/owl#equivalentProperty',
  'http://www.w3.org/2002/07/owl#inverseOf',
  'http://www.w3.org/2002/07/owl#disjointWith',
  'http://www.w3.org/2002/07/owl#onProperty',
  'http://www.w3.org/2002/07/owl#someValuesFrom',
  'http://www.w3.org/2002/07/owl#allValuesFrom',
  'http://www.w3.org/2002/07/owl#hasValue',
]);

type Layer = 'abox' | 'tbox' | 'both';

function isIri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(value) && !value.startsWith('_:');
}

function classifyEdgeLayer(predicate: string): Layer {
  if (predicate === RDF_TYPE) return 'tbox';
  if (TBOX_PREDICATES.has(predicate)) return 'tbox';
  return 'abox';
}

function edgeMatchesLayer(predicate: string, layer: Layer): boolean {
  if (layer === 'both') return true;
  return classifyEdgeLayer(predicate) === layer;
}

interface Quad { subject: string; predicate: string; object: string }

async function fetchAllQuads(): Promise<Quad[]> {
  const { items } = await rdfManager.fetchQuadsPage({ graphName: 'urn:vg:data', limit: 0 });
  return (items ?? []) as Quad[];
}

function getLabelFromQuads(iri: string, quads: Quad[]): string {
  const q = quads.find(q => q.subject === iri && q.predicate === RDFS_LABEL);
  return q?.object ?? '';
}

function getTypesFromQuads(iri: string, quads: Quad[]): string[] {
  return quads.filter(q => q.subject === iri && q.predicate === RDF_TYPE).map(q => q.object);
}

// ---------------------------------------------------------------------------
// getNeighbors
// ---------------------------------------------------------------------------
const getNeighbors: McpTool = {
  name: 'getNeighbors',
  description: 'Traverse the RDF graph by BFS from a start node. Returns neighboring nodes and edges up to the given depth. Use layer="abox" for instance data, "tbox" for class/property hierarchy, "both" for everything.',
  inputSchema: {
    type: 'object',
    required: ['iri'],
    properties: {
      iri: { type: 'string', description: 'Start node IRI. Prefix notation supported.' },
      depth: { type: 'integer', default: 2, description: 'BFS depth (default 2, max 5).' },
      direction: {
        type: 'string',
        enum: ['out', 'in', 'both'],
        default: 'both',
        description: 'Edge direction: out (subject→object), in (object→subject), both.',
      },
      layer: {
        type: 'string',
        enum: ['abox', 'tbox', 'both'],
        default: 'both',
        description: 'abox = instance data, tbox = class/property hierarchy, both = all.',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const raw = (params ?? {}) as { iri?: string; depth?: number; direction?: string; layer?: string };
      if (!raw.iri) return { success: false, error: 'iri is required' };
      const startIri = expandIri(raw.iri);
      if (startIri.startsWith('Unknown prefix:')) return { success: false, error: startIri };
      const depth = Math.min(raw.depth ?? 2, 5);
      const direction = (raw.direction ?? 'both') as 'out' | 'in' | 'both';
      const layer = (raw.layer ?? 'both') as Layer;

      const quads = await fetchAllQuads();
      const NODE_CAP = 500;

      const visitedNodes = new Set<string>([startIri]);
      const resultEdges: Array<{ subject: string; predicate: string; object: string; layer: Layer }> = [];
      let frontier = [startIri];
      let truncated = false;

      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const nextFrontier: string[] = [];
        for (const node of frontier) {
          // outgoing edges
          if (direction === 'out' || direction === 'both') {
            for (const q of quads) {
              if (q.subject !== node) continue;
              if (!edgeMatchesLayer(q.predicate, layer)) continue;
              if (!isIri(q.object)) continue;
              resultEdges.push({ subject: q.subject, predicate: q.predicate, object: q.object, layer: classifyEdgeLayer(q.predicate) });
              if (!visitedNodes.has(q.object)) {
                visitedNodes.add(q.object);
                nextFrontier.push(q.object);
                if (visitedNodes.size >= NODE_CAP) { truncated = true; break; }
              }
            }
          }
          if (truncated) break;
          // incoming edges
          if (direction === 'in' || direction === 'both') {
            for (const q of quads) {
              if (q.object !== node) continue;
              if (!isIri(q.subject)) continue;
              if (!edgeMatchesLayer(q.predicate, layer)) continue;
              resultEdges.push({ subject: q.subject, predicate: q.predicate, object: q.object, layer: classifyEdgeLayer(q.predicate) });
              if (!visitedNodes.has(q.subject)) {
                visitedNodes.add(q.subject);
                nextFrontier.push(q.subject);
                if (visitedNodes.size >= NODE_CAP) { truncated = true; break; }
              }
            }
          }
          if (truncated) break;
        }
        frontier = truncated ? [] : nextFrontier;
      }

      const nodes = [...visitedNodes].map(iri => ({
        iri,
        label: getLabelFromQuads(iri, quads),
        types: getTypesFromQuads(iri, quads),
        layer: classifyEdgeLayer(RDF_TYPE) === 'tbox'
          ? (getTypesFromQuads(iri, quads).some(t => TBOX_PREDICATES.has(t)) ? 'tbox' : 'abox')
          : 'abox',
      }));

      return { success: true, data: { nodes, edges: resultEdges, truncated } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// findPath
// ---------------------------------------------------------------------------
const findPath: McpTool = {
  name: 'findPath',
  description: 'Find the shortest path between two nodes in the RDF graph using BFS. Crosses ABox and TBox edges freely. Returns ordered list of hops.',
  inputSchema: {
    type: 'object',
    required: ['fromIri', 'toIri'],
    properties: {
      fromIri: { type: 'string', description: 'Start node IRI. Prefix notation supported.' },
      toIri: { type: 'string', description: 'End node IRI. Prefix notation supported.' },
      maxDepth: { type: 'integer', default: 6, description: 'Maximum BFS depth (default 6).' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const raw = (params ?? {}) as { fromIri?: string; toIri?: string; maxDepth?: number };
      if (!raw.fromIri) return { success: false, error: 'fromIri is required' };
      if (!raw.toIri) return { success: false, error: 'toIri is required' };
      const fromIri = expandIri(raw.fromIri);
      if (fromIri.startsWith('Unknown prefix:')) return { success: false, error: fromIri };
      const toIri = expandIri(raw.toIri);
      if (toIri.startsWith('Unknown prefix:')) return { success: false, error: toIri };
      const maxDepth = raw.maxDepth ?? 6;

      if (fromIri === toIri) {
        return { success: true, data: { found: true, path: [{ node: fromIri, nodeLabel: '', via: null, direction: null }] } };
      }

      const quads = await fetchAllQuads();

      // BFS: each queue entry is a path (array of hops)
      type Hop = { node: string; nodeLabel: string; via: string | null; direction: 'out' | 'in' | null };
      const visited = new Set<string>([fromIri]);
      const queue: Hop[][] = [[{ node: fromIri, nodeLabel: getLabelFromQuads(fromIri, quads), via: null, direction: null }]];

      while (queue.length > 0) {
        const path = queue.shift()!;
        if (path.length > maxDepth) break;
        const current = path[path.length - 1].node;

        // outgoing
        for (const q of quads) {
          if (q.subject !== current || !isIri(q.object)) continue;
          const next = q.object;
          const newPath: Hop[] = [...path, { node: next, nodeLabel: getLabelFromQuads(next, quads), via: q.predicate, direction: 'out' }];
          if (next === toIri) return { success: true, data: { found: true, path: newPath } };
          if (!visited.has(next)) { visited.add(next); queue.push(newPath); }
        }
        // incoming
        for (const q of quads) {
          if (q.object !== current || !isIri(q.subject)) continue;
          const next = q.subject;
          const newPath: Hop[] = [...path, { node: next, nodeLabel: getLabelFromQuads(next, quads), via: q.predicate, direction: 'in' }];
          if (next === toIri) return { success: true, data: { found: true, path: newPath } };
          if (!visited.has(next)) { visited.add(next); queue.push(newPath); }
        }
      }

      return { success: true, data: { found: false, path: [] } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const navigationTools: McpTool[] = [getNeighbors, findPath];
