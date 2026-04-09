// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { RdfMetadataProvider } from '../RdfMetadataProvider';
import type { N3DataProvider } from '../N3DataProvider';

const mockRdfManager = {
  applyBatch: vi.fn().mockResolvedValue(undefined),
  getNamespaces: vi.fn().mockReturnValue({}),
};

function mockDataProvider(): N3DataProvider {
  return {
    knownLinkTypes: vi.fn().mockResolvedValue([
      { id: 'http://ex.org/knows', label: { en: 'knows' } },
    ]),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
  } as unknown as N3DataProvider;
}

describe('RdfMetadataProvider', () => {
  it('instantiates without dataProvider', () => {
    expect(new RdfMetadataProvider(mockRdfManager as any)).toBeDefined();
  });

  it('getLiteralLanguages returns at least one language', () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    expect(p.getLiteralLanguages().length).toBeGreaterThan(0);
  });

  it('suppressSync starts false', () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    expect(p.suppressSync).toBe(false);
  });

  it('canConnect resolves to an array when no dataProvider', async () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    const result = await p.canConnect({} as any, undefined, undefined, {});
    expect(Array.isArray(result)).toBe(true);
  });

  it('canConnect returns all link types as outLinks when dataProvider provided', async () => {
    const dp = mockDataProvider();
    const p = new RdfMetadataProvider(mockRdfManager as any, dp);
    const src = { id: 'http://ex.org/alice', types: ['http://ex.org/Person'], properties: {} } as any;
    const tgt = { id: 'http://ex.org/bob',   types: ['http://ex.org/Person'], properties: {} } as any;
    const result = await p.canConnect(src, tgt, undefined, {});
    expect(result[0].outLinks).toContain('http://ex.org/knows');
  });
});
