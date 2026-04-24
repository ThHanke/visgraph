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
    sparqlQuery: vi.fn().mockResolvedValue({ type: 'select', rows: [] }),
    getNamespaces: vi.fn().mockReturnValue([]),
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

  function mockSelect(rows: Array<Record<string, string>>) {
    (rdfManager.sparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'select', rows });
  }

  function mockConstruct(triples: Array<{ s: string; p: string; o: string }>) {
    (rdfManager.sparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'construct', triples });
  }

  function mockUpdate() {
    (rdfManager.sparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'update' });
  }

  it('returns rows for SELECT *', async () => {
    mockSelect([
      { s: EX + 'Alice', p: RDFS_LABEL, o: 'Alice' },
      { s: EX + 'Bob', p: RDFS_LABEL, o: 'Bob' },
    ]);
    const result = await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }' }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]).toMatchObject({ s: EX + 'Alice', p: RDFS_LABEL, o: 'Alice' });
  });

  it('SELECT with bound subject returns matching rows', async () => {
    mockSelect([
      { p: RDFS_LABEL, o: 'Alice' },
      { p: EX + 'age', o: '30' },
    ]);
    const result = await tool('queryGraph').handler({
      sparql: `SELECT ?p ?o WHERE { <${EX}Alice> ?p ?o }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows.map((r: any) => r.p)).toContain(RDFS_LABEL);
  });

  it('truncates results when limit is exceeded', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ s: EX + `s${i}`, p: EX + 'p', o: `v${i}` }));
    mockSelect(rows);
    const result = await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }', limit: 3 }) as any;
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(3);
    expect(result.data.truncated).toBe(true);
  });

  it('returns parse error for invalid SPARQL', async () => {
    const result = await tool('queryGraph').handler({ sparql: 'NOT VALID SPARQL' });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('SPARQL parse error');
  });

  it('rejects ASK queries', async () => {
    const result = await tool('queryGraph').handler({ sparql: `ASK { <${EX}Alice> ?p ?o }` });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('ASK');
  });

  it('CONSTRUCT returns triples without writing to store', async () => {
    const EX_MANAGES = EX + 'manages';
    const EX_MANAGED_BY = EX + 'managedBy';
    mockConstruct([{ s: EX + 'Team', p: EX_MANAGED_BY, o: EX + 'Alice' }]);
    const result = await tool('queryGraph').handler({
      sparql: `CONSTRUCT { ?team <${EX_MANAGED_BY}> ?mgr } WHERE { ?mgr <${EX_MANAGES}> ?team }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.triples).toHaveLength(1);
    expect(result.data.triples[0]).toEqual({ s: EX + 'Team', p: EX_MANAGED_BY, o: EX + 'Alice' });
  });

  it('CONSTRUCT returns notice when 0 triples matched', async () => {
    mockConstruct([]);
    const result = await tool('queryGraph').handler({
      sparql: `CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.triples).toHaveLength(0);
    expect(result.data.notice).toMatch(/0 triples/);
  });

  it('INSERT DATA returns updated:true', async () => {
    mockUpdate();
    const result = await tool('queryGraph').handler({
      sparql: `INSERT DATA { <${EX}Alice> <${RDFS_LABEL}> "Alice" }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.updated).toBe(true);
  });

  it('DELETE DATA returns updated:true', async () => {
    mockUpdate();
    const result = await tool('queryGraph').handler({
      sparql: `DELETE DATA { <${EX}Alice> <${RDFS_LABEL}> "Alice" }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.updated).toBe(true);
  });

  it('DELETE WHERE returns updated:true', async () => {
    mockUpdate();
    const result = await tool('queryGraph').handler({
      sparql: `DELETE WHERE { <${EX}Alice> ?p ?o }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.updated).toBe(true);
  });

  it('DELETE...INSERT...WHERE returns updated:true', async () => {
    mockUpdate();
    const result = await tool('queryGraph').handler({
      sparql: `DELETE { <${EX}Alice> <${EX}name> ?old } INSERT { <${EX}Alice> <${EX}name> "Alicia" } WHERE { <${EX}Alice> <${EX}name> ?old }`,
    }) as any;
    expect(result.success).toBe(true);
    expect(result.data.updated).toBe(true);
  });

  it('passes injected prefixes + limit to sparqlQuery worker', async () => {
    mockSelect([]);
    await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }', limit: 50 });
    expect(rdfManager.sparqlQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 50 }),
    );
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
