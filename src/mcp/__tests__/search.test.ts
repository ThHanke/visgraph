// src/mcp/__tests__/search.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTools } from '@/mcp/tools/search';

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(),
}));

import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const mockGetWorkspaceRefs = vi.mocked(getWorkspaceRefs);

function getHandler(name: string) {
  const tool = searchTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler;
}

describe('searchEntities', () => {
  const mockLookup = vi.fn();

  beforeEach(() => {
    mockLookup.mockReset();
    mockGetWorkspaceRefs.mockReturnValue({
      ctx: {} as never,
      dataProvider: { lookup: mockLookup } as never,
    });
  });

  it('calls lookup with query text and returns iri+label pairs', async () => {
    mockLookup.mockResolvedValue([
      { id: 'http://example.org/alice', label: { value: 'Alice' }, types: [] },
      { id: 'http://example.org/bob', label: { value: 'Bob' }, types: [] },
    ]);

    const result = await getHandler('searchEntities')({ query: 'ali', limit: 5 });

    expect(mockLookup).toHaveBeenCalledWith({ text: 'ali', limit: 5 });
    expect(result).toEqual({
      success: true,
      data: {
        results: [
          { iri: 'http://example.org/alice', label: 'Alice' },
          { iri: 'http://example.org/bob', label: 'Bob' },
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
    mockLookup.mockResolvedValue([
      { id: 'http://example.org/thing' },
    ]);
    const result = await getHandler('searchEntities')({ query: 'thing' });
    expect(result).toEqual({
      success: true,
      data: { results: [{ iri: 'http://example.org/thing', label: 'http://example.org/thing' }] },
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
      ctx: {} as never,
      dataProvider: { lookup: mockLookup } as never,
    });
  });

  it('calls lookup with text and returns completions', async () => {
    mockLookup.mockResolvedValue([
      { id: 'http://example.org/carbon', label: { value: 'Carbon' } },
    ]);

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
    mockLookup.mockResolvedValue([{ id: 'http://example.org/unlabelled' }]);
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
