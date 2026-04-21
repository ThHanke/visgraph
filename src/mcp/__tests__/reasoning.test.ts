// src/mcp/__tests__/reasoning.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClearInferred } = vi.hoisted(() => ({
  mockClearInferred: vi.fn(),
}));

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    runReasoning: vi.fn(),
  },
}));

vi.mock('@/mcp/workspaceContext', () => {
  const dataProvider = { clearInferred: mockClearInferred };
  return {
    getWorkspaceRefs: vi.fn(() => ({
      ctx: {
        model: { requestData: vi.fn().mockResolvedValue(undefined) },
        view: { findAnyCanvas: vi.fn().mockReturnValue(undefined) },
      },
      dataProvider,
    })),
  };
});

import { reasoningTools } from '../tools/reasoning';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const mockRunReasoning = rdfManager.runReasoning as ReturnType<typeof vi.fn>;

const tool = (name: string) => {
  const t = reasoningTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('runReasoning', () => {
  it('returns inferredTriples from meta.addedCount when available', async () => {
    mockRunReasoning.mockResolvedValueOnce({
      id: 'r1',
      timestamp: 0,
      status: 'completed',
      errors: [],
      warnings: [],
      inferences: [],
      meta: { addedCount: 42 },
    });
    const result = await tool('runReasoning').handler({});
    expect(result).toEqual({ success: true, data: { inferredTriples: 42 } });
  });

  it('falls back to inferences.length when meta.addedCount is absent', async () => {
    mockRunReasoning.mockResolvedValueOnce({
      id: 'r2',
      timestamp: 0,
      status: 'completed',
      errors: [],
      warnings: [],
      inferences: [{ type: 'class', subject: 'a', predicate: 'b', object: 'c', confidence: 1 }],
    });
    const result = await tool('runReasoning').handler({});
    expect(result).toEqual({ success: true, data: { inferredTriples: 1 } });
  });

  it('returns error if runReasoning throws', async () => {
    mockRunReasoning.mockRejectedValueOnce(new Error('reasoning error'));
    const result = await tool('runReasoning').handler({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('reasoning error') });
  });
});

// ---------------------------------------------------------------------------
describe('clearInferred', () => {
  it('calls dataProvider.clearInferred() and returns cleared: true', async () => {
    const result = await tool('clearInferred').handler({});
    expect(result).toEqual({ success: true, data: { cleared: true } });
    expect(mockClearInferred).toHaveBeenCalledOnce();
  });

  it('returns error if clearInferred throws', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ctx: {},
      dataProvider: {
        clearInferred: vi.fn(() => { throw new Error('clear error'); }),
      },
    });
    const result = await tool('clearInferred').handler({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('clear error') });
  });
});

// ---------------------------------------------------------------------------
describe('getCapabilities', () => {
  it('returns static layout algorithms and export formats', async () => {
    const result = await tool('getCapabilities').handler({});
    expect(result).toEqual({
      success: true,
      data: {
        layoutAlgorithms: ['dagre-lr', 'dagre-tb', 'elk-layered', 'elk-force', 'elk-stress', 'elk-radial'],
        exportFormats: ['turtle', 'jsonld', 'rdfxml', 'svg', 'png'],
      },
    });
  });
});
