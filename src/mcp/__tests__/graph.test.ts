// src/mcp/__tests__/graph.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks must be declared before importing the module under test ---
vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    loadRDFFromUrl: vi.fn().mockResolvedValue(undefined),
    loadRDFIntoGraph: vi.fn().mockResolvedValue(undefined),
    exportToTurtle: vi.fn().mockResolvedValue('@prefix ex: <http://example.org/> .'),
    exportToJsonLD: vi.fn().mockResolvedValue('{}'),
    exportToRdfXml: vi.fn().mockResolvedValue('<rdf:RDF/>'),
    fetchQuadsPage: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 0 }),
    addTriple: vi.fn(),
  },
}));

const mockCanvas = {
  exportSvg: vi.fn().mockResolvedValue('<svg/>'),
  exportRaster: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
};

const mockLookupAll = vi.fn().mockResolvedValue([]);

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(() => ({
    ctx: {
      model: {
        elements: [],
        requestElementData: vi.fn().mockResolvedValue(undefined),
        requestLinks: vi.fn().mockResolvedValue(undefined),
      },
      view: { findAnyCanvas: () => mockCanvas },
    },
    dataProvider: { lookupAll: mockLookupAll },
  })),
}));

import { graphTools } from '../tools/graph';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const tool = (name: string) => {
  const t = graphTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLookupAll.mockResolvedValue([]);
  (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValue({
    ctx: {
      model: {
        elements: [],
        requestElementData: vi.fn().mockResolvedValue(undefined),
        requestLinks: vi.fn().mockResolvedValue(undefined),
      },
      view: { findAnyCanvas: () => mockCanvas },
    },
    dataProvider: { lookupAll: mockLookupAll },
  });
  mockCanvas.exportSvg.mockResolvedValue('<svg/>');
  mockCanvas.exportRaster.mockResolvedValue('data:image/png;base64,abc');
});

// ---------------------------------------------------------------------------
describe('loadRdf', () => {
  it('calls loadRDFFromUrl when url is provided', async () => {
    const result = await tool('loadRdf').handler({ url: 'http://example.org/data.ttl' });
    expect(rdfManager.loadRDFFromUrl).toHaveBeenCalledWith('http://example.org/data.ttl');
    expect(result).toEqual({ success: true, data: { loaded: 'http://example.org/data.ttl' } });
  });

  it('calls loadRDFIntoGraph when turtle is provided', async () => {
    const turtle = '@prefix ex: <http://example.org/> .';
    const result = await tool('loadRdf').handler({ turtle });
    expect(rdfManager.loadRDFIntoGraph).toHaveBeenCalledWith(turtle, 'urn:vg:data', 'text/turtle');
    expect(result).toMatchObject({
      success: true,
      data: expect.objectContaining({ loaded: 'inline turtle' }),
    });
  });

  it('returns error when neither url nor turtle is provided', async () => {
    const result = await tool('loadRdf').handler({});
    expect(result).toEqual({ success: false, error: 'Provide either url or turtle' });
  });
});

// ---------------------------------------------------------------------------
describe('exportGraph', () => {
  it('calls exportToTurtle for turtle format', async () => {
    const result = await tool('exportGraph').handler({ format: 'turtle' });
    expect(rdfManager.exportToTurtle).toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { content: '@prefix ex: <http://example.org/> .' } });
  });

  it('calls exportToJsonLD for jsonld format', async () => {
    const result = await tool('exportGraph').handler({ format: 'jsonld' });
    expect(rdfManager.exportToJsonLD).toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { content: '{}' } });
  });

  it('calls exportToRdfXml for rdfxml format', async () => {
    const result = await tool('exportGraph').handler({ format: 'rdfxml' });
    expect(rdfManager.exportToRdfXml).toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { content: '<rdf:RDF/>' } });
  });

  it('returns error for unknown format', async () => {
    const result = await tool('exportGraph').handler({ format: 'ntriples' });
    expect(result).toEqual({ success: false, error: 'Unknown format: ntriples' });
  });
});

// ---------------------------------------------------------------------------
describe('queryGraph', () => {
  const EX = 'http://example.org/';
  const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

  function mockQuads(items: Array<{ subject: string; predicate: string; object: string }>) {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items, total: items.length });
  }

  it('returns rows for SELECT *', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: RDFS_LABEL, object: 'Alice' },
      { subject: EX + 'Bob', predicate: RDFS_LABEL, object: 'Bob' },
    ]);
    const result = await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }' }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]).toMatchObject({ s: EX + 'Alice', p: RDFS_LABEL, o: 'Alice' });
  });

  it('SELECT with bound subject returns matching rows', async () => {
    mockQuads([
      { subject: EX + 'Alice', predicate: RDFS_LABEL, object: 'Alice' },
      { subject: EX + 'Alice', predicate: EX + 'age', object: '30' },
      { subject: EX + 'Bob', predicate: RDFS_LABEL, object: 'Bob' },
    ]);
    const result = await tool('queryGraph').handler({
      sparql: `SELECT ?p ?o WHERE { <${EX}Alice> ?p ?o }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows.map((r: any) => r.p)).toContain(RDFS_LABEL);
  });

  it('truncates results when limit is exceeded', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      subject: EX + `s${i}`, predicate: EX + 'p', object: `v${i}`,
    }));
    mockQuads(items);
    const result = await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }', limit: 3 }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(3);
    expect(result.data.truncated).toBe(true);
    expect(result.data.total).toBe(10);
  });

  it('returns parse error for invalid SPARQL', async () => {
    const result = await tool('queryGraph').handler({ sparql: 'NOT VALID SPARQL' });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('SPARQL parse error');
  });

  it('rejects ASK queries', async () => {
    const result = await tool('queryGraph').handler({ sparql: `ASK { <${EX}Alice> ?p ?o }` });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('SELECT and CONSTRUCT');
  });

  it('CONSTRUCT adds triples to store', async () => {
    const EX_MANAGES = EX + 'manages';
    const EX_MANAGED_BY = EX + 'managedBy';
    mockQuads([
      { subject: EX + 'Alice', predicate: EX_MANAGES, object: EX + 'Team' },
    ]);
    const result = await tool('queryGraph').handler({
      sparql: `CONSTRUCT { ?team <${EX_MANAGED_BY}> ?mgr } WHERE { ?mgr <${EX_MANAGES}> ?team }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.added).toBe(1);
    expect(result.data.triples[0]).toEqual({ s: EX + 'Team', p: EX_MANAGED_BY, o: EX + 'Alice' });
    expect(rdfManager.addTriple).toHaveBeenCalledWith(EX + 'Team', EX_MANAGED_BY, EX + 'Alice');
  });
});

// ---------------------------------------------------------------------------
describe('exportImage', () => {
  it('returns svg content for svg format', async () => {
    const result = await tool('exportImage').handler({ format: 'svg' });
    expect(mockCanvas.exportSvg).toHaveBeenCalledWith({ addXmlHeader: true });
    expect(result).toEqual({ success: true, data: { content: '<svg/>' } });
  });

  it('strips style block when noCss is true', async () => {
    mockCanvas.exportSvg.mockResolvedValue('<svg><style>body{color:red}</style><g/></svg>');
    const result = await tool('exportImage').handler({ format: 'svg', noCss: true });
    expect((result as any).data.content).toBe('<svg><g/></svg>');
  });

  it('returns png data uri for png format', async () => {
    const result = await tool('exportImage').handler({ format: 'png' });
    expect(mockCanvas.exportRaster).toHaveBeenCalledWith({ mimeType: 'image/png' });
    expect(result).toEqual({ success: true, data: { content: 'data:image/png;base64,abc' } });
  });

  it('returns error when canvas is unavailable', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValue({
      ctx: { model: { elements: [] }, view: { findAnyCanvas: () => undefined } },
      dataProvider: { lookupAll: mockLookupAll },
    });
    const result = await tool('exportImage').handler({ format: 'svg' });
    expect(result).toEqual({ success: false, error: 'Canvas not available' });
  });

  it('returns error when getWorkspaceRefs throws', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not initialised');
    });
    const result = await tool('exportImage').handler({ format: 'png' });
    expect(result).toEqual({ success: false, error: 'Canvas not available' });
  });
});
