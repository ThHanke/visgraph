// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { N3DataProvider } from '../N3DataProvider';
import { DataFactory } from 'n3';
const { namedNode, quad, defaultGraph } = DataFactory;

describe('N3DataProvider', () => {
  it('instantiates and exposes factory', () => {
    const p = new N3DataProvider();
    expect(p.factory).toBeDefined();
  });
  it('addGraph and clear do not throw', () => {
    const p = new N3DataProvider();
    expect(() => p.addGraph([])).not.toThrow();
    expect(() => p.clear()).not.toThrow();
  });
  it('setViewMode accepts abox and tbox', () => {
    const p = new N3DataProvider();
    expect(() => p.setViewMode('abox')).not.toThrow();
    expect(() => p.setViewMode('tbox')).not.toThrow();
  });
});

const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE  = 'http://www.w3.org/2000/01/rdf-schema#range';
const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

describe('N3DataProvider.getDomainRange', () => {
  it('returns domains and ranges declared for a property', () => {
    const p = new N3DataProvider();
    p.addGraph([
      quad(namedNode('http://ex.org/knows'), namedNode(RDFS_DOMAIN), namedNode('http://ex.org/Person'), defaultGraph()),
      quad(namedNode('http://ex.org/knows'), namedNode(RDFS_RANGE),  namedNode('http://ex.org/Person'), defaultGraph()),
    ]);
    const { domains, ranges } = p.getDomainRange('http://ex.org/knows');
    expect(domains).toEqual(['http://ex.org/Person']);
    expect(ranges).toEqual(['http://ex.org/Person']);
  });

  it('returns empty arrays when no domain/range declared', () => {
    const p = new N3DataProvider();
    const { domains, ranges } = p.getDomainRange('http://ex.org/unknownProp');
    expect(domains).toEqual([]);
    expect(ranges).toEqual([]);
  });
});
