// src/mcp/__tests__/search.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTools } from '@/mcp/tools/search';

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(),
}));

// Mock layout to avoid import issues in node env
vi.mock('@/mcp/tools/layout', () => ({
  focusElementOnCanvas: vi.fn(),
}));

import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const mockGetWorkspaceRefs = vi.mocked(getWorkspaceRefs);

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function makeItem(id: string, label?: string) {
  return {
    element: {
      id,
      types: [],
      properties: label !== undefined ? { [RDFS_LABEL]: [{ value: label }] } : {},
    },
    inLinks: [],
    outLinks: [],
  };
}

function getHandler(name: string) {
  const tool = searchTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler;
}

describe('searchEntities', () => {
  const mockLookup = vi.fn();
  const mockElements = [] as any[];

  beforeEach(() => {
    mockLookup.mockReset();
    mockGetWorkspaceRefs.mockReturnValue({
      ctx: { model: { elements: mockElements } } as never,
      dataProvider: { lookup: mockLookup } as never,
    });
  });

  it('calls lookup with query text and returns iri+label pairs', async () => {
    mockLookup.mockResolvedValue([
      makeItem('http://example.org/alice', 'Alice'),
      makeItem('http://example.org/bob', 'Bob'),
    ]);

    const result = await getHandler('searchEntities')({ query: 'ali', limit: 5 });

    expect(mockLookup).toHaveBeenCalledWith({ text: 'ali', limit: 5 });
    expect(result).toEqual({
      success: true,
      data: {
        results: [
          { iri: 'http://example.org/alice', label: 'Alice', onCanvas: false },
          { iri: 'http://example.org/bob', label: 'Bob', onCanvas: false },
        ],
      },
    });
  });

  it('uses default limit of 20 when not provided', async () => {
    mockLookup.mockResolvedValue([]);
    await getHandler('searchEntities')({ query: 'test' });
    expect(mockLookup).toHaveBeenCalledWith({ text: 'test', limit: 20 });
  });

  it('falls back to IRI when label is absent', async () => {
    mockLookup.mockResolvedValue([makeItem('http://example.org/thing')]);
    const result = await getHandler('searchEntities')({ query: 'thing' });
    expect(result).toEqual({
      success: true,
      data: { results: [{ iri: 'http://example.org/thing', label: 'http://example.org/thing', onCanvas: false }] },
    });
  });

  it('handles empty results gracefully', async () => {
    mockLookup.mockResolvedValue([]);
    const result = await getHandler('searchEntities')({ query: 'nothing' });
    expect(result).toEqual({ success: true, data: { results: [] } });
  });
});

describe('autocomplete', () => {
  const mockLookup = vi.fn();

  beforeEach(() => {
    mockLookup.mockReset();
    mockGetWorkspaceRefs.mockReturnValue({
      ctx: { model: { elements: [] } } as never,
      dataProvider: { lookup: mockLookup } as never,
    });
  });

  it('calls lookup with text and returns completions', async () => {
    mockLookup.mockResolvedValue([makeItem('http://example.org/carbon', 'Carbon')]);

    const result = await getHandler('autocomplete')({ text: 'car', limit: 3 });

    expect(mockLookup).toHaveBeenCalledWith({ text: 'car', limit: 3 });
    expect(result).toEqual({
      success: true,
      data: {
        completions: [{ iri: 'http://example.org/carbon', label: 'Carbon' }],
      },
    });
  });

  it('uses default limit of 10 when not provided', async () => {
    mockLookup.mockResolvedValue([]);
    await getHandler('autocomplete')({ text: 'foo' });
    expect(mockLookup).toHaveBeenCalledWith({ text: 'foo', limit: 10 });
  });

  it('falls back to IRI when label is absent', async () => {
    mockLookup.mockResolvedValue([makeItem('http://example.org/unlabelled')]);
    const result = await getHandler('autocomplete')({ text: 'unlab' });
    expect(result).toEqual({
      success: true,
      data: {
        completions: [{ iri: 'http://example.org/unlabelled', label: 'http://example.org/unlabelled' }],
      },
    });
  });

  it('handles empty results gracefully', async () => {
    mockLookup.mockResolvedValue([]);
    const result = await getHandler('autocomplete')({ text: 'zzz' });
    expect(result).toEqual({ success: true, data: { completions: [] } });
  });
});
