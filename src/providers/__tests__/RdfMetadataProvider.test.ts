// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { RdfMetadataProvider } from '../RdfMetadataProvider';

const mockRdfManager = {
  applyBatch: vi.fn().mockResolvedValue(undefined),
  getNamespaces: vi.fn().mockReturnValue({}),
};

describe('RdfMetadataProvider', () => {
  it('instantiates', () => {
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
  it('canConnect always resolves', async () => {
    const p = new RdfMetadataProvider(mockRdfManager as any);
    const result = await p.canConnect({} as any, undefined, undefined, {});
    expect(Array.isArray(result)).toBe(true);
  });
});
