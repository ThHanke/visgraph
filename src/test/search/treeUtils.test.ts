import { describe, it, expect } from 'vitest';
import {
  buildClassTree,
  filterTreeByKeyword,
  sortTree,
  type TreeNode,
} from '../../components/Canvas/search/treeUtils';
import type { ElementTypeGraph } from '@reactodia/workspace';

const graph: ElementTypeGraph = {
  elementTypes: [
    { id: 'urn:Animal' as any, label: [{ termType: 'Literal', value: 'Animal', language: 'en' } as any] },
    { id: 'urn:Dog' as any, label: [{ termType: 'Literal', value: 'Dog', language: 'en' } as any] },
    { id: 'urn:Cat' as any, label: [{ termType: 'Literal', value: 'Cat', language: 'en' } as any] },
    { id: 'urn:Poodle' as any, label: [{ termType: 'Literal', value: 'Poodle', language: 'en' } as any] },
  ],
  subtypeOf: [
    ['urn:Dog' as any, 'urn:Animal' as any],
    ['urn:Cat' as any, 'urn:Animal' as any],
    ['urn:Poodle' as any, 'urn:Dog' as any],
  ],
};

function makeLabel(id: string): string {
  return id.replace('urn:', '');
}

describe('buildClassTree', () => {
  it('produces a single root for Animal with Dog and Cat as children', () => {
    const roots = buildClassTree(graph, makeLabel);
    expect(roots).toHaveLength(1);
    expect(roots[0].iri).toBe('urn:Animal');
    expect(roots[0].derived).toHaveLength(2);
  });

  it('nests Poodle under Dog', () => {
    const roots = buildClassTree(graph, makeLabel);
    const dog = roots[0].derived.find(n => n.iri === 'urn:Dog');
    expect(dog?.derived[0].iri).toBe('urn:Poodle');
  });

  it('handles cycles without infinite loop', () => {
    const cyclic: ElementTypeGraph = {
      elementTypes: [
        { id: 'urn:A' as any, label: [] },
        { id: 'urn:B' as any, label: [] },
      ],
      subtypeOf: [
        ['urn:A' as any, 'urn:B' as any],
        ['urn:B' as any, 'urn:A' as any],
      ],
    };
    expect(() => buildClassTree(cyclic, makeLabel)).not.toThrow();
  });
});

describe('filterTreeByKeyword', () => {
  it('returns only nodes whose label matches', () => {
    const roots = buildClassTree(graph, makeLabel);
    const filtered = filterTreeByKeyword(roots, 'dog');
    expect(filtered.some(n => n.iri === 'urn:Animal')).toBe(true);
    const animal = filtered.find(n => n.iri === 'urn:Animal')!;
    expect(animal.derived.some(n => n.iri === 'urn:Dog')).toBe(true);
  });

  it('keeps parent nodes when a child matches', () => {
    const roots = buildClassTree(graph, makeLabel);
    const filtered = filterTreeByKeyword(roots, 'poodle');
    const animal = filtered.find(n => n.iri === 'urn:Animal')!;
    const dog = animal?.derived.find(n => n.iri === 'urn:Dog')!;
    expect(dog?.derived.some(n => n.iri === 'urn:Poodle')).toBe(true);
  });

  it('returns empty array when nothing matches', () => {
    const roots = buildClassTree(graph, makeLabel);
    expect(filterTreeByKeyword(roots, 'xyz')).toHaveLength(0);
  });

  it('returns all nodes for empty string', () => {
    const roots = buildClassTree(graph, makeLabel);
    expect(filterTreeByKeyword(roots, '')).toHaveLength(roots.length);
  });
});

describe('sortTree', () => {
  it('sorts siblings alphabetically', () => {
    const roots = buildClassTree(graph, makeLabel);
    const sorted = sortTree(roots);
    const animal = sorted.find(n => n.iri === 'urn:Animal')!;
    expect(animal.derived[0].label).toBe('Cat');
    expect(animal.derived[1].label).toBe('Dog');
  });
});
