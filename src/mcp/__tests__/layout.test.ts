// src/mcp/__tests__/layout.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPerformLayout = vi.fn().mockResolvedValue(undefined);

vi.mock('@/mcp/workspaceContext', () => ({
  getWorkspaceRefs: vi.fn(() => ({
    ctx: { performLayout: mockPerformLayout },
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
      expect(result.error).toContain('dagre-lr');
    }
  });

  it('returns error if performLayout throws', async () => {
    mockPerformLayout.mockRejectedValueOnce(new Error('layout failed'));
    const result = await tool('runLayout').handler({ algorithm: 'dagre-tb' });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('layout failed') });
  });
});
