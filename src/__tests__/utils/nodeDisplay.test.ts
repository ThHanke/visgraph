import { describe, it, expect } from 'vitest';
import { computeDisplayInfo, computeDisplayInfoMemo, clearDisplayInfoCache } from '../../../src/components/Canvas/core/nodeDisplay';

describe('nodeDisplay.computeDisplayInfo', () => {
  it('prefers the first non-NamedIndividual rdf:type', () => {
    const node = { rdfTypes: ['owl:NamedIndividual', 'http://example.org/Person'] };
    const info = computeDisplayInfo(node, undefined, []);
    expect(info.canonicalTypeUri).toBe('http://example.org/Person');
    expect(info.short).toBe('Person');
  });

  it('prefers displayType over rdfTypes', () => {
    const node = { displayType: 'http://example.org/Display', rdfTypes: ['http://example.org/Person'] };
    const info = computeDisplayInfo(node, undefined, []);
    expect(info.canonicalTypeUri).toBe('http://example.org/Display');
    expect(info.short).toBe('Display');
  });

  it('returns empty info when only NamedIndividual is present', () => {
    const node = { rdfTypes: ['owl:NamedIndividual'] };
    const info = computeDisplayInfo(node, undefined, []);
    expect(info.canonicalTypeUri).toBeUndefined();
    expect(info.short).toBeUndefined();
    expect(info.prefixed).toBeUndefined();
  });

  it('maps full URI to prefixed form when rdfManager provides namespace', () => {
    const fakeMgr = {
      getNamespaces: () => ({ ex: 'http://example.com/' })
    } as any;
    const node = { rdfTypes: ['http://example.com/TestClass'] };
    const info = computeDisplayInfo(node, fakeMgr, []);
    expect(info.canonicalTypeUri).toBe('http://example.com/TestClass');
    expect(info.prefixed).toBe('ex:TestClass');
    expect(info.namespace).toBe('ex');
    expect(info.short).toBe('TestClass');
  });

  it('handles mixed shapes: types array and rdfType/type fields', () => {
    const n1 = { types: ['http://example.org/TypeA', 'owl:NamedIndividual'] };
    const info1 = computeDisplayInfo(n1 as any, undefined, []);
    expect(info1.canonicalTypeUri).toBe('http://example.org/TypeA');
    expect(info1.short).toBe('TypeA');

    const n2 = { rdfType: 'http://example.org/TypeB' };
    const info2 = computeDisplayInfo(n2 as any, undefined, []);
    expect(info2.canonicalTypeUri).toBe('http://example.org/TypeB');
    expect(info2.short).toBe('TypeB');

    const n3 = { type: 'http://example.org/TypeC' };
    const info3 = computeDisplayInfo(n3 as any, undefined, []);
    expect(info3.canonicalTypeUri).toBe('http://example.org/TypeC');
    expect(info3.short).toBe('TypeC');
  });

  it('computeDisplayInfoMemo caches results and clearDisplayInfoCache clears cache', () => {
    clearDisplayInfoCache();
    const node = { rdfTypes: ['http://example.org/CachedType'] };
    const fakeMgr = { getNamespaces: () => ({}) } as any;

    const a = computeDisplayInfoMemo(node, fakeMgr, []);
    const b = computeDisplayInfoMemo(node, fakeMgr, []);
    // Results content should be equal
    expect(a).toEqual(b);

    // Clearing cache and calling again should still produce equal value, but the cache was cleared in-between
    clearDisplayInfoCache();
    const c = computeDisplayInfoMemo(node, fakeMgr, []);
    expect(c).toEqual(a);
  });
});
