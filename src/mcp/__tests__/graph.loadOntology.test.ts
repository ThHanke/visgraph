// src/mcp/__tests__/graph.loadOntology.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadOntology = vi.fn();

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    loadRDFFromUrl: vi.fn(),
    loadRDFIntoGraph: vi.fn(),
    exportToTurtle: vi.fn(),
    exportToJsonLD: vi.fn(),
    exportToRdfXml: vi.fn(),
    fetchQuadsPage: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 0 }),
    sparqlQuery: vi.fn().mockResolvedValue({ type: 'select', rows: [] }),
    getNamespaces: vi.fn().mockReturnValue([]),
    canonicalize: vi.fn(),
  },
}));

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(() => ({
    ctx: {
      model: {
        elements: [],
        requestElementData: vi.fn().mockResolvedValue(undefined),
        requestLinks: vi.fn().mockResolvedValue(undefined),
      },
      view: { findAnyCanvas: () => ({ exportSvg: vi.fn(), exportRaster: vi.fn() }) },
    },
    dataProvider: { lookupAll: vi.fn().mockResolvedValue([]) },
  })),
}));

vi.mock('@/mcp/provenance', () => ({
  getProvenanceRecorder: () => ({ recordEdit: vi.fn().mockResolvedValue(null) }),
}));

vi.mock('@/stores/ontologyStore', () => ({
  useOntologyStore: {
    getState: vi.fn(() => ({
      loadOntology: mockLoadOntology,
    })),
  },
}));

import { graphTools } from '../tools/graph';

const tool = (name: string) => {
  const t = graphTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadOntology', () => {
  it('returns ontology list in search mode when no params given', async () => {
    const result = await tool('loadOntology').handler({});
    expect(result).toMatchObject({ success: true });
    const data = (result as any).data;
    expect(data.query).toBe('(all)');
    expect(data.count).toBeGreaterThan(0);
    expect(data.ontologies.length).toBeGreaterThan(0);
    expect(data.ontologies[0]).toHaveProperty('prefix');
    expect(data.ontologies[0]).toHaveProperty('namespace');
  });

  it('filters ontologies by keyword query', async () => {
    const result = await tool('loadOntology').handler({ query: 'calendar' });
    expect(result).toMatchObject({ success: true });
    const data = (result as any).data;
    expect(data.query).toBe('calendar');
    expect(data.count).toBeLessThan(55);
  });

  it('loads ontology by URL and returns success', async () => {
    mockLoadOntology.mockResolvedValueOnce({ success: true, url: 'http://purl.org/dc/terms/' });
    const result = await tool('loadOntology').handler({ url: 'dcterms' });
    expect(result).toMatchObject({ success: true, data: { loaded: 'http://purl.org/dc/terms/' } });
    expect(mockLoadOntology).toHaveBeenCalledWith('dcterms');
  });

  it('returns error with suggestions when load fails', async () => {
    mockLoadOntology.mockResolvedValueOnce({ success: false, error: 'Not found' });
    const result = await tool('loadOntology').handler({ url: 'foaf' });
    expect(result).toMatchObject({ success: false });
    expect((result as any).error).toBeDefined();
    expect((result as any).hint).toContain('query');
  });

  it('returns error with suggestions when loadOntology throws', async () => {
    mockLoadOntology.mockRejectedValueOnce(new Error('network error'));
    const result = await tool('loadOntology').handler({ url: 'foaf' });
    expect(result).toMatchObject({ success: false });
    expect((result as any).error).toContain('network error');
    expect((result as any).hint).toContain('query');
  });

  it('treats empty url as search mode', async () => {
    const result = await tool('loadOntology').handler({ url: '  ', query: 'music' });
    expect(result).toMatchObject({ success: true });
    expect((result as any).data.query).toBe('music');
    expect(mockLoadOntology).not.toHaveBeenCalled();
  });
});
