/**
 * Test that node colors are derived from namespace registry ONLY.
 * The fat map (availableClasses/availableProperties) has been removed.
 */

import { describe, it, expect } from 'vitest';
import { getNodeColor } from '../../utils/termUtils';
import type { NamespaceRegistryEntry } from '../../utils/termUtils';

describe('Node colors from namespace registry (not fat map)', () => {
  const testRegistry: NamespaceRegistryEntry[] = [
    { prefix: 'ex', uri: 'http://example.com/', namespace: 'http://example.com/', color: '#FF0000' },
    { prefix: 'prov', uri: 'http://www.w3.org/ns/prov#', namespace: 'http://www.w3.org/ns/prov#', color: '#00FF00' },
    { prefix: 'owl', uri: 'http://www.w3.org/2002/07/owl#', namespace: 'http://www.w3.org/2002/07/owl#', color: '#0000FF' },
  ];

  it('should derive color from namespace registry', () => {
    const color = getNodeColor(
      'http://example.com/SomeEntity',
      undefined,
      { registry: testRegistry },
    );

    expect(color).toBe('#FF0000'); // Should get color from namespace registry
  });

  it('should derive color from namespace registry for classType IRI', () => {
    const color = getNodeColor(
      'http://www.w3.org/ns/prov#Activity',
      undefined,
      { registry: testRegistry },
    );

    expect(color).toBe('#00FF00'); // prov namespace color
  });

  it('should use longest matching namespace', () => {
    const registryWithNested: NamespaceRegistryEntry[] = [
      { prefix: 'ex', uri: 'http://example.com/', namespace: 'http://example.com/', color: '#FF0000' },
      { prefix: 'ex-sub', uri: 'http://example.com/subnamespace/', namespace: 'http://example.com/subnamespace/', color: '#00FF00' },
    ];

    const color = getNodeColor(
      'http://example.com/subnamespace/Entity',
      undefined,
      { registry: registryWithNested },
    );

    expect(color).toBe('#00FF00'); // Should match the more specific namespace
  });

  it('should return undefined when namespace has no color', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', uri: 'http://example.com/', namespace: 'http://example.com/', color: undefined },
    ];

    const color = getNodeColor(
      'http://example.com/Entity',
      undefined,
      { registry: registryNoColor },
    );

    expect(color).toBeUndefined();
  });

  it('should use palette as fallback when registry has no color', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', uri: 'http://example.com/', namespace: 'http://example.com/', color: undefined },
    ];

    const palette = {
      ex: '#ABCDEF',
    };

    const color = getNodeColor(
      'http://example.com/Entity',
      palette,
      { registry: registryNoColor },
    );

    expect(color).toBe('#ABCDEF');
  });

  it('should return namespace color for entity IRI (no fat map fallback)', () => {
    // Fat map entity-specific color overrides are no longer supported.
    // Namespace registry color is used directly.
    const color = getNodeColor(
      'http://example.com/SpecialEntity',
      undefined,
      { registry: testRegistry },
    );

    expect(color).toBe('#FF0000'); // namespace color
  });

  it('should return undefined when namespace has no color and no fat map', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', uri: 'http://example.com/', namespace: 'http://example.com/', color: undefined },
    ];

    const color = getNodeColor(
      'http://example.com/SpecialEntity',
      undefined,
      { registry: registryNoColor },
    );

    expect(color).toBeUndefined();
  });

  it('should work for blank nodes (return undefined)', () => {
    const color = getNodeColor(
      '_:b123',
      undefined,
      { registry: testRegistry },
    );

    expect(color).toBeUndefined(); // Blank nodes have no namespace
  });
});
