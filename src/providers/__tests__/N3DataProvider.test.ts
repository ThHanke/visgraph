// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { N3DataProvider } from '../N3DataProvider';

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
