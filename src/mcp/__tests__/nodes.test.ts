// src/mcp/__tests__/nodes.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock rdfManager
vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    addTriple: vi.fn(),
    removeAllQuadsForIri: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock workspaceContext
vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(),
}));

import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { nodeTools } from '../tools/nodes';

const addNode = nodeTools.find((t) => t.name === 'addNode')!;
const removeNode = nodeTools.find((t) => t.name === 'removeNode')!;
const getNodes = nodeTools.find((t) => t.name === 'getNodes')!;

const mockLookupAll = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValue({
    dataProvider: { lookupAll: mockLookupAll },
  });
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
      '"Foo"'
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
    { id: 'http://example.org/a', label: { value: 'Alpha' }, types: ['http://www.w3.org/2002/07/owl#Class'] },
    { id: 'http://example.org/b', label: { value: 'Beta' }, types: ['http://www.w3.org/2002/07/owl#NamedIndividual'] },
    { id: 'http://example.org/c', label: { value: 'Gamma' }, types: ['http://www.w3.org/2002/07/owl#Class'] },
  ];

  it('returns all entities mapped from lookupAll', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({});
    expect(result).toEqual({
      success: true,
      data: {
        entities: [
          { iri: 'http://example.org/a', label: 'Alpha', types: ['http://www.w3.org/2002/07/owl#Class'] },
          { iri: 'http://example.org/b', label: 'Beta', types: ['http://www.w3.org/2002/07/owl#NamedIndividual'] },
          { iri: 'http://example.org/c', label: 'Gamma', types: ['http://www.w3.org/2002/07/owl#Class'] },
        ],
      },
    });
  });

  it('filters by labelContains (case-insensitive)', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({ labelContains: 'alp' });
    expect(result).toEqual({
      success: true,
      data: {
        entities: [{ iri: 'http://example.org/a', label: 'Alpha', types: ['http://www.w3.org/2002/07/owl#Class'] }],
      },
    });
  });

  it('filters by typeIri', async () => {
    mockLookupAll.mockResolvedValue(sampleItems);
    const result = await getNodes.handler({ typeIri: 'http://www.w3.org/2002/07/owl#NamedIndividual' }) as { success: true; data: { entities: unknown[] } };
    expect(result.success).toBe(true);
    expect((result as any).data.entities).toHaveLength(1);
    expect((result as any).data.entities[0].iri).toBe('http://example.org/b');
  });
});
