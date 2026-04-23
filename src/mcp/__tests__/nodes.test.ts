// src/mcp/__tests__/nodes.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock rdfManager
vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    addTriple: vi.fn(),
    removeAllQuadsForIri: vi.fn().mockResolvedValue(undefined),
    fetchQuadsPage: vi.fn(),
    applyBatch: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock workspaceContext
vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(),
}));

vi.mock('@/mcp/tools/layout', () => ({
  focusElementOnCanvas: vi.fn(),
}));

import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { nodeTools } from '../tools/nodes';

const addNode = nodeTools.find((t) => t.name === 'addNode')!;
const removeNode = nodeTools.find((t) => t.name === 'removeNode')!;
const getNodes = nodeTools.find((t) => t.name === 'getNodes')!;
const getNodeDetails = nodeTools.find((t) => t.name === 'getNodeDetails')!;
const updateNode = nodeTools.find((t) => t.name === 'updateNode')!;

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function makeItem(id: string, label: string | undefined, types: string[]) {
  return {
    element: {
      id,
      types,
      properties: label !== undefined ? { [RDFS_LABEL]: [{ value: label }] } : {},
    },
    inLinks: [],
    outLinks: [],
  };
}

const mockLookupAll = vi.fn();
const mockLookup = vi.fn();

const mockModel = {
  elements: [] as any[],
  createElement: vi.fn(),
  removeElement: vi.fn(),
  requestElementData: vi.fn().mockResolvedValue(undefined),
  requestLinks: vi.fn().mockResolvedValue(undefined),
  history: { execute: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockModel.elements = [];
  mockModel.createElement.mockReset();
  mockModel.removeElement.mockReset();
  mockModel.requestElementData.mockResolvedValue(undefined);
  mockModel.requestLinks.mockResolvedValue(undefined);
  mockModel.history.execute.mockReset();
  (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValue({
    ctx: { model: mockModel, view: {} },
    dataProvider: { lookupAll: mockLookupAll, lookup: mockLookup },
  });
  (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, offset: 0, limit: 0 });
  (rdfManager.applyBatch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

describe('addNode', () => {
  it('calls addTriple twice when iri, typeIri, and label are provided', async () => {
    const result = await addNode.handler({
      iri: 'http://example.org/foo',
      typeIri: 'http://www.w3.org/2002/07/owl#Class',
      label: 'Foo',
    });

    expect(rdfManager.addTriple).toHaveBeenCalledTimes(2);
    expect(rdfManager.addTriple).toHaveBeenCalledWith(
      'http://example.org/foo',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'http://www.w3.org/2002/07/owl#Class'
    );
    expect(rdfManager.addTriple).toHaveBeenCalledWith(
      'http://example.org/foo',
      'http://www.w3.org/2000/01/rdf-schema#label',
      'Foo'
    );
    expect(result).toEqual({ success: true, data: { iri: 'http://example.org/foo' } });
  });

  it('returns error when iri is missing', async () => {
    const result = await addNode.handler({});
    expect(result).toEqual({ success: false, error: 'iri is required' });
    expect(rdfManager.addTriple).not.toHaveBeenCalled();
  });
});

describe('removeNode', () => {
  it('calls removeAllQuadsForIri with the given iri', async () => {
    const result = await removeNode.handler({ iri: 'http://example.org/bar' });
    expect(rdfManager.removeAllQuadsForIri).toHaveBeenCalledWith('http://example.org/bar');
    expect(result).toEqual({ success: true, data: { removed: 'http://example.org/bar' } });
  });
});

describe('getNodes', () => {
  const sampleItems = [
    makeItem('http://example.org/a', 'Alpha', ['http://www.w3.org/2002/07/owl#Class']),
    makeItem('http://example.org/b', 'Beta', ['http://www.w3.org/2002/07/owl#NamedIndividual']),
    makeItem('http://example.org/c', 'Gamma', ['http://www.w3.org/2002/07/owl#Class']),
  ];

  it('returns all entities as JSON in content field', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({}) as { success: true; data: { content: string } };
    expect(result.success).toBe(true);
    const entities = JSON.parse(result.data.content);
    expect(entities).toHaveLength(3);
    expect(entities[0]).toEqual({ iri: 'http://example.org/a', label: 'Alpha', types: ['http://www.w3.org/2002/07/owl#Class'] });
  });

  it('filters by labelContains (case-insensitive)', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({ labelContains: 'alp' }) as { success: true; data: { content: string } };
    expect(result.success).toBe(true);
    const entities = JSON.parse(result.data.content);
    expect(entities).toHaveLength(1);
    expect(entities[0].iri).toBe('http://example.org/a');
  });

  it('filters by typeIri', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({ typeIri: 'http://www.w3.org/2002/07/owl#NamedIndividual' }) as { success: true; data: { content: string } };
    expect(result.success).toBe(true);
    const entities = JSON.parse(result.data.content);
    expect(entities).toHaveLength(1);
    expect(entities[0].iri).toBe('http://example.org/b');
  });

  it('falls back to fuzzy lookup when labelContains finds nothing, sets fuzzyFallback:true', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    mockLookup.mockResolvedValue([makeItem('http://example.org/a', 'Alpha', [])]);
    const result = await getNodes.handler({ labelContains: 'Alphx' }) as { success: true; data: { content: string; fuzzyFallback?: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.fuzzyFallback).toBe(true);
    const entities = JSON.parse(result.data.content);
    expect(entities).toHaveLength(1);
    expect(entities[0].iri).toBe('http://example.org/a');
    expect(mockLookup).toHaveBeenCalledWith({ text: 'Alphx', limit: 1 });
  });

  it('does not set fuzzyFallback when exact labelContains match found', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({ labelContains: 'Alpha' }) as { success: true; data: { content: string; fuzzyFallback?: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.fuzzyFallback).toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('returns empty list with fuzzyFallback:true when fuzzy also finds nothing', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    mockLookup.mockResolvedValue([]);
    const result = await getNodes.handler({ labelContains: 'zzz' }) as { success: true; data: { content: string; fuzzyFallback?: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.fuzzyFallback).toBe(true);
    const entities = JSON.parse(result.data.content);
    expect(entities).toHaveLength(0);
  });

  it('does not run fuzzy fallback when no labelContains provided', async () => {
    mockLookupAll.mockResolvedValue([]);
    const result = await getNodes.handler({}) as { success: true; data: { content: string; fuzzyFallback?: boolean } };
    expect(result.success).toBe(true);
    expect(result.data.fuzzyFallback).toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('getNodeDetails', () => {
  it('returns label, types, and all properties from asserted graph', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { subject: 'http://example.org/Alice', predicate: RDF_TYPE, object: 'http://example.org/Person', graph: 'urn:vg:data' },
        { subject: 'http://example.org/Alice', predicate: RDFS_LABEL, object: 'Alice', graph: 'urn:vg:data' },
        { subject: 'http://example.org/Alice', predicate: 'http://example.org/age', object: '30', graph: 'urn:vg:data' },
      ],
      total: 3,
    });

    const result = await getNodeDetails.handler({ iri: 'http://example.org/Alice' });
    expect(result).toEqual({
      success: true,
      data: {
        iri: 'http://example.org/Alice',
        label: 'Alice',
        types: ['http://example.org/Person'],
        properties: [
          { predicate: RDF_TYPE, object: 'http://example.org/Person', objectType: 'iri' },
          { predicate: RDFS_LABEL, object: 'Alice', objectType: 'literal' },
          { predicate: 'http://example.org/age', object: '30', objectType: 'literal' },
        ],
      },
    });
  });

  it('returns empty properties array for node with no triples', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    const result = await getNodeDetails.handler({ iri: 'http://example.org/Empty' });
    expect(result).toEqual({
      success: true,
      data: { iri: 'http://example.org/Empty', label: '', types: [], properties: [] },
    });
  });

  it('returns error when iri is missing', async () => {
    const result = await getNodeDetails.handler({});
    expect(result).toEqual({ success: false, error: 'iri is required' });
  });

  it('expands prefixed IRI before querying', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    await getNodeDetails.handler({ iri: 'ex:Alice' });
    expect(rdfManager.fetchQuadsPage).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { subject: 'http://example.org/Alice' } })
    );
  });

  it('classifies blank-node objects correctly', async () => {
    (rdfManager.fetchQuadsPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { subject: 'http://example.org/X', predicate: 'http://example.org/p', object: '_:b0', graph: 'urn:vg:data' },
      ],
      total: 1,
    });
    const result = await getNodeDetails.handler({ iri: 'http://example.org/X' }) as any;
    expect(result.data.properties[0].objectType).toBe('bnode');
  });
});

describe('updateNode', () => {
  it('updates label via applyBatch and refreshes canvas', async () => {
    const result = await updateNode.handler({
      iri: 'http://example.org/Alice',
      label: 'Alicia',
    });

    expect(rdfManager.applyBatch).toHaveBeenCalledWith(
      {
        removes: [{ s: 'http://example.org/Alice', p: RDFS_LABEL }],
        adds: [{ s: 'http://example.org/Alice', p: RDFS_LABEL, o: 'Alicia' }],
      },
      'urn:vg:data'
    );
    expect(mockModel.requestElementData).toHaveBeenCalledWith(['http://example.org/Alice']);
    expect(result).toEqual({
      success: true,
      data: { updated: 'http://example.org/Alice', changed: [RDFS_LABEL] },
    });
  });

  it('replaces typeIri', async () => {
    await updateNode.handler({ iri: 'http://example.org/Bob', typeIri: 'http://example.org/Director' });
    expect(rdfManager.applyBatch).toHaveBeenCalledWith(
      {
        removes: [{ s: 'http://example.org/Bob', p: RDF_TYPE }],
        adds: [{ s: 'http://example.org/Bob', p: RDF_TYPE, o: 'http://example.org/Director' }],
      },
      'urn:vg:data'
    );
  });

  it('handles setProperties and removeProperties', async () => {
    await updateNode.handler({
      iri: 'http://example.org/Carol',
      setProperties: [{ predicateIri: 'http://example.org/age', value: '35' }],
      removeProperties: [{ predicateIri: 'http://example.org/retired' }],
    });

    const call = (rdfManager.applyBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.removes).toContainEqual({ s: 'http://example.org/Carol', p: 'http://example.org/age' });
    expect(call.removes).toContainEqual({ s: 'http://example.org/Carol', p: 'http://example.org/retired' });
    expect(call.adds).toContainEqual({ s: 'http://example.org/Carol', p: 'http://example.org/age', o: '35' });
    expect(call.adds).not.toContainEqual(expect.objectContaining({ p: 'http://example.org/retired' }));
  });

  it('returns error when no mutation fields are provided', async () => {
    const result = await updateNode.handler({ iri: 'http://example.org/Alice' });
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('at least one field'),
    });
    expect(rdfManager.applyBatch).not.toHaveBeenCalled();
  });

  it('returns error when iri is missing', async () => {
    const result = await updateNode.handler({});
    expect(result).toEqual({ success: false, error: 'iri is required' });
  });

  it('returns error for unknown prefix in predicateIri', async () => {
    const result = await updateNode.handler({
      iri: 'http://example.org/Alice',
      setProperties: [{ predicateIri: 'unknownns:prop', value: 'x' }],
    });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Unknown prefix');
  });
});
