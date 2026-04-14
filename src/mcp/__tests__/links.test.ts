// src/mcp/__tests__/links.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    addTriple: vi.fn(),
    removeTriple: vi.fn(),
    fetchQuadsPage: vi.fn(),
  },
}));

import { rdfManager } from '@/utils/rdfManager';
import { linkTools } from '../tools/links';

const addLink = linkTools.find((t) => t.name === 'addLink')!;
const removeLink = linkTools.find((t) => t.name === 'removeLink')!;
const getLinks = linkTools.find((t) => t.name === 'getLinks')!;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addLink', () => {
  it('calls addTriple with correct args and returns success', async () => {
    const result = await addLink.handler({
      subjectIri: 'http://s',
      predicateIri: 'http://p',
      objectIri: 'http://o',
    });
    expect(rdfManager.addTriple).toHaveBeenCalledWith('http://s', 'http://p', 'http://o');
    expect(result).toEqual({
      success: true,
      data: { added: { s: 'http://s', p: 'http://p', o: 'http://o' } },
    });
  });

  it('returns error when a param is missing', async () => {
    const result = await addLink.handler({ subjectIri: 'http://s', predicateIri: 'http://p' });
    expect(result).toEqual({
      success: false,
      error: 'subjectIri, predicateIri, and objectIri are all required',
    });
    expect(rdfManager.addTriple).not.toHaveBeenCalled();
  });

  it('returns error when params are null/undefined', async () => {
    const result = await addLink.handler(null);
    expect(result).toEqual({
      success: false,
      error: 'subjectIri, predicateIri, and objectIri are all required',
    });
  });
});

describe('removeLink', () => {
  it('calls removeTriple with correct args and returns success', async () => {
    const result = await removeLink.handler({
      subjectIri: 'http://s',
      predicateIri: 'http://p',
      objectIri: 'http://o',
    });
    expect(rdfManager.removeTriple).toHaveBeenCalledWith('http://s', 'http://p', 'http://o');
    expect(result).toEqual({
      success: true,
      data: { removed: { s: 'http://s', p: 'http://p', o: 'http://o' } },
    });
  });

  it('returns error when a param is missing', async () => {
    const result = await removeLink.handler({ subjectIri: 'http://s' });
    expect(result).toEqual({
      success: false,
      error: 'subjectIri, predicateIri, and objectIri are all required',
    });
    expect(rdfManager.removeTriple).not.toHaveBeenCalled();
  });
});

describe('getLinks', () => {
  it('returns mapped quads from fetchQuadsPage', async () => {
    const mockQuads = [
      { subject: { value: 'http://s1' }, predicate: { value: 'http://p1' }, object: { value: 'http://o1' } },
      { subject: { value: 'http://s2' }, predicate: { value: 'http://p2' }, object: { value: 'http://o2' } },
    ];
    vi.mocked(rdfManager.fetchQuadsPage).mockResolvedValue({ quads: mockQuads as any, hasMore: false });

    const result = await getLinks.handler({ subjectIri: 'http://s1', limit: 50 });
    expect(rdfManager.fetchQuadsPage).toHaveBeenCalledWith({
      subject: 'http://s1',
      predicate: undefined,
      object: undefined,
      limit: 50,
    });
    expect(result).toEqual({
      success: true,
      data: {
        links: [
          { subject: 'http://s1', predicate: 'http://p1', object: 'http://o1' },
          { subject: 'http://s2', predicate: 'http://p2', object: 'http://o2' },
        ],
      },
    });
  });

  it('defaults limit to 100 when not provided', async () => {
    vi.mocked(rdfManager.fetchQuadsPage).mockResolvedValue({ quads: [], hasMore: false });
    await getLinks.handler({});
    expect(rdfManager.fetchQuadsPage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });
});
