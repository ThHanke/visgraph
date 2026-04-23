// src/mcp/__tests__/shacl.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SHACL_GRAPH = 'urn:vg:shapes';
const DATA_GRAPH = 'urn:vg:data';
const SH_NODESHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const EX = 'http://example.org/';

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    loadRDFIntoGraph: vi.fn().mockResolvedValue(undefined),
    fetchQuadsPage: vi.fn(),
  },
}));

import { rdfManager } from '@/utils/rdfManager';
import { shaclTools } from '../tools/shacl';

const loadShacl = shaclTools.find(t => t.name === 'loadShacl')!;
const validateGraph = shaclTools.find(t => t.name === 'validateGraph')!;

beforeEach(() => {
  vi.clearAllMocks();
  (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
});

// ---------------------------------------------------------------------------
describe('loadShacl', () => {
  it('loads turtle and counts NodeShapes', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { subject: EX + 'PersonShape', predicate: RDF_TYPE, object: SH_NODESHAPE },
        { subject: EX + 'OrgShape', predicate: RDF_TYPE, object: SH_NODESHAPE },
      ],
      total: 2,
    });
    const result = await loadShacl.handler({ turtle: '@prefix sh: <http://www.w3.org/ns/shacl#> .' }) as any;
    expect(result.success).toBe(true);
    expect(result.data.loaded).toBe(2);
    expect(result.data.shapes).toContain(EX + 'PersonShape');
    expect(rdfManager.loadRDFIntoGraph).toHaveBeenCalledWith(expect.any(String), SHACL_GRAPH, 'text/turtle');
  });

  it('returns error when turtle is missing', async () => {
    const result = await loadShacl.handler({});
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('turtle is required');
  });

  it('returns error when loadRDFIntoGraph throws (malformed Turtle)', async () => {
    (rdfManager.loadRDFIntoGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Parse error at line 1'));
    const result = await loadShacl.handler({ turtle: 'NOT VALID TURTLE @@@@' });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Parse error');
  });
});

// ---------------------------------------------------------------------------
describe('validateGraph', () => {
  const SHAPE_TURTLE = `
    @prefix sh: <http://www.w3.org/ns/shacl#> .
    @prefix ex: <http://example.org/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    ex:PersonShape a sh:NodeShape ;
      sh:targetClass ex:Person ;
      sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .
  `;

  function termStr(t: { termType: string; value: string }) {
    return t.termType === 'BlankNode' ? `_:${t.value}` : t.value;
  }

  async function parseShapeQuads(ttl: string) {
    const { Parser } = await import('n3');
    const parser = new Parser();
    return parser.parse(ttl).map(q => ({
      subject: termStr(q.subject),
      predicate: termStr(q.predicate),
      object: termStr(q.object),
    }));
  }

  it('returns conforms=false with violation when node missing required property', async () => {
    const shapeItems = await parseShapeQuads(SHAPE_TURTLE);
    const dataItems = [
      { subject: EX + 'Alice', predicate: RDF_TYPE, object: EX + 'Person' },
      // no rdfs:label — should trigger violation
    ];

    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockImplementation(({ graphName }: { graphName: string }) => {
      if (graphName === SHACL_GRAPH) return Promise.resolve({ items: shapeItems, total: shapeItems.length });
      return Promise.resolve({ items: dataItems, total: dataItems.length });
    });

    const result = await validateGraph.handler({}) as any;
    expect(result.success).toBe(true);
    expect(result.data.conforms).toBe(false);
    expect(result.data.violations).toHaveLength(1);
    expect(result.data.violations[0].focusNode).toBe(EX + 'Alice');
    expect(result.data.violations[0].path).toBe(RDFS_LABEL);
  });

  it('returns conforms=true when all shapes satisfied', async () => {
    const shapeItems = await parseShapeQuads(SHAPE_TURTLE);
    const dataItems = [
      { subject: EX + 'Alice', predicate: RDF_TYPE, object: EX + 'Person' },
      { subject: EX + 'Alice', predicate: RDFS_LABEL, object: 'Alice' },
    ];

    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockImplementation(({ graphName }: { graphName: string }) => {
      if (graphName === SHACL_GRAPH) return Promise.resolve({ items: shapeItems, total: shapeItems.length });
      return Promise.resolve({ items: dataItems, total: dataItems.length });
    });

    const result = await validateGraph.handler({}) as any;
    expect(result.success).toBe(true);
    expect(result.data.conforms).toBe(true);
    expect(result.data.violations).toHaveLength(0);
  });

  it('returns conforms=true with empty violations when no shapes loaded', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const result = await validateGraph.handler({}) as any;
    expect(result.success).toBe(true);
    expect(result.data.conforms).toBe(true);
    expect(result.data.violations).toHaveLength(0);
  });
});
