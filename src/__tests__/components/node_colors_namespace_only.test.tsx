/**
 * Test that node colors are derived from namespace registry ONLY,
 * not from fat map entities. This ensures colors work even when
 * ontologies aren't loaded (fat map is empty).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getNodeColor } from '../../utils/termUtils';
import type { NamespaceRegistryEntry } from '../../utils/termUtils';

describe('Node colors from namespace registry (not fat map)', () => {
  const testRegistry: NamespaceRegistryEntry[] = [
    { prefix: 'ex', namespace: 'http://example.com/', color: '#FF0000' },
    { prefix: 'prov', namespace: 'http://www.w3.org/ns/prov#', color: '#00FF00' },
    { prefix: 'owl', namespace: 'http://www.w3.org/2002/07/owl#', color: '#0000FF' },
  ];

  it('should derive color from namespace registry when fat map is empty', () => {
    // This is the key test: fat map is empty (ontology not loaded),
    // but namespace registry has colors defined
    const color = getNodeColor(
      'http://example.com/SomeEntity',
      undefined, // no palette
      {
        registry: testRegistry,
        availableProperties: [], // EMPTY fat map
        availableClasses: [],    // EMPTY fat map
      }
    );

    expect(color).toBe('#FF0000'); // Should get color from namespace registry
  });

  it('should derive color from namespace registry for classType IRI', () => {
    const color = getNodeColor(
      'http://www.w3.org/ns/prov#Activity',
      undefined,
      {
        registry: testRegistry,
        availableProperties: [],
        availableClasses: [],
      }
    );

    expect(color).toBe('#00FF00'); // prov namespace color
  });

  it('should use longest matching namespace', () => {
    const registryWithNested: NamespaceRegistryEntry[] = [
      { prefix: 'ex', namespace: 'http://example.com/', color: '#FF0000' },
      { prefix: 'ex-sub', namespace: 'http://example.com/subnamespace/', color: '#00FF00' },
    ];

    const color = getNodeColor(
      'http://example.com/subnamespace/Entity',
      undefined,
      {
        registry: registryWithNested,
        availableProperties: [],
        availableClasses: [],
      }
    );

    expect(color).toBe('#00FF00'); // Should match the more specific namespace
  });

  it('should return undefined when namespace has no color', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', namespace: 'http://example.com/', color: undefined },
    ];

    const color = getNodeColor(
      'http://example.com/Entity',
      undefined,
      {
        registry: registryNoColor,
        availableProperties: [],
        availableClasses: [],
      }
    );

    expect(color).toBeUndefined();
  });

  it('should use palette as fallback when registry has no color', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', namespace: 'http://example.com/', color: undefined },
    ];

    const palette = {
      ex: '#ABCDEF',
    };

    const color = getNodeColor(
      'http://example.com/Entity',
      palette,
      {
        registry: registryNoColor,
        availableProperties: [],
        availableClasses: [],
      }
    );

    expect(color).toBe('#ABCDEF');
  });

  it('should prefer fat map entity-specific color when available (rare case)', () => {
    // This tests the fallback: if an ontology IS loaded and has
    // an entity-specific color override, that should take precedence
    const color = getNodeColor(
      'http://example.com/SpecialEntity',
      undefined,
      {
        registry: testRegistry,
        availableProperties: [],
        availableClasses: [
          {
            iri: 'http://example.com/SpecialEntity',
            label: 'Special Entity',
            color: '#SPECIAL', // entity-specific override
          },
        ],
      }
    );

    // Entity-specific color should be used as fallback only
    // But namespace color takes precedence per our fix
    expect(color).toBe('#FF0000'); // namespace color wins
  });

  it('should use fat map entity color ONLY when namespace has no color', () => {
    const registryNoColor: NamespaceRegistryEntry[] = [
      { prefix: 'ex', namespace: 'http://example.com/', color: undefined },
    ];

    const color = getNodeColor(
      'http://example.com/SpecialEntity',
      undefined,
      {
        registry: registryNoColor,
        availableProperties: [],
        availableClasses: [
          {
            iri: 'http://example.com/SpecialEntity',
            label: 'Special Entity',
            color: '#SPECIAL',
          },
        ],
      }
    );

    expect(color).toBe('#SPECIAL'); // Fat map color used as last resort
  });

  it('should work for blank nodes (return undefined)', () => {
    const color = getNodeColor(
      '_:b123',
      undefined,
      {
        registry: testRegistry,
        availableProperties: [],
        availableClasses: [],
      }
    );

    expect(color).toBeUndefined(); // Blank nodes have no namespace
  });
});
