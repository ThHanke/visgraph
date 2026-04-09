// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { fetchClasses, fetchLinkTypes, scoreLinkTypes } from '../ontologyQueries';
import type { N3DataProvider } from '../../providers/N3DataProvider';

function mockDataProvider(overrides: Partial<N3DataProvider> = {}): N3DataProvider {
  return {
    knownElementTypes: vi.fn().mockResolvedValue({
      elementTypes: [
        { id: 'http://ex.org/Person', label: { en: 'Person' } },
        { id: 'http://ex.org/Animal', label: {} },
      ],
      subtypes: new Map(),
    }),
    knownLinkTypes: vi.fn().mockResolvedValue([
      { id: 'http://ex.org/knows',   label: { en: 'knows' } },
      { id: 'http://ex.org/hasPet',  label: { en: 'hasPet' } },
    ]),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
    factory: { namedNode: (s: string) => ({ value: s }) },
    ...overrides,
  } as unknown as N3DataProvider;
}

describe('fetchClasses', () => {
  it('maps ElementTypeModel to FatMapEntity with iri and label', async () => {
    const dp = mockDataProvider();
    const result = await fetchClasses(dp);
    expect(result).toHaveLength(2);
    expect(result[0].iri).toBe('http://ex.org/Person');
    expect(result[0].label).toBe('Person');
  });

  it('returns empty array when no element types', async () => {
    const dp = mockDataProvider({
      knownElementTypes: vi.fn().mockResolvedValue({ elementTypes: [], subtypes: new Map() }),
    } as any);
    const result = await fetchClasses(dp);
    expect(result).toEqual([]);
  });
});

describe('fetchLinkTypes', () => {
  it('maps LinkTypeModel to FatMapEntity with iri and label', async () => {
    const dp = mockDataProvider();
    const result = await fetchLinkTypes(dp);
    expect(result).toHaveLength(2);
    expect(result[0].iri).toBe('http://ex.org/knows');
    expect(result[0].label).toBe('knows');
  });
});

describe('scoreLinkTypes', () => {
  it('returns entities unchanged when no source or target class', () => {
    const dp = mockDataProvider();
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, undefined, undefined, dp);
    expect(result[0].domainRangeScore).toBeUndefined();
  });

  it('scores exact match as 0', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Person'],
        ranges:  ['http://ex.org/Animal'],
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/hasPet' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(0);
  });

  it('scores unconstrained property as 2', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Person', dp);
    expect(result[0].domainRangeScore).toBe(2);
  });

  it('scores domain-only match as 1', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Person'],
        ranges:  ['http://ex.org/Org'], // mismatch on range
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(1);
  });

  it('scores full mismatch as 3', () => {
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockReturnValue({
        domains: ['http://ex.org/Robot'],
        ranges:  ['http://ex.org/Robot'],
      }),
    } as any);
    const entities = [{ iri: 'http://ex.org/knows' }];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Animal', dp);
    expect(result[0].domainRangeScore).toBe(3);
  });

  it('sorts by score ascending', () => {
    const scores: Record<string, { domains: string[]; ranges: string[] }> = {
      'http://ex.org/a': { domains: ['http://ex.org/X'], ranges: ['http://ex.org/Y'] }, // mismatch → 3
      'http://ex.org/b': { domains: [], ranges: [] }, // unconstrained → 2
      'http://ex.org/c': { domains: ['http://ex.org/Person'], ranges: ['http://ex.org/Person'] }, // exact → 0
    };
    const dp = mockDataProvider({
      getDomainRange: vi.fn().mockImplementation((iri: string) => scores[iri] ?? { domains: [], ranges: [] }),
    } as any);
    const entities = [
      { iri: 'http://ex.org/a' },
      { iri: 'http://ex.org/b' },
      { iri: 'http://ex.org/c' },
    ];
    const result = scoreLinkTypes(entities, 'http://ex.org/Person', 'http://ex.org/Person', dp);
    expect(result.map(e => e.domainRangeScore)).toEqual([0, 2, 3]);
  });
});
