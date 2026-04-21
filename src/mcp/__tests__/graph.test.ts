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
      model: { elements: [] },
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
      model: { elements: [] },
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
  it('returns stub error message', async () => {
    const result = await tool('queryGraph').handler({ sparql: 'SELECT * WHERE { ?s ?p ?o }' });
    expect(result).toEqual({
      success: false,
      error: 'SPARQL SELECT not yet supported — use getNodes/getLinks to query the graph',
    });
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
