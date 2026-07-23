import { describe, it, expect, vi } from 'vitest';
import type { LayoutFunction, LayoutGraph, LayoutState } from '@reactodia/workspace';
import { runSilentLayout } from '../silentLayout';
import { dagreLayout } from '../dagreCore';

// Mock engine that respects fixed nodes (returns them at their input position)
const respectsFixed: LayoutFunction = async (graph, state) => {
  const bounds = { ...state.bounds };
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (!node.fixed) {
      const b = state.bounds[id];
      bounds[id] = { x: (b?.x ?? 0) + 100, y: (b?.y ?? 0) + 50, width: b?.width ?? 120, height: b?.height ?? 40 };
    }
  }
  return { bounds };
};

// Mock engine that ignores fixed flag (moves all nodes)
const ignoresFixed: LayoutFunction = async (_graph, state) => {
  const bounds: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [id, b] of Object.entries(state.bounds)) {
    bounds[id] = { x: b.x + 999, y: b.y + 999, width: b.width, height: b.height };
  }
  return { bounds };
};

describe('runSilentLayout', () => {
  it('mock engine that respects fixed → fixed at seeds, free at engine positions', async () => {
    const result = await runSilentLayout(
      respectsFixed,
      ['a', 'b', 'c'],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      {
        seeds: new Map([['a', { x: 10, y: 20 }], ['b', { x: 50, y: 60 }], ['c', { x: 100, y: 100 }]]),
        fixed: new Set(['a']),
      }
    );

    // Fixed node at seed position
    expect(result.get('a')).toEqual({ x: 10, y: 20 });
    // Free nodes at engine-computed positions (shifted +100, +50)
    expect(result.get('b')).toEqual({ x: 150, y: 110 });
    expect(result.get('c')).toEqual({ x: 200, y: 150 });
  });

  it('mock engine that ignores fixed → fixed still at seeds (safety net)', async () => {
    const result = await runSilentLayout(
      ignoresFixed,
      ['a', 'b', 'c'],
      [{ source: 'a', target: 'b' }],
      {
        seeds: new Map([['a', { x: 10, y: 20 }], ['b', { x: 50, y: 60 }], ['c', { x: 100, y: 100 }]]),
        fixed: new Set(['a']),
      }
    );

    // Fixed node overridden with seed despite engine moving it
    expect(result.get('a')).toEqual({ x: 10, y: 20 });
    // Free nodes at engine positions
    expect(result.get('b')).toEqual({ x: 1049, y: 1059 });
    expect(result.get('c')).toEqual({ x: 1099, y: 1099 });
  });

  it('integration: real Dagre, 5 nodes, 2 fixed → correct positions', async () => {
    const dagreFn: LayoutFunction = async (graph, state) =>
      dagreLayout(graph, state, 'TB', 120);

    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'e' },
    ];
    const seeds = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 200, y: 200 }],
      ['c', { x: 100, y: 100 }],
      ['d', { x: 300, y: 300 }],
      ['e', { x: 400, y: 400 }],
    ]);

    const result = await runSilentLayout(
      dagreFn, nodes, edges,
      { seeds, fixed: new Set(['a', 'c']) }
    );

    // R1: fixed at exact seeds
    expect(result.get('a')).toEqual({ x: 0, y: 0 });
    expect(result.get('c')).toEqual({ x: 100, y: 100 });

    // R4: all nodes present
    for (const id of nodes) {
      expect(result.has(id)).toBe(true);
    }
  });

  it('passes fixed flag and all edges to engine', async () => {
    const spy = vi.fn<LayoutFunction>(
      async (_graph, state) => ({ bounds: state.bounds })
    );

    await runSilentLayout(
      spy,
      ['a', 'b', 'c'],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'c' }],
      {
        seeds: new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 200, y: 0 }]]),
        fixed: new Set(['a']),
      }
    );

    expect(spy).toHaveBeenCalledOnce();
    const [graph] = spy.mock.calls[0] as [LayoutGraph, LayoutState];

    // All nodes passed including fixed
    expect(Object.keys(graph.nodes)).toContain('a');
    expect(Object.keys(graph.nodes)).toContain('b');
    expect(Object.keys(graph.nodes)).toContain('c');

    // Fixed flag set on node 'a'
    expect(graph.nodes['a'].fixed).toBe(true);
    expect(graph.nodes['b'].fixed).toBeFalsy();

    // All edges passed through (no filtering)
    expect(graph.links).toHaveLength(3);
  });

  it('empty iris → empty map', async () => {
    const result = await runSilentLayout(respectsFixed, [], []);
    expect(result.size).toBe(0);
  });

  it('all fixed → seeds returned, engine not called', async () => {
    const spy = vi.fn<LayoutFunction>(
      async (_g, s) => ({ bounds: s.bounds })
    );

    const result = await runSilentLayout(
      spy,
      ['a', 'b'],
      [{ source: 'a', target: 'b' }],
      {
        seeds: new Map([['a', { x: 10, y: 20 }], ['b', { x: 50, y: 60 }]]),
        fixed: new Set(['a', 'b']),
      }
    );

    expect(spy).not.toHaveBeenCalled();
    expect(result.get('a')).toEqual({ x: 10, y: 20 });
    expect(result.get('b')).toEqual({ x: 50, y: 60 });
  });

  it('node with no seed and not fixed → positioned by engine from (0,0)', async () => {
    const result = await runSilentLayout(
      respectsFixed,
      ['a', 'b'],
      [],
      { seeds: new Map([['a', { x: 10, y: 20 }]]), fixed: new Set(['a']) }
    );

    expect(result.get('a')).toEqual({ x: 10, y: 20 });
    // 'b' has no seed → engine gets (0,0), adds +100,+50
    expect(result.get('b')).toEqual({ x: 100, y: 50 });
  });
});
