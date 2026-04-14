import { describe, it, expect } from 'vitest';
import type { ElementModel, ElementTypeIri } from '@reactodia/workspace';
import {
  filterEntities,
  computeClassHitCounts,
} from '../../components/Canvas/search/useSearchIndex';

function makeEntity(id: string, label: string, types: string[] = []): ElementModel {
  return {
    id: id as any,
    types: types as ElementTypeIri[],
    properties: {
      'http://www.w3.org/2000/01/rdf-schema#label': [
        { termType: 'Literal', value: label, language: 'en' } as any,
      ],
    },
  };
}

const entities: ElementModel[] = [
  makeEntity('urn:alice', 'Alice', ['urn:Person']),
  makeEntity('urn:bob', 'Bob', ['urn:Person', 'urn:Employee']),
  makeEntity('urn:fido', 'Fido', ['urn:Dog']),
  makeEntity('urn:untyped', 'Unknown Entity'),
];

describe('filterEntities — text search', () => {
  it('returns all entities for empty text and no filter', () => {
    expect(filterEntities(entities, '', null, [])).toHaveLength(4);
  });

  it('matches by rdfs:label substring (case-insensitive)', () => {
    const result = filterEntities(entities, 'ali', null, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('urn:alice');
  });

  it('falls back to IRI local name when no rdfs:label', () => {
    const noLabel = [makeEntity('urn:something/FooBar', '')];
    const result = filterEntities(noLabel, 'foobar', null, []);
    expect(result).toHaveLength(1);
  });
});

describe('filterEntities — type filter', () => {
  it('returns only entities of the given type', () => {
    const result = filterEntities(entities, '', { kind: 'type', iri: 'urn:Person' as any }, []);
    expect(result.map(e => e.id)).toEqual(expect.arrayContaining(['urn:alice', 'urn:bob']));
    expect(result).toHaveLength(2);
  });

  it('combines text filter with type filter', () => {
    const result = filterEntities(entities, 'ali', { kind: 'type', iri: 'urn:Person' as any }, []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('urn:alice');
  });
});

describe('filterEntities — predicate filter', () => {
  it('returns entities whose IRI appears as source or target of a matching link', () => {
    const links = [
      { typeId: 'urn:knows', sourceId: 'urn:alice', targetId: 'urn:bob' },
      { typeId: 'urn:owns', sourceId: 'urn:bob', targetId: 'urn:fido' },
    ];
    const result = filterEntities(entities, '', { kind: 'predicate', iri: 'urn:knows' as any }, links as any);
    expect(result.map(e => e.id).sort()).toEqual(['urn:alice', 'urn:bob']);
  });
});

describe('computeClassHitCounts', () => {
  it('counts entities per type IRI', () => {
    const counts = computeClassHitCounts(entities);
    expect(counts.get('urn:Person' as any)).toBe(2);
    expect(counts.get('urn:Dog' as any)).toBe(1);
    expect(counts.get('urn:Employee' as any)).toBe(1);
  });

  it('ignores entities with no types', () => {
    const counts = computeClassHitCounts(entities);
    expect(counts.size).toBe(3);
  });
});
