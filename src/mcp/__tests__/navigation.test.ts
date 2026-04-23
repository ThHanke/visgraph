// src/mcp/__tests__/navigation.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    fetchQuadsPage: vi.fn(),
  },
}));

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(),
}));

import { rdfManager } from '@/utils/rdfManager';
import { navigationTools } from '../tools/navigation';

const getNeighbors = navigationTools.find(t => t.name === 'getNeighbors')!;
const findPath = navigationTools.find(t => t.name === 'findPath')!;

const EX = 'http://example.org/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';

function mockQuads(items: Array<{ subject: string; predicate: string; object: string }>) {
  (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items, total: items.length });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('getNeighbors', () => {
  it('returns start node plus direct neighbors (depth 1)', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Alice', predicate: RDFS_LABEL, object: 'Alice' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 1 }) as any;
    expect(result.success).toBe(true);
    const iris = result.data.nodes.map((n: any) => n.iri);
    expect(iris).toContain(EX + 'Alice');
    expect(iris).toContain(EX + 'Bob');
    expect(result.data.edges).toHaveLength(1);
    expect(result.data.edges[0]).toMatchObject({ subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' });
  });

  it('filters layer=tbox — returns only schema edges', async () => {
    mockQuads([
      { subject: EX + 'Person', predicate: RDFS_SUBCLASS, object: EX + 'Agent' },
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Person', depth: 1, layer: 'tbox' }) as any;
    expect(result.success).toBe(true);
    const edgePredicates = result.data.edges.map((e: any) => e.predicate);
    expect(edgePredicates).toContain(RDFS_SUBCLASS);
    expect(edgePredicates).not.toContain(EX + 'knows');
  });

  it('filters layer=abox — excludes rdfs:subClassOf', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Alice', predicate: RDFS_SUBCLASS, object: EX + 'Agent' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 1, layer: 'abox' }) as any;
    expect(result.success).toBe(true);
    const edgePredicates = result.data.edges.map((e: any) => e.predicate);
    expect(edgePredicates).toContain(EX + 'knows');
    expect(edgePredicates).not.toContain(RDFS_SUBCLASS);
  });

  it('direction=out only follows subject→object', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Carol', predicate: EX + 'knows', object: EX + 'Alice' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 1, direction: 'out' }) as any;
    const iris = result.data.nodes.map((n: any) => n.iri);
    expect(iris).toContain(EX + 'Bob');
    expect(iris).not.toContain(EX + 'Carol');
  });

  it('direction=in only follows object→subject', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Carol', predicate: EX + 'knows', object: EX + 'Alice' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 1, direction: 'in' }) as any;
    const iris = result.data.nodes.map((n: any) => n.iri);
    expect(iris).toContain(EX + 'Carol');
    expect(iris).not.toContain(EX + 'Bob');
  });

  it('depth 2 returns transitive neighbors', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Bob', predicate: EX + 'knows', object: EX + 'Carol' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 2, direction: 'out' }) as any;
    const iris = result.data.nodes.map((n: any) => n.iri);
    expect(iris).toContain(EX + 'Carol');
  });

  it('returns error when iri is missing', async () => {
    const result = await getNeighbors.handler({});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('iri is required');
  });

  it('truncates at 500 nodes and sets truncated=true', async () => {
    const items = Array.from({ length: 600 }, (_, i) => ({
      subject: EX + 'root',
      predicate: EX + 'link',
      object: EX + `node${i}`,
    }));
    mockQuads(items);
    const result = await getNeighbors.handler({ iri: EX + 'root', depth: 1 }) as any;
    expect(result.success).toBe(true);
    expect(result.data.truncated).toBe(true);
    expect(result.data.nodes.length).toBeLessThanOrEqual(500);
  });

  it('skips literal objects (non-IRI)', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: RDFS_LABEL, object: 'Alice' },
      { subject: EX + 'Alice', predicate: EX + 'age', object: '30' },
    ]);
    const result = await getNeighbors.handler({ iri: EX + 'Alice', depth: 1, direction: 'out' }) as any;
    expect(result.success).toBe(true);
    // Only start node, no literals as neighbor nodes
    expect(result.data.nodes).toHaveLength(1);
    expect(result.data.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('findPath', () => {
  it('finds direct path between connected nodes', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
    ]);
    const result = await findPath.handler({ fromIri: EX + 'Alice', toIri: EX + 'Bob' }) as any;
    expect(result.success).toBe(true);
    expect(result.data.found).toBe(true);
    expect(result.data.path).toHaveLength(2);
    expect(result.data.path[1]).toMatchObject({ node: EX + 'Bob', via: EX + 'knows', direction: 'out' });
  });

  it('finds multi-hop path', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
      { subject: EX + 'Bob', predicate: EX + 'knows', object: EX + 'Carol' },
    ]);
    const result = await findPath.handler({ fromIri: EX + 'Alice', toIri: EX + 'Carol' }) as any;
    expect(result.data.found).toBe(true);
    expect(result.data.path).toHaveLength(3);
  });

  it('finds path via incoming edges', async () => {
    mockQuads([
      { subject: EX + 'Bob', predicate: EX + 'knows', object: EX + 'Alice' },
    ]);
    const result = await findPath.handler({ fromIri: EX + 'Alice', toIri: EX + 'Bob' }) as any;
    expect(result.data.found).toBe(true);
    expect(result.data.path[1]).toMatchObject({ direction: 'in' });
  });

  it('returns found=false when nodes are disconnected', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: EX + 'knows', object: EX + 'Bob' },
    ]);
    const result = await findPath.handler({ fromIri: EX + 'Alice', toIri: EX + 'Carol', maxDepth: 3 }) as any;
    expect(result.data.found).toBe(false);
    expect(result.data.path).toHaveLength(0);
  });

  it('returns trivial path when fromIri === toIri', async () => {
    mockQuads([]);
    const result = await findPath.handler({ fromIri: EX + 'Alice', toIri: EX + 'Alice' }) as any;
    expect(result.data.found).toBe(true);
    expect(result.data.path).toHaveLength(1);
  });

  it('returns error when fromIri is missing', async () => {
    const result = await findPath.handler({ toIri: EX + 'Bob' });
    expect(result.success).toBe(false);
  });

  it('returns error when toIri is missing', async () => {
    const result = await findPath.handler({ fromIri: EX + 'Alice' });
    expect(result.success).toBe(false);
  });
});
