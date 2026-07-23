// src/mcp/__tests__/layout.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPerformLayout, mockElements, MockEntityElement } = vi.hoisted(() => {
  const mockPerformLayout = vi.fn().mockResolvedValue(undefined);
  const mockElements: any[] = [];
  class MockEntityElement {
    readonly iri: string;
    readonly data: { id: string };
    readonly position = { x: 0, y: 0 };
    constructor(iri: string) {
      this.iri = iri;
      this.data = { id: iri };
    }
  }
  return { mockPerformLayout, mockElements, MockEntityElement };
});

vi.mock('@reactodia/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reactodia/workspace')>();
  return {
    ...actual,
    EntityElement: MockEntityElement,
    EntityGroup: class {},
  };
});

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(() => ({
    ctx: {
      performLayout: mockPerformLayout,
      model: { elements: mockElements, links: [] },
    },
    dataProvider: {},
  })),
}));

// Mock the layout factories so no workers are spawned in node
vi.mock('@/components/Canvas/layout/layouts', () => ({
  createDagreLayout: vi.fn((_dir: string, _spacing: number) => vi.fn()),
  createElkLayout: vi.fn((_alg: string, _spacing: number) => vi.fn()),
}));

import { layoutTools } from '../tools/layout';

const tool = (name: string) => {
  const t = layoutTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPerformLayout.mockResolvedValue(undefined);
});

describe('runLayout', () => {
  it('calls performLayout for a valid algorithm (dagre-lr)', async () => {
    const result = await tool('runLayout').handler({ algorithm: 'dagre-lr' });
    expect(result).toEqual({ success: true, data: { algorithm: 'dagre-lr' } });
    expect(mockPerformLayout).toHaveBeenCalledOnce();
    expect(mockPerformLayout).toHaveBeenCalledWith(
      expect.objectContaining({ animate: true, layoutFunction: expect.any(Function) })
    );
  });

  it('calls performLayout for elk-layered', async () => {
    const result = await tool('runLayout').handler({ algorithm: 'elk-layered' });
    expect(result).toEqual({ success: true, data: { algorithm: 'elk-layered' } });
    expect(mockPerformLayout).toHaveBeenCalledOnce();
  });

  it('returns error for unknown algorithm', async () => {
    const result = await tool('runLayout').handler({ algorithm: 'foobar' });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Unknown algorithm: foobar'),
    });
    expect(mockPerformLayout).not.toHaveBeenCalled();
  });

  it('returns error listing valid algorithms when algorithm is unknown', async () => {
    const result = await tool('runLayout').handler({ algorithm: 'nope' });
    expect(result).toMatchObject({ success: false });
    if (!result.success) {
      expect((result as any).error).toContain('dagre-lr');
    }
  });

  it('returns error if performLayout throws', async () => {
    mockPerformLayout.mockRejectedValueOnce(new Error('layout failed'));
    const result = await tool('runLayout').handler({ algorithm: 'dagre-tb' });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('layout failed') });
  });

  it('with fixedIris calls performLayout with wrapped layout function', async () => {
    mockElements.length = 0;
    mockElements.push(new MockEntityElement('urn:a'), new MockEntityElement('urn:b'));

    const result = await tool('runLayout').handler({
      algorithm: 'dagre-lr',
      fixedIris: ['urn:a'],
    });
    expect(result).toEqual({ success: true, data: { algorithm: 'dagre-lr' } });
    expect(mockPerformLayout).toHaveBeenCalledOnce();
    // The layoutFunction should be the withFixedNodes wrapper (a different function)
    expect(mockPerformLayout).toHaveBeenCalledWith(
      expect.objectContaining({ layoutFunction: expect.any(Function) })
    );
  });

  it('with fixedIris not on canvas returns error', async () => {
    mockElements.length = 0;
    mockElements.push(new MockEntityElement('urn:a'));

    const result = await tool('runLayout').handler({
      algorithm: 'dagre-lr',
      fixedIris: ['urn:missing'],
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('fixedIris not on canvas'),
    });
    expect(mockPerformLayout).not.toHaveBeenCalled();
  });

  it('with empty fixedIris array behaves as no fixed nodes', async () => {
    const result = await tool('runLayout').handler({
      algorithm: 'dagre-lr',
      fixedIris: [],
    });
    expect(result).toEqual({ success: true, data: { algorithm: 'dagre-lr' } });
    expect(mockPerformLayout).toHaveBeenCalledOnce();
  });

  it('without fixedIris behaves unchanged', async () => {
    const result = await tool('runLayout').handler({ algorithm: 'dagre-lr' });
    expect(result).toEqual({ success: true, data: { algorithm: 'dagre-lr' } });
    expect(mockPerformLayout).toHaveBeenCalledOnce();
  });
});
